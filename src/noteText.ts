// noteText.ts — 笔记文本手术的纯函数层（M3 SummaryService 的「原文零覆盖」保障）。
// 不依赖 obsidian，可在 Node 中独立单元验证（见 tests/）。
import type { SummaryRecord } from "./types";

// ---------- 笔记文本手术（M3 SummaryService 的「原文零覆盖」保障） ----------

// 块「所有权」判定（2026-09-27 第四轮收紧）：此前用 startsWith 前缀匹配，用户自建的
// `> [!abstract]- 摘要与心得` 这类 callout 会被前缀命中、在手动摘要/重建时整块替换——
// 违反「原文零覆盖」硬约束。插件产出的块头是固定格式，改为**整行全等**正则；
// 逐字稿头允许引擎括注尾巴（noteBuilder 写 `逐字稿（provider）`）。
const TRANSCRIPT_HEAD_RE = /^> \[!quote\]- 逐字稿(（[^）]*）)?$/;
const OCR_HEAD_RE = /^> \[!note\]- 图片文字$/;
const ABSTRACT_HEAD_RE = /^> \[!abstract\]- 摘要$/;

/**
 * 去 UTF-8 BOM（2026-09-27 第四轮）：外部编辑器/PowerShell 重写过的笔记常带 BOM，
 * 所有 `startsWith("---")` / `lines[0] === "---"` 判定会集体失配——摘要写入走「无 frontmatter」
 * 分支在文件头再插一块围栏，原 frontmatter 连同 douyin_id/cover/category 整体降级为正文，
 * Bases 视图全部过滤掉该笔记。统一在纯函数入口剥掉。
 */
function stripBom(markdown: string): string {
  return markdown.charCodeAt(0) === 0xfeff ? markdown.slice(1) : markdown;
}

/**
 * frontmatter 是否畸形（以 --- 开头但没有闭合围栏）。
 * 畸形时任何「插入/重写」都会让原围栏降级为正文（Properties 全丢），调用方应放弃写入。
 * 闭合围栏按 YAML 口径只认列 0 的 `---`（第九轮 A9）：trim() 判定会把多行块标量值里
 * 手改出来的缩进 `  ---` 误认成闭合，summary 等键被插进 YAML 中段、frontmatter 错乱。
 */
function isFenceClose(line: string): boolean {
  return /^---\s*$/.test(line);
}

function isUnclosedFrontmatter(markdown: string): boolean {
  if (!markdown.startsWith("---")) return false;
  const lines = markdown.split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    if (isFenceClose(lines[i])) return false;
  }
  return true;
}

/**
 * 从 startIdx 起定位一个折叠块的行范围 [start, end]（含首尾）。
 * 终止条件：非 `>` 行（空行 / --- / 正文），或**下一行是另一个 `[!…]` callout 头**。
 * 后者是 2026-09-27 修的关键边界：用户紧贴块尾写的另一个 callout（无空行分隔）
 * 会被旧的 while startsWith(">") 吞进块里，替换时连同用户内容一起删掉。
 */
function calloutRange(lines: string[], startIdx: number): number {
  let end = startIdx;
  while (
    end + 1 < lines.length &&
    lines[end + 1].startsWith(">") &&
    !/^\s*>\s*\[!/.test(lines[end + 1])
  ) {
    end++;
  }
  return end;
}

/** 折叠块头部 → 内容行集合（含首行，剥离 "> " 前缀）。块以「非 > 行」结束。head 为整行全等正则（所有权判定）。 */
function extractCallout(lines: string[], headRe: RegExp): string[] {
  const out: string[] = [];
  let collecting = false;
  for (const line of lines) {
    if (!collecting && headRe.test(line)) {
      collecting = true;
      // 头行全等匹配（所有权收紧）：块头永不携带正文——逐字稿头的引擎括注（whisper 等）
      // 原本作为 out[0] 被后面的「纯括注丢弃」逻辑剥掉，现在直接不进内容集
      out.push("");
      continue;
    }
    if (collecting) {
      // 紧邻的下一个 callout 头 = 本块结束（复审 P2）：只判「非 > 行」会把邻块的
      // 正文行照单收进 transcript，污染摘要模型输入源（头行有 filter 兜着，正文行没有）
      if (/^\s*>\s*\[!/.test(line)) break;
      if (line.startsWith(">")) {
        out.push(line.replace(/^>\s?/, "").trim());
      } else {
        break; // 折叠块结束（空行 / --- / 正文）
      }
    }
  }
  // 逐字稿头是 `> [!quote]- 逐字稿（引擎名）`：首行剩余部分是括注尾巴（如「（whisper）」），
  // 会被当成转录内容混进摘要模型的输入源 → 首行若是纯括注则丢弃
  if (out.length > 0 && /^（[^）]*）$/.test(out[0])) out.shift();
  return out.filter((s) => s.length > 0 && !s.startsWith("[!"));
}

/** 从笔记正文中抽取逐字稿与图片文字（摘要的输入源）。 */
export function extractSummarySources(markdownRaw: string): { transcript: string; ocrText: string } {
  const markdown = stripBom(markdownRaw);
  const lines = markdown.split(/\r?\n/);
  return {
    transcript: extractCallout(lines, TRANSCRIPT_HEAD_RE).join("\n"),
    ocrText: extractCallout(lines, OCR_HEAD_RE).join("\n"),
  };
}

/**
 * 在正文中插入或原位替换「摘要」折叠块，其余内容（含逐字稿 / 图片文字块）逐字保留。
 * 位置：frontmatter 之后、正文最前。已存在摘要块时仅替换该块。
 */
export function upsertAbstractBlock(markdownRaw: string, summary: string): string {
  const markdown = stripBom(markdownRaw);
  const lines = markdown.split(/\r?\n/);
  const block = [`> [!abstract]- 摘要`, ...summary.split(/\r?\n/).map(calloutLine)];

  // 找到既有摘要块范围（整行全等 = 所有权判定；calloutRange：不吞紧邻的下一个 callout）
  let start = -1;
  let end = -1;
  for (let i = 0; i < lines.length; i++) {
    if (ABSTRACT_HEAD_RE.test(lines[i])) {
      start = i;
      end = calloutRange(lines, i);
      break;
    }
  }
  if (start >= 0) {
    return [...lines.slice(0, start), ...block, ...lines.slice(end + 1)].join("\n");
  }

  // 定位插入点：frontmatter 结束行（第二个 ---）之后；无 frontmatter 则文件头
  let insertAt = 0;
  if (lines[0]?.trim() === "---") {
    for (let i = 1; i < lines.length; i++) {
      if (isFenceClose(lines[i])) {
        insertAt = i + 1;
        break;
      }
    }
    // 畸形 frontmatter（有开头无闭合）：在头部插入会让原围栏降级为正文（Properties 全丢），
    // 宁可不动（2026-09-27 第四轮）
    if (insertAt === 0) return markdown;
  }
  while (insertAt < lines.length && lines[insertAt].trim() === "") insertAt++;
  return [...lines.slice(0, insertAt), ...block, "", ...lines.slice(insertAt)].join("\n");
}

/**
 * callout 行渲染：正文行首 `>` 会打断折叠块，转成全角 `＞`（与 noteBuilder.callout 同一策略）。
 * 不转义的话「模型偶发输出引用行 → 写入 `> > x` → 提取剥一层剩 `> x` → 回填再写一层」，
 * 每轮重试引用层数都会增长。
 */
function calloutLine(s: string): string {
  // 行首 `[!` 一并全角化（2026-09-27 第四轮）：内容行 `[!note]` 写入后会成为折叠块内的嵌套
  // callout 头，读取侧（calloutRange/extractCallout）据此提前断块——旧摘要残留为游离块、
  // 逐字稿尾部从该处起在重建时永久丢失。带缩进的变体同样要转（第六轮）：读取侧断块判据
  // 是 `>\s*\[!`，`> ␣␣[!NOTE]`（OCR 截图里的缩进提示块）旧写法漏转，重建时照样被截断。
  return `> ${s.replace(/^>+\s*/, "＞ ").replace(/^(\s*)\[!/, "$1[！")}`;
}

/**
 * 原子摘要写入的纯函数部分：一次字符串变换内同时完成
 * ① frontmatter summary / summary_v 的 upsert；② 正文摘要折叠块的 upsert。
 * 配合 app.vault.process 使用（Obsidian 的原子读-改-写原语）——
 * 旧的「processFrontMatter 全量写 → 再 read → 再 modify」三遍全文件 IO，两次写之间
 * 用户或并发回填的改动会被陈旧快照整体覆盖；合并后此类竞态窗口消失。
 * frontmatter 值用 JSON.stringify 写双引号标量（转义集与 YAML 兼容，同 noteBuilder.yamlStr 取巧）。
 */
export function applySummaryToNote(markdownRaw: string, summary: string, summaryV?: number): string {
  const markdown = stripBom(markdownRaw);
  // 畸形 frontmatter（--- 无闭合）：任何写入都会让原围栏降级为正文，放弃并保持原样（宁可不动）
  if (isUnclosedFrontmatter(markdown)) return markdown;
  const fmEntries = (v: string, ver?: number): string[] => {
    const out = [`summary: ${JSON.stringify(v)}`];
    if (ver !== undefined && Number.isFinite(ver) && ver > 0) out.push(`summary_v: ${Math.floor(ver)}`);
    return out;
  };
  let withFm = markdown;
  if (markdown.startsWith("---")) {
    const lines = markdown.split(/\r?\n/);
    for (let i = 1; i < lines.length; i++) {
      if (isFenceClose(lines[i])) {
        const fmText = lines.slice(1, i).join("\n");
        // 未显式传入版本号（手动「生成摘要」通道）：保留既有 summary_v 只重写 summary——
        // 版本号被删会让补跑判定失效，每次补跑轮都重复出一次付费摘要（回归审查 #1）
        const ver =
          summaryV !== undefined
            ? summaryV
            : (() => {
                const m = fmText.match(/^summary_v:\s*(\d+)\s*$/m);
                return m ? Number(m[1]) : undefined;
              })();
        // keys 覆盖面必须与 fmEntries 的发射面一致（复审 P1）：手动摘要通道（summaryV 未传）
        // 解析出既有 summary_v 时 fmEntries 会再发射一行 summary_v——keys 若只删 summary，
        // 旧行保留 + 新行追加 = 每次手动摘要多一行重复 YAML 键，无上限增长
        const keys = ver !== undefined && Number.isFinite(ver) && ver > 0 ? ["summary", "summary_v"] : ["summary"];
        const kept = removeFmEntries(lines.slice(1, i), keys);
        withFm = ["---", ...kept, ...fmEntries(summary, ver), ...lines.slice(i)].join("\n");
        break;
      }
    }
  } else {
    // 无 frontmatter：新建一块（正文原样保留）
    withFm = ["---", ...fmEntries(summary, summaryV), "---", "", ...markdown.split(/\r?\n/)].join("\n");
  }
  // ② 正文摘要折叠块：插入或原位替换（与 frontmatter 同一次字符串变换内完成）
  return upsertAbstractBlock(withFm, summary);
}

/**
 * 截取 frontmatter 区间文本（含首尾围栏）；无 frontmatter 返回空串。
 * 供「引号无关」的键值正则统一先切片再匹配——直接对整篇 markdown 用 /m 正则，
 * 正文（逐字稿 / OCR 文本 / 用户粘贴的示例）里出现同名行会劫持分支。
 */
export function frontmatterBlock(markdownRaw: string): string {
  const markdown = stripBom(markdownRaw);
  if (!markdown.startsWith("---")) return "";
  const lines = markdown.split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    if (isFenceClose(lines[i])) return lines.slice(0, i + 1).join("\n");
  }
  return "";
}

/** 从 frontmatter 行集中删除指定 key 的完整条目（多行值：缩进续行 / 列表项 / 块标量跟随删除）。 */
function removeFmEntries(lines: string[], keys: string[]): string[] {  const keyRe = (k: string) => new RegExp(`^${k}\\s*:`);
  const nextKeyRe = /^[A-Za-z_][A-Za-z0-9_-]*\s*:/;
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    if (skipping) {
      if (!nextKeyRe.test(line)) continue; // 条目续行
      skipping = false;
    }
    if (keys.some((k) => keyRe(k).test(line))) {
      skipping = true;
      continue;
    }
    out.push(line);
  }
  return out;
}

/**
 * frontmatter 单标量键 upsert（导出，Node 可测）：键已存在则原位改值（多行旧值整体移除），
 * 不存在则追加到 frontmatter 末尾（闭合 `---` 前）。值经 JSON.stringify 写双引号标量
 * （转义集与 YAML 兼容，与 applySummaryToNote 同一取巧）。
 * 畸形 frontmatter（--- 无闭合）原样返回——任何写入都会让原围栏降级为正文（宁可不动）。
 * 供视频摘要写入 summary_style（2026-09-27 第八轮）：与 applySummaryToNote 组合在同一
 * vault.process 回调里执行，仍是单次原子写。
 */
export function upsertFmScalar(markdownRaw: string, key: string, value: string): string {
  const markdown = stripBom(markdownRaw);
  if (!markdown.startsWith("---") || isUnclosedFrontmatter(markdown)) return markdown;
  const lines = markdown.split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    if (!isFenceClose(lines[i])) continue;
    const kept = removeFmEntries(lines.slice(1, i), [key]);
    return ["---", ...kept, `${key}: ${JSON.stringify(value)}`, ...lines.slice(i)].join("\n");
  }
  return markdown;
}

/**
 * 摘要文本清理（纯函数，Node 可测）：剔除模型可能偶发生成的「【配图N】」标记。
 * 摘要不嵌照片——关键帧统一放在「关键帧」折叠块里，摘要保持纯文本结构化排版。
 */
export function stripFrameMarkers(summary: string): string {
  return summary
    .replace(/【配图\s*\d+】/g, "")
    .replace(/[ \t]+$/gm, "")
    .trim();
}

/** 把识别文字追加到「图片文字」折叠块（导出动作）；块不存在则新建。不触碰逐字稿。 */
export function appendOcrToNoteCallout(markdownRaw: string, text: string): string {
  const markdown = stripBom(markdownRaw);
  const lines = markdown.split(/\r?\n/);
  // 幂等比对归一化（2026-09-27 第四轮）：写入侧经 calloutLine 变换（行首 > → 全角 ＞），
  // 原文含行首 `>` 或 CRLF 的识别文本若按原始字节比对必然失配 → 每次导出都重复追加。
  // 两侧做同一归一化后再比对；`includes` 的整段子串判定保留（不同图整段被包含的情形罕见，
  // 而完全相同的重复导出必须拦截）。
  // 还原 ＞ 必须先于剥 `> `（第六轮修顺序）：正文含行首 `>` 时，body 剥首层后残留全角 ＞，
  // 先剥后还原会留下未剥离的 `> `——两侧归一化结果不同，幂等判据恒失配，重复追加无上限。
  const normOcr = (s: string) => s.replace(/＞/g, ">").replace(/^>\s?/gm, "").replace(/\r\n/g, "\n").trim();
  const textNorm = normOcr(text);
  for (let i = 0; i < lines.length; i++) {
    if (OCR_HEAD_RE.test(lines[i])) {
      const end = calloutRange(lines, i);
      const body = lines.slice(i, end + 1).map((l) => l.replace(/^>\s?/, "")).join("\n");
      // 幂等（2026-09-27 修）：同一份识别结果重复导出时直接跳过，块不再越积越大。
      // 判据是**整段完全相同**（回归审查 #8）：前 80 字相同不代表相同内容——
      // 多页扫描件/同组图片的 OCR 常以相同页眉开头，按前缀查重会静默丢掉第二张图的结果
      if (textNorm && normOcr(body).includes(textNorm)) return markdown;
      const added = text.split(/\r?\n/).map(calloutLine);
      return [...lines.slice(0, end + 1), ...added, ...lines.slice(end + 1)].join("\n");
    }
  }
  // 畸形 frontmatter：块插到头部会让原围栏降级为正文，放弃写入（宁可不动）
  if (isUnclosedFrontmatter(markdown)) return markdown;
  const block = [`> [!note]- 图片文字`, ...text.split(/\r?\n/).map(calloutLine)];
  let insertAt = 0;
  if (lines[0]?.trim() === "---") {
    for (let i = 1; i < lines.length; i++) {
      if (isFenceClose(lines[i])) {
        insertAt = i + 1;
        break;
      }
    }
    if (insertAt === 0) return markdown;
  }
  while (insertAt < lines.length && lines[insertAt].trim() === "") insertAt++;
  return [...lines.slice(0, insertAt), ...block, "", ...lines.slice(insertAt)].join("\n");
}

/**
 * 均匀抽样 n 个元素（保留首与末），用于把关键帧压进模型允许的图片数上限。
 * 各通道图片数上限差异极大（实测智谱 glm-4v-flash 仅 5 张），故需按上限自适应降档。
 */
export function pickEvenly<T>(arr: T[], n: number): T[] {
  if (n <= 0) return [];
  if (arr.length <= n) return [...arr];
  if (n === 1) return [arr[0]];
  const out: T[] = [];
  for (let i = 0; i < n; i++) {
    out.push(arr[Math.round((i * (arr.length - 1)) / (n - 1))]);
  }
  return out;
}

/** 由图片扩展名推导 MIME（魔数校验在调用方，这里只做扩展名白名单）。 */
export function imageMimeFromName(name: string): string | null {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  const map: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    gif: "image/gif",
  };
  return map[ext] ?? null;
}

/**
 * 记录摘要结果（保留最近 200 条，与 types.ts / 文档口径一致；复审 P2：迁入纯函数层时曾被静默砍到 50）。
 * 性能治理 P0-2：停止存摘要全文（正文已有同一份）。2026-09-27：按 notePath upsert——
 * 同一篇笔记先失败后成功时，台账里不再并存过期记录。
 */
export function pushSummaryRecord(list: SummaryRecord[] | undefined, rec: SummaryRecord): SummaryRecord[] {
  const next = (list ?? []).filter((r) => r.notePath !== rec.notePath);
  next.push(rec);
  return next.slice(-200);
}

/** 问题 6：重试路径从既有笔记回收的可复用资产（免二次下载 / 免重复 OCR / 免重复分类）。 */
export interface ReusedNoteAssets {
  coverPath: string;
  category: string;
  images: string[];
  visionTexts: { index: number; text: string; status: string }[];
  framePaths: string[];
  /** 既有帧的抽帧间隔（frontmatter frame_interval）：重建时原样回写，保持补跑 framesOk 判定自洽 */
  frameInterval: string;
  /** 既有摘要正文（摘要折叠块内容）；重建笔记后用于回填，避免「摘要重生成失败 = 摘要永久丢失」 */
  summaryText: string;
  /** 既有摘要格式版本（frontmatter summary_v） */
  summaryV: string;
  /** 既有逐字稿正文（第十轮 F1：撞库恢复路径复用，免重新下载计费 ASR）；解析口径与 extractSummarySources 一致 */
  transcript: string;
  /** 逐字稿引擎名（frontmatter transcript_provider） */
  transcriptProvider: string;
  /** 逐字稿状态（frontmatter transcript_status）：撞库复用只认 success */
  transcriptStatus: string;
}

/**
 * 从既有笔记回收可复用资产（问题 6：重试只需重跑 transcribe + writeNote，不再触发全套副作用）。
 * 解析口径与 noteBuilder 的产出格式一一对应：frontmatter cover/category（引号无关，兼容
 * processFrontMatter 重写后去引号）、行首 `![[...]]` 图片、`> ![[...]]` 关键帧、图片文字折叠块的
 * `**图 N**（status）` 逐图分段。任何一段解析失败都以空值返回，调用方回退到联网路径。
 */
export function collectExistingAssets(markdownRaw: string): ReusedNoteAssets {
  const markdown = stripBom(markdownRaw);
  const lines = markdown.split(/\r?\n/);
  const empty: ReusedNoteAssets = {
    coverPath: "",
    category: "",
    images: [],
    visionTexts: [],
    framePaths: [],
    frameInterval: "",
    summaryText: "",
    summaryV: "",
    transcript: "",
    transcriptProvider: "",
    transcriptStatus: "",
  };
  if (lines[0]?.trim() !== "---") return empty;
  let fmEnd = -1;
  for (let i = 1; i < lines.length; i++) {
    if (isFenceClose(lines[i])) {
      fmEnd = i;
      break;
    }
  }
  if (fmEnd < 0) return empty;
  const fmBlock = lines.slice(0, fmEnd).join("\n");
  const fmVal = (key: string): string => {
    const m = fmBlock.match(new RegExp(`^${key}:\\s*"?([^"\\n]*)"?:?\\s*$`, "m"));
    return m ? m[1].trim() : "";
  };

  // 单遍扫描（2026-09-27 修）：行首图片、折叠块内关键帧、OCR 逐图分段、既有摘要，
  // 原本各扫一遍全文（批量重试 1109 篇 × 数百 KB 时是纯浪费的重复 CPU）
  const images: string[] = [];
  const framePaths: string[] = [];
  const visionTexts: { index: number; text: string; status: string }[] = [];
  let summaryText = "";
  let cur: { index: number; text: string; status: string } | null = null;
  let section: 0 | 1 | 2 = 0; // 0=正文 1=OCR 块 2=摘要块
  let blockEnd = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const im = l.match(/^!\[\[([^\]]+)\]\]/);
    if (im) images.push(im[1]);
    const fr = l.match(/^> !\[\[([^\]]+)\]\]/);
    if (fr) framePaths.push(fr[1]);

    if (section !== 0) {
      if (i <= blockEnd) {
        const body = l.replace(/^>\s?/, "");
        if (section === 1) {
          const m = body.match(/^\*\*图 (\d+)\*\*（(.+?)）$/);
          if (m) {
            if (cur) visionTexts.push(cur);
            cur = { index: Number(m[1]), text: "", status: m[2] };
          } else if (cur && body.trim() && !body.startsWith("[!")) {
            cur.text += (cur.text ? "\n" : "") + body;
          }
        } else {
          summaryText += (summaryText ? "\n" : "") + body;
        }
        continue;
      }
      // 块结束：先把悬置的当前图 OCR 段落账（复审 P2）——双子块布局下不 flush 的话，
      // 第二个图片文字块头的 cur = null 会把上一块最后一张图的文字静默丢掉
      if (cur) {
        visionTexts.push(cur);
        cur = null;
      }
      section = 0;
      blockEnd = -1;
    }
    if (OCR_HEAD_RE.test(l)) {
      section = 1;
      blockEnd = calloutRange(lines, i);
      cur = null;
    } else if (ABSTRACT_HEAD_RE.test(l)) {
      section = 2;
      blockEnd = calloutRange(lines, i);
    }
  }
  if (cur) visionTexts.push(cur);
  summaryText = summaryText.trim();

  return {
    coverPath: fmVal("cover"),
    category: fmVal("category"),
    images,
    visionTexts,
    framePaths,
    frameInterval: fmVal("frame_interval"),
    summaryText,
    summaryV: fmVal("summary_v"),
    // 第十轮 F1：逐字稿回收（撞库恢复免重复计费）。解析口径与 extractSummarySources 完全一致，
    // 直接复用它（多一次 O(n) 行扫描；collectExistingAssets 仅在撞库/重试路径触发，可接受）
    transcript: extractSummarySources(markdownRaw).transcript,
    transcriptProvider: fmVal("transcript_provider"),
    transcriptStatus: fmVal("transcript_status"),
  };
}
