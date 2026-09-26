// videoSummaryService.ts — 视频类收藏的多模态综合总结（2026-09 分类优化需求）。
// 转录文字 + 关键帧图片一并传给百炼视觉模型（OpenAI 兼容 compatible-mode），
// 生成结构化中文笔记摘要（简介 + emoji 分节 + 加粗划重点 + 小总结）。
// 摘要为纯文本、不嵌照片——关键帧统一放笔记的「关键帧」折叠块。
// 写入零覆盖约束与 summaryService 相同：只动 frontmatter summary / summary_v 与摘要折叠块。
import { App, TFile, TFolder, Vault, normalizePath } from "obsidian";
import type { DouyinSyncSettings, SummaryRecord } from "./types";
import { AiClient } from "./ai";
import { stripFrameMarkers, upsertAbstractBlock, pickEvenly } from "./statusCore";

/**
 * 转录文本截断长度。
 * 性能实测（2026-09-19）：视频摘要 p50 155.1s，是单条最大的耗时项。
 * 输入侧 8000 字转录 ≈ 1.2 万 token，而画面信息主要由关键帧承载、转录只是口播补充，
 * 截到 4000 字可减少输入 token，对摘要质量的边际影响很小。
 */
const MAX_TRANSCRIPT_CHARS = 4000;
const SUMMARY_V = 3; // 摘要格式版本：v3 = 层级笔记体（主题标题/引言/内容分节/总结与意义/AI 总结，无照片）；补跑据此重出旧格式摘要

/**
 * 图片数档位（由多到少）；帧数超过通道上限时逐档降级重试。
 * 性能治理 P1：首档由 20 降到 8 —— 单帧 720p JPEG 的 base64 约 80~200KB，
 * 20 帧即 1.6~4MB 请求体（还要 JSON.stringify 再复制一遍），是单条摘要耗时的主要来源。
 * 8 帧仍按时间均匀覆盖全片，画面信息损失有限，而请求体与生成时间同步下降约 60%。
 */
const FRAME_STEPS = [8, 5, 2, 1];

/** 各模型已验证可用的图片数档位记忆（按模型名隔离），避免每条视频都从头试错浪费请求 */
const frameStepMemo = new Map<string, number>();

/**
 * 列出某视频已抽取的关键帧（vault 相对路径，文件名升序 = 视频时间顺序）。
 * 问题 9：不再全 vault 扫描（O(n)），改为对已知帧目录的 TFolder 直读（O(该目录文件数)）。
 */
export function listVideoFramePaths(vault: Vault, mediaFolder: string, douyinId: string): string[] {
  const folderPath = normalizePath(`${mediaFolder}/frames/${douyinId}`);
  const dir = vault.getAbstractFileByPath(folderPath);
  if (!(dir instanceof TFolder)) return [];
  return dir.children
    .filter((c): c is TFile => c instanceof TFile && /\.(jpe?g|png|webp)$/i.test(c.path))
    .map((f) => f.path)
    .sort();
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

function buildPrompt(input: { title: string; desc?: string; transcript: string; frameCount: number; intervalSec: number }): string {
  const frameDesc = input.frameCount > 0
    ? `（共 ${input.frameCount} 张，从视频全片每隔约 ${input.intervalSec} 秒均匀抽取、按时间顺序排列——分别对应视频的开头、中段与结尾）`
    : "（本次未提供）";
  const parts: string[] = [
    "你是笔记摘要助手。下面是同一个抖音视频的语音转录文字（ASR 自动生成，可能有同音错字），以及按视频时间顺序抽取的关键帧截图" + frameDesc + "。" +
      "转录是口播内容，关键帧是画面信息，两者互补。请综合输出一份层级分明的中文笔记，格式要求：",
    "1. 第一行为主题标题：用「主题:副题」格式（10~24 字，概括内容本身，不要照抄视频标题）；",
    "2. 接着「## 引言」节：1~3 句概述视频的背景与脉络，并以「核心问题：」一句点明视频要回答或验证的问题；",
    "3. 主体按内容逻辑分节（「## 节标题」，节标题用简洁中文短语概括该部分内容），节内可用「### 子标题」与「- 」列表组织层级；完整保留所有数据、数字、公式、工具与专有名词，宁详勿略；",
    "4. 「## 总结与意义」节：收拢结论（结论 / 方法 / 价值与延伸），保留作者留下的开放问题；",
    "5. 最后一节「## AI 总结」：用 3~6 句话整体概括这支视频讲了什么、怎么做的、有什么价值；",
    "6. 直接输出笔记本身，不要开场白与免责声明。",
    // —— 方法论（固化自实战摘要写法）——
    "画面信息挖掘：逐帧仔细查看并交叉比对，凡是画面里出现而转录未提及的信息——信息图、数据板、图表曲线、代码与界面截图、字幕卡、价格表、流程图、书名与人名——都必须写进对应章节；这些往往是视频最有价值的部分。",
    "转录校正：ASR 同音错字按上下文校正为规范写法（例：「道士理论」→道氏理论、「及时食物」→即食、「慕强」被误写等），无法确认的保留原词并用括注说明；人名、书名、平台名优先以画面字幕为准。",
    "诚实原则：信息不足或无法确认时如实注明「信息有限」，绝不虚构细节；研究类内容必须保留样本量、适用人群、边界条件等限制说明；广告与软广成分客观标注。",
    "时间脉络：关键帧按时间顺序对应视频的开头、中段与结尾，按推进脉络组织章节，不要逐张描述图片。",
  ];
  parts.push("", `视频标题：${input.title}`);
  if (input.desc && input.desc !== input.title) parts.push(`视频文案：${input.desc.slice(0, 500)}`);
  parts.push(
    "",
    input.transcript.trim()
      ? `语音转录文字：\n${input.transcript.slice(0, MAX_TRANSCRIPT_CHARS)}`
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
 * 生成并写入视频多模态摘要：frontmatter summary（结构化纯文本）+ 摘要折叠块（同一内容）。
 * 摘要不嵌照片；同时写 summary_v 标记格式版本。供同步流水线与手动命令共用。
 */
export async function generateAndWriteVideoSummary(
  app: App,
  file: TFile,
  s: DouyinSyncSettings,
  input: { title: string; desc?: string; transcript: string; framePaths: string[] },
): Promise<VideoSummaryResult> {
  const model = s.videoSummaryModel || "qwen3-vl-plus";
  // 多模态总结专用通道：videoSummaryBaseUrl/ApiKey 留空时复用通用 AI 通道（aiBaseUrl/aiKey/dashscopeKey）
  const key = (s.videoSummaryApiKey || s.aiKey || s.dashscopeKey).trim();
  const baseUrl = (s.videoSummaryBaseUrl || s.aiBaseUrl).trim();
  if (!key) return { ok: false, msg: "未配置 AI Key（设置页 → AI）", model };
  if (!input.transcript.trim() && input.framePaths.length === 0) {
    return { ok: false, msg: "无转录文字也无关键帧", model };
  }

  const client = new AiClient(baseUrl, key, s.aiModel, model);
  const baseIntervalSec = Math.max(1, Math.min(60, s.keyframeIntervalSec || 10));

  // 图片数上限自适应降档：各通道上限差异极大（实测智谱 glm-4v-flash 仅 5 张），
  // 帧数超过上限时按「均匀抽样」降档重试，避免整批摘要因图片数超限而全灭。
  const memoStep = frameStepMemo.get(model);
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
    const prompt = buildPrompt({
      title: input.title,
      desc: input.desc,
      transcript: input.transcript,
      frameCount: images.length,
      intervalSec: effectiveSec,
    });
    try {
      raw = await client.chatVision(prompt, images, model, Math.max(500, s.summaryMaxTokens));
      failMsg = "";
      framesUsed = images.length; // 埋点：记录本轮真正送出去的帧数（可反推是否降档）
      frameStepMemo.set(model, n); // 记住本模型可用档位，后续视频直接从这里起步
      break;
    } catch (e: any) {
      failMsg = String(e?.message ?? e);
      // 仅「图片数量超限」才降档；其他错误（限流/超时已由 AiClient 退避处理）直接放弃本轮
      const overLimit = /图片数量|input[\s_-]?image|image.{0,24}(count|number|limit|exceed)/i.test(failMsg);
      if (!overLimit || input.framePaths.length <= n) break;
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

  await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
    fm.summary = summary;
    fm.summary_v = SUMMARY_V;
  });
  const after = await app.vault.read(file);
  await app.vault.modify(file, upsertAbstractBlock(after, summary));

  const record: SummaryRecord = {
    notePath: file.path,
    sourceChars: input.transcript.length + input.framePaths.length,
    model,
    status: "success",
    generatedAt: new Date().toISOString(),
    kind: "video_multimodal",
    framesUsed,
  };
  return { ok: true, msg: "视频摘要已生成", model, record };
}
