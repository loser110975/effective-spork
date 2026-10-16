// videoSummaryService.ts — 视频类收藏的多模态综合总结（2026-09 分类优化需求）。
// 转录文字 + 关键帧图片一并传给百炼视觉模型（OpenAI 兼容 compatible-mode），
// 生成结构化中文笔记摘要（简介 + emoji 分节 + 加粗划重点 + 小总结）。
// 摘要为纯文本、不嵌照片——关键帧统一放笔记的「关键帧」折叠块。
// 写入零覆盖约束与 summaryService 相同：只动 frontmatter summary / summary_v 与摘要折叠块。
import { App, TFile, TFolder, Vault, normalizePath } from "obsidian";
import type { DouyinSyncSettings } from "./types/settings";
import type { SummaryRecord } from "./types/state";
import type { SummaryStyle } from "./types/settings";
import { AiClient, OUTPUT_TRUNCATED_HINT } from "./ai";
import { resolveVideoSummaryChannel } from "./aiConfig";
import { stripFrameMarkers, applySummaryToNote, upsertFmScalar, pickEvenly } from "./statusCore";
import { headTailSlice, sliceByCodePoints, SOURCE_TRUNCATION_NOTICE } from "./util";

/**
 * 转录文本首尾保留切分（第十四轮）：总量维持 4000 的性能口径（实测 2026-09-19：视频摘要
 * p50 155.1s，是单条最大耗时项；输入侧 8000 字转录 ≈ 1.2 万 token，画面信息主要由关键帧
 * 承载、转录只是口播补充，4000 字对摘要质量的边际影响很小），但由头部截断改为
 * 「首 3000 + 尾 1000」。历史教训：头部截断把长视频结尾（结论 / recap）——最有价值的
 * 要点候选——静默丢掉，「总结与意义」节只能凭前文脑补；截断事实另由 SOURCE_TRUNCATION_NOTICE
 * 明示进提示词（buildPrompt 的 transcriptTruncated 参数）。
 */
const TRANSCRIPT_HEAD_CHARS = 3000;
const TRANSCRIPT_TAIL_CHARS = 1000;
export const SUMMARY_V = 4; // 摘要格式版本：v4 = 批次二摘要质量改造（一行式短摘要哨兵 + 单总结层 + ≤600 字 + 禁时间线复述；层级体骨架保留）。存量保护：格式健康判定不看精确版本（summary_v >= 3 即健康），v3 存量不因升版被自动重出（2026-10-16 拍板）

/**
 * 各风格的格式规范段（2026-09-27 第八轮；批次二 v4 改造 2026-10-16）。
 * v4 改动（四点硬要求，最小必要——三风格的结构骨架全部保留）：
 * ① 主题标题不再是「第一行」（第一行固定让给「一行式：」短摘要哨兵，见 buildPrompt 输出格式段）；
 * ② hierarchy 的「总结与意义 + AI 总结」双层同义收尾合并为唯一的「总结与意义」（禁叠层）；
 * ③ 禁复述 / 控长度 / 一行式哨兵三条对全风格生效，统一放 buildPrompt 的输出格式与方法论段。
 * 风格只替换「格式要求」段，画面挖掘 / 转录校正 / 诚实原则 / 时间脉络等方法论对全风格生效。
 */
const STYLE_SPECS: Record<SummaryStyle, string[]> = {
  hierarchy: [
    "1. 「一行式：…」行之后的首个内容行为主题标题：用「主题:副题」格式（10~24 字，概括内容本身，不要照抄视频标题）；",
    "2. 接着「## 引言」节：1~3 句概述视频的背景与脉络，并以「核心问题：」一句点明视频要回答或验证的问题；",
    "3. 主体按内容逻辑分节（「## 节标题」，节标题用简洁中文短语概括该部分内容），节内可用「### 子标题」与「- 」列表组织层级；完整保留所有数据、数字、公式、工具与专有名词，宁详勿略；",
    "4. 最后一节「## 总结与意义」：全文唯一的总结层（禁止再写「AI 总结」等同义收尾节），收拢结论（结论 / 方法 / 价值与延伸），保留作者留下的开放问题；",
    "5. 直接输出笔记本身，不要开场白与免责声明。",
  ],
  outline: [
    "1. 「一行式：…」行之后的首个内容行为主题标题：用「主题:副题」格式（10~24 字，概括内容本身，不要照抄视频标题）；",
    "2. 接着「## 核心观点」节：3~5 句话概括这支视频最重要的主张或结论；",
    "3. 「## 要点」节：列 6~12 条「- 」要点，每条一句话，完整保留关键数据、数字、公式、工具与专有名词；",
    "4. 「## 值得记住」节：不超过 3 条——金句、结论或可执行的行动项；",
    "5. 直接输出笔记本身，不要开场白与免责声明。",
  ],
  qa: [
    "1. 「一行式：…」行之后的首个内容行为主题标题：用「主题:副题」格式（10~24 字，概括内容本身，不要照抄视频标题）；",
    "2. 主体为 5~10 组问答：问题用「**Q: …**」，答案紧跟一行「A: …」，问题覆盖视频主线与关键细节，答案完整保留数据、数字、公式与专有名词；",
    "3. 最后一节「## 一句话总结」：一句话说清这支视频讲了什么、有什么价值；",
    "4. 直接输出笔记本身，不要开场白与免责声明。",
  ],
};

/**
 * 图片数档位（由多到少）；帧数超过通道上限时逐档降级重试。
 * 性能治理 P1：首档由 20 降到 8 —— 单帧 720p JPEG 的 base64 约 80~200KB，
 * 20 帧即 1.6~4MB 请求体（还要 JSON.stringify 再复制一遍），是单条摘要耗时的主要来源。
 * 2026-10-16 拍板再降到 3（[8,5,2,1] → [3,2,1]）：帧照抽照存（笔记浏览素材不变），
 * 仅摘要视觉调用减量——口播为主的库里 8 帧对摘要增益有限，3 帧足够保住字卡/演示类
 * 锚点信息，砍掉大半视觉 token 与请求体。旧 memo 记录的 8/5 档不在新表中，
 * indexOf 返回 -1 经 Math.max(0,…) 回退首档，自愈无需迁移。
 */
const FRAME_STEPS = [3, 2, 1];

/** 各模型已验证可用的图片数档位记忆（按「基址::模型」隔离），避免每条视频都从头试错浪费请求 */
const frameStepMemo = new Map<string, number>();

/**
 * 降档步进判定（第九轮 B1 修，纯函数可测）：仅当「下一档真的能减少送出的图数」才继续降档。
 * 原实现用 `input.framePaths.length <= n` 判 break——短视频总帧数 ≤ 首档时（6 帧视频 ×
 * glm-4v-flash 上限 5 张），第一步就命中 break，5/2/1 档永远走不到，摘要永久失败。
 */
export function shouldDropToNextStep(framePathsLength: number, currentN: number, nextN: number | undefined): boolean {
  if (nextN === undefined) return false;
  return Math.min(nextN, framePathsLength) < Math.min(currentN, framePathsLength);
}

/**
 * 帧路径按帧序号数值排序（第六轮，纯函数可测）：frame_%02d.jpg 达 100 帧时 frame_100.jpg
 * 字典序落在 frame_10 与 frame_11 之间——末帧被当成第 11 帧送进模型，「按时间顺序排列」
 * 的提示词声明失真；与 videoMedia 同类修复共用同一口径。
 */
export function sortFramePaths(paths: string[]): string[] {
  return [...paths].sort((a, b) => {
    const na = Number((a.match(/frame_(\d+)/i) ?? [])[1]);
    const nb = Number((b.match(/frame_(\d+)/i) ?? [])[1]);
    if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

/**
 * 列出某视频已抽取的关键帧（vault 相对路径，文件名升序 = 视频时间顺序）。
 * 问题 9：不再全 vault 扫描（O(n)），改为对已知帧目录的 TFolder 直读（O(该目录文件数)）。
 */
export function listVideoFramePaths(vault: Vault, mediaFolder: string, douyinId: string): string[] {
  const folderPath = normalizePath(`${mediaFolder}/frames/${douyinId}`);
  const dir = vault.getAbstractFileByPath(folderPath);
  if (!(dir instanceof TFolder)) return [];
  return sortFramePaths(
    dir.children
      .filter((c): c is TFile => c instanceof TFile && /\.(jpe?g|png|webp)$/i.test(c.path))
      .map((f) => f.path),
  );
}

function mimeOf(p: string): string {
  const ext = p.toLowerCase().split(".").pop() ?? "";
  return ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
}

/**
 * 关键帧 → base64 data URL；读取失败的帧剔除；累计 base64 字节超过 maxBytes（即触发
 * 百炼「请求体解码后 ≤16MiB，超出 HTTP 413」红线前）即停止，帧数上限 max 同步生效。
 */
async function framesToDataUrls(
  vault: Vault,
  paths: string[],
  max: number,
  maxBytes = 14 * 1024 * 1024, // base64 累计 ≈ 解码后 10.5MiB，留足余量
): Promise<string[]> {
  const out: string[] = [];
  let total = 0;
  for (const p of paths.slice(0, max)) {
    try {
      const buf = await vault.adapter.readBinary(normalizePath(p));
      const b64 = Buffer.from(buf).toString("base64");
      if (total + b64.length > maxBytes) break;
      total += b64.length;
      out.push(`data:${mimeOf(p)};base64,${b64}`);
    } catch {
      /* 单帧读取失败跳过 */
    }
  }
  return out;
}

/** 提示词组装（导出供测试断言风格分支）。transcript 由调用方先用 headTailSlice 切好。 */
export function buildPrompt(input: {
  title: string;
  desc?: string;
  transcript: string;
  frameCount: number;
  intervalSec: number;
  style: SummaryStyle;
  /** 转录是否被首尾保留式截断（第十四轮）：仅截断时在提示词里明示中段缺失，模型不编造中段 */
  transcriptTruncated?: boolean;
}): string {
  const frameDesc = input.frameCount > 0
    ? `（共 ${input.frameCount} 张，从视频全片每隔约 ${input.intervalSec} 秒均匀抽取、按时间顺序排列——分别对应视频的开头、中段与结尾）`
    : "（本次未提供）";
  const parts: string[] = [
    "你是笔记摘要助手。下面是同一个抖音视频的语音转录文字（ASR 自动生成，可能有同音错字），以及按视频时间顺序抽取的关键帧截图" + frameDesc + "。" +
      "转录是口播内容，关键帧是画面信息，两者互补。请综合输出一份层级分明的中文笔记，格式要求：",
    // —— 格式规范（按风格预设切换；v4 起三风格共用下方的输出格式硬要求段）——
    ...(STYLE_SPECS[input.style] ?? STYLE_SPECS.hierarchy),
    // —— 输出格式硬要求（批次二 v4，2026-10-16 拍板；对全风格生效）——
    "输出格式：全文第一行固定为「一行式：<60 字以内的单行结论>」，其后空一行，再接正文摘要；",
    "禁叠层：全文只允许一个总结层，禁止「总结与意义 + AI 总结」这类两段同义收尾；",
    "禁复述：提炼可复用的结论、方法与数据，丢掉寒暄、过渡句与口播重复，禁止按视频时间线逐段改写转录内容；",
    "控长度：正文摘要全文不超过 600 字，超长时优先砍复述性内容，数据与结论优先保留。",
    // —— 方法论（固化自实战摘要写法）——
    "画面信息挖掘：逐帧仔细查看并交叉比对，凡是画面里出现而转录未提及的信息——信息图、数据板、图表曲线、代码与界面截图、字幕卡、价格表、流程图、书名与人名——都必须写进对应章节；这些往往是视频最有价值的部分。",
    "转录校正：ASR 同音错字按上下文校正为规范写法（例：「道士理论」→道氏理论、「及时食物」→即食、「慕强」被误写等），无法确认的保留原词并用括注说明；人名、书名、平台名优先以画面字幕为准。",
    "诚实原则：信息不足或无法确认时如实注明「信息有限」，绝不虚构细节；研究类内容必须保留样本量、适用人群、边界条件等限制说明；广告与软广成分客观标注。",
    "时间脉络：关键帧按时间顺序对应视频的开头、中段与结尾，按推进脉络组织章节，不要逐张描述图片。",
  ];
  parts.push("", `视频标题：${input.title}`);
  if (input.desc && input.desc !== input.title) parts.push(`视频文案：${sliceByCodePoints(input.desc, 500)}`);
  parts.push(
    "",
    input.transcript.trim()
      ? // 转录已由调用方按「首 3000 + 尾 1000」切好（第十四轮）；这里不再二次截断——
        // 中段省略标记若被截掉，明示句就成了谎言
        `语音转录文字：\n${input.transcript}` +
          (input.transcriptTruncated ? `\n${SOURCE_TRUNCATION_NOTICE}` : "")
      : "语音转录文字：（空或无效——完全依据画面字幕卡与视频文案重建内容，把画面里能读到的信息充分写入摘要，绝不虚构）",
  );
  return parts.join("\n");
}

export interface VideoSummaryResult {
  ok: boolean;
  msg: string;
  model: string;
  record?: SummaryRecord;
}

/**
 * 生成并写入视频多模态摘要（批次二 v4 分层：frontmatter summary 存一行短摘要、
 * 摘要折叠块存全文摘要——分层拆分在 applySummaryToNote 内完成，本函数只透传模型原文）。
 * 摘要不嵌照片；同时写 summary_v 标记格式版本。供同步流水线与手动命令共用。
 */
export async function generateAndWriteVideoSummary(
  app: App,
  file: TFile,
  s: DouyinSyncSettings,
  input: { title: string; desc?: string; transcript: string; framePaths: string[] },
): Promise<VideoSummaryResult> {
  const model = s.videoSummaryModel || "qwen3-vl-plus-2025-12-19";
  // 风格预设：历史 data.json 可能存有不在预设集里的值，回退 hierarchy
  const style: SummaryStyle = STYLE_SPECS[s.videoSummaryStyle] ? s.videoSummaryStyle : "hierarchy";
  // 统一接入：专用通道只认自己的 Base URL / Key（2026-10-15 通道独立化，不再复用通用 AI 通道）
  const chan = resolveVideoSummaryChannel(s);
  if (chan.problem) return { ok: false, msg: chan.problem, model };
  if (!input.transcript.trim() && input.framePaths.length === 0) {
    return { ok: false, msg: "无转录文字也无关键帧", model };
  }

  const client = new AiClient(chan.baseUrl, chan.apiKey, s.aiModel, model);
  // 摘要是全链路最慢的单次调用（本文件上方注释：历史 p50 155.1s；长转录+结构化长输出的 p95 更高），
  // 默认 120s 会把本可成功的请求掐死且超时无重试 → 显式放宽到 5 分钟（2026-09-27 修）。
  client.setTimeoutMs(300_000);
  const baseIntervalSec = Math.max(1, Math.min(60, s.keyframeIntervalSec || 10));

  // 图片数上限自适应降档：各通道上限差异极大（实测智谱 glm-4v-flash 仅 5 张），
  // 帧数超过上限时按「均匀抽样」降档重试，避免整批摘要因图片数超限而全灭。
  // memo key 带 baseUrl（2026-09-27 修）：同模型名跨通道（智谱↔百炼）上限不同，换通道后旧记忆会误导降档起点
  const memoKey = `${chan.baseUrl}::${model}`;
  const memoStep = frameStepMemo.get(memoKey);
  const startIdx = memoStep ? Math.max(0, FRAME_STEPS.indexOf(memoStep)) : 0;
  let images: string[] = [];
  let raw = "";
  let failMsg = "";
  let framesUsed = 0;
  for (let si = startIdx; si < FRAME_STEPS.length; si++) {
    const n = FRAME_STEPS[si];
    const paths = pickEvenly(input.framePaths, n);
    images = await framesToDataUrls(app.vault, paths, n);
    // 抽样后实际间隔变大，如实写进提示词，避免模型误判时间密度
    const effectiveSec = images.length > 0 && input.framePaths.length > images.length
      ? Math.max(baseIntervalSec, Math.round((baseIntervalSec * input.framePaths.length) / images.length))
      : baseIntervalSec;
    // 第十四轮：转录首尾保留（首 3000 + 尾 1000），截断事实同步进提示词——
    // 头部截断会把长视频结尾（结论/recap）静默丢掉，模型还把截断结果当完整原文
    const slicedTranscript = headTailSlice(input.transcript, TRANSCRIPT_HEAD_CHARS, TRANSCRIPT_TAIL_CHARS);
    const prompt = buildPrompt({
      title: input.title,
      desc: input.desc,
      transcript: slicedTranscript.text,
      transcriptTruncated: slicedTranscript.truncated,
      frameCount: images.length,
      intervalSec: effectiveSec,
      style,
    });
    try {
      // 手改 data.json 的非数字 summaryMaxTokens 会算出 NaN → JSON.stringify 序列化成 null
      // 送服务端（第九轮 B10）：设置页只在 UI onChange 消毒，消费端按有限数值兜底。
      // 非数字回退 500→2000（第十四轮）：500 是已迁移掉的旧默认，兜底值应与新默认同口径
      const maxTokens = Number.isFinite(s.summaryMaxTokens) ? Math.max(500, Math.floor(s.summaryMaxTokens)) : 2000;
      raw = await client.chatVision(prompt, images, model, maxTokens);
      failMsg = "";
      framesUsed = images.length; // 埋点：记录本轮真正送出去的帧数（可反推是否降档）
      frameStepMemo.set(memoKey, n); // 记住本通道+模型可用档位，后续视频直接从这里起步
      break;
    } catch (e: any) {
      failMsg = String(e?.message ?? e);
      // 仅「图片数量超限」才降档；其他错误（限流/超时已由 AiClient 退避处理）直接放弃本轮。
      // 降档条件看「下一档能否真的减图」（第九轮 B1）：短视频 6 帧 × 上限 5 的模型在首档 8 就
      // 会超限，按旧判定 `帧数 <= 当前档` 直接 break，低档位永远走不到
      const overLimit = /图片数量|input[\s_-]?image|image.{0,24}(count|number|limit|exceed)/i.test(failMsg);
      if (!overLimit || !shouldDropToNextStep(input.framePaths.length, n, FRAME_STEPS[si + 1])) break;
    }
  }

  if (failMsg) {
    const rec: SummaryRecord = {
      notePath: file.path,
      sourceChars: input.transcript.length + input.framePaths.length,
      model,
      status: "failed",
      errorCode: "301002",
      errorMessage: `多模态总结失败：${failMsg.slice(0, 300)}`,
      generatedAt: new Date().toISOString(),
      kind: "video_multimodal",
    };
    return { ok: false, msg: `多模态总结失败：${failMsg.slice(0, 120)}`, model, record: rec };
  }

  const summary = stripFrameMarkers(raw);
  if (!summary) return { ok: false, msg: "模型返回为空", model };

  // 单次 vault.process 原子写（2026-09-27 修）：原「processFrontMatter 全量写 → 再 read → 再 modify」
  // 三遍全文件 IO，两次写之间用户或并发回填的改动会被陈旧快照整体覆盖。
  // 第八轮：同一变换内追加 frontmatter summary_style（风格预设标记；补跑判定仍只看 summary_v，
  // 切风格不触发旧笔记批量重出——「补跑旧视频笔记」按当前风格重出）。
  await app.vault.process(file, (data) =>
    upsertFmScalar(applySummaryToNote(data, summary, SUMMARY_V), "summary_style", style),
  );

  // 第十四轮：输出截断读取——扩预算后仍 length 收尾（或钳制通道截断）时摘要是半成品，
  // 但已有内容仍有效：status 保持 success、不触发失败重试链，errorMessage 记录事实、
  // msg 并入截断信息提醒用户补跑（历史：截断结果落盘且 summary_v 已写，用户毫无感知）
  const outputTruncated = client.lastResponseTruncated;
  const record: SummaryRecord = {
    notePath: file.path,
    sourceChars: input.transcript.length + input.framePaths.length,
    model,
    status: "success",
    generatedAt: new Date().toISOString(),
    kind: "video_multimodal",
    framesUsed,
    ...(outputTruncated ? { errorMessage: OUTPUT_TRUNCATED_HINT } : {}),
  };
  return {
    ok: true,
    msg: outputTruncated ? `视频摘要已生成（${OUTPUT_TRUNCATED_HINT}）` : "视频摘要已生成",
    model,
    record,
  };
}
