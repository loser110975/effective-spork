// statusCore.ts — 二维状态机与笔记文本处理的纯函数层。
// 不依赖 obsidian，可在 Node 中独立单元验证（见 .workbuddy/tests/）。

// ---------- 二维状态（M4 StatusHub 的核心新增设计） ----------

export type ProcessState =
  | "stopped" // 已停止
  | "starting" // 启动中
  | "running" // 运行中
  | "stopping" // 停止中
  | "failed"; // 失败

export type ConnectionState =
  | "unknown" // 未知
  | "ok" // 连接正常
  | "unreachable" // 连接不可达
  | "unauthorized"; // 连接未授权（登录态失效）

export interface StatusVisual {
  /** 颜色（CSS 变量优先，回退到字面量以便测试断言） */
  color: string;
  label: string;
  icon: string;
  /** 用户处置建议（UserStory §5.4.3） */
  advice: string;
}

const VISUAL: Record<string, Omit<StatusVisual, "advice">> = {
  "running|ok": { color: "#4caf50", label: "运行中 · 连接正常", icon: "●" },
  "running|unauthorized": { color: "#e6a23c", label: "运行中 · 连接未授权", icon: "▲" },
  "running|unreachable": { color: "#e6a23c", label: "运行中 · 连接不可达", icon: "▲" },
  "running|unknown": { color: "#e6a23c", label: "运行中 · 连接未知", icon: "▲" },
  "starting|ok": { color: "#4c8dff", label: "启动中…", icon: "↻" },
  "starting|unknown": { color: "#4c8dff", label: "启动中…", icon: "↻" },
  "starting|unreachable": { color: "#4c8dff", label: "启动中…", icon: "↻" },
  "starting|unauthorized": { color: "#4c8dff", label: "启动中…", icon: "↻" },
  "stopping|ok": { color: "#4c8dff", label: "停止中…", icon: "↻" },
  "stopping|unknown": { color: "#4c8dff", label: "停止中…", icon: "↻" },
  "stopping|unreachable": { color: "#4c8dff", label: "停止中…", icon: "↻" },
  "stopping|unauthorized": { color: "#4c8dff", label: "停止中…", icon: "↻" },
  "stopped|ok": { color: "#8b93a1", label: "已停止", icon: "●" },
  "stopped|unknown": { color: "#8b93a1", label: "已停止", icon: "●" },
  "stopped|unreachable": { color: "#e05252", label: "已停止", icon: "●" },
  "stopped|unauthorized": { color: "#e05252", label: "已停止", icon: "●" },
  "failed|ok": { color: "#e05252", label: "启动失败", icon: "▲" },
  "failed|unknown": { color: "#e05252", label: "启动失败", icon: "▲" },
  "failed|unreachable": { color: "#e05252", label: "启动失败 · 连接不可达", icon: "▲" },
  "failed|unauthorized": { color: "#e05252", label: "启动失败 · 连接未授权", icon: "▲" },
};

const FALLBACK: Omit<StatusVisual, "advice"> = { color: "#8b93a1", label: "状态未知", icon: "○" };

/** 二维状态 → 状态灯（颜色 + 文案 + 图标 + 处置建议，见 UserStory §5.4.3）。 */
export function statusVisual(ps: ProcessState, cs: ConnectionState): StatusVisual {
  const base = VISUAL[`${ps}|${cs}`] ?? FALLBACK;
  return { ...base, advice: statusAdvice(ps, cs) };
}

/** 由二维状态推导用户处置建议（UserStory §5.4.3 / §5.5.3）。 */
export function statusAdvice(ps: ProcessState, cs: ConnectionState): string {
  if (ps === "stopped") return "点击「启动桥接」一键拉起";
  if (ps === "starting" || ps === "stopping") return "等待就绪轮询完成";
  if (ps === "failed") return "复核 Node 与依赖路径，或查看 bridge.log";
  if (ps === "running" && cs === "ok") return "无需操作";
  if (ps === "running" && cs === "unauthorized") return "检查登录态 / 重新扫码";
  return "检查内核与端口占用";
}

/** E1~E4 异常分类（UserStory §5.5.3）。probe 传 null 表示探测完全不可达。 */
export type AnomalyCode = "E1" | "E2" | "E3" | "E4" | "NONE";

export interface ProbeResult {
  reachable: boolean; // HTTP 是否可达（连接被拒 / 超时 = false）
  ok?: boolean;
  ready?: boolean;
  kernel?: string | null;
  portOccupiedByOther?: boolean; // 启动动作失败后附加检测
}

export const ANOMALY_TEXT: Record<Exclude<AnomalyCode, "NONE">, { msg: string; advice: string; level: "P0" | "P1" | "P2" }> = {
  E1: { msg: "桥接进程未运行", advice: "点击「启动桥接」一键拉起", level: "P0" },
  E2: { msg: "端口 8765 被占用", advice: "终止占用进程，或在设置页更换桥接端口", level: "P0" },
  E3: { msg: "未找到浏览器内核", advice: "安装 Chrome 或 Edge，或保留内置内核", level: "P1" },
  E4: { msg: "桥接已运行但连接异常（可能登录态失效）", advice: "检查登录态 / 重启桥接 / 运行环境自检", level: "P1" },
};

/** 依固定顺序判定异常类型：端口监听 → /ping 可达性 → 内核字段 → 端口占用。 */
export function classifyAnomaly(probe: ProbeResult | null): AnomalyCode {
  if (!probe || !probe.reachable) {
    return probe && probe.portOccupiedByOther ? "E2" : "E1";
  }
  if (probe.ok === false || probe.ready === false) {
    return !probe.kernel ? "E3" : "E4";
  }
  return "NONE";
}

// ---------- 笔记文本手术（M3 SummaryService 的「原文零覆盖」保障） ----------

const TRANSCRIPT_HEAD = "> [!quote]- 逐字稿";
const OCR_HEAD = "> [!note]- 图片文字";
const ABSTRACT_HEAD = "> [!abstract]- 摘要";

/** 折叠块头部 → 内容行集合（含首行，剥离 "> " 前缀）。块以「非 > 行」结束。 */
function extractCallout(lines: string[], headPrefix: string): string[] {
  const out: string[] = [];
  let collecting = false;
  for (const line of lines) {
    if (!collecting && line.startsWith(headPrefix)) {
      collecting = true;
      out.push(line.slice(headPrefix.length).replace(/^:\s*/, "").trim());
      continue;
    }
    if (collecting) {
      if (line.startsWith(">")) {
        out.push(line.replace(/^>\s?/, "").trim());
      } else {
        break; // 折叠块结束（空行 / --- / 正文）
      }
    }
  }
  return out.filter((s) => s.length > 0 && !s.startsWith("[!"));
}

/** 从笔记正文中抽取逐字稿与图片文字（摘要的输入源）。 */
export function extractSummarySources(markdown: string): { transcript: string; ocrText: string } {
  const lines = markdown.split(/\r?\n/);
  return {
    transcript: extractCallout(lines, TRANSCRIPT_HEAD).join("\n"),
    ocrText: extractCallout(lines, OCR_HEAD).join("\n"),
  };
}

/**
 * 在正文中插入或原位替换「摘要」折叠块，其余内容（含逐字稿 / 图片文字块）逐字保留。
 * 位置：frontmatter 之后、正文最前。已存在摘要块时仅替换该块。
 */
export function upsertAbstractBlock(markdown: string, summary: string): string {
  const lines = markdown.split(/\r?\n/);
  const block = [`> [!abstract]- 摘要`, ...summary.split(/\r?\n/).map((s) => `> ${s}`)];

  // 找到既有摘要块范围
  let start = -1;
  let end = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith(ABSTRACT_HEAD)) {
      start = i;
      end = i;
      while (end + 1 < lines.length && lines[end + 1].startsWith(">")) end++;
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
      if (lines[i].trim() === "---") {
        insertAt = i + 1;
        break;
      }
    }
  }
  while (insertAt < lines.length && lines[insertAt].trim() === "") insertAt++;
  return [...lines.slice(0, insertAt), ...block, "", ...lines.slice(insertAt)].join("\n");
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
export function appendOcrToNoteCallout(markdown: string, text: string): string {
  const lines = markdown.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith(OCR_HEAD)) {
      let end = i;
      while (end + 1 < lines.length && lines[end + 1].startsWith(">")) end++;
      const added = text.split(/\r?\n/).map((s) => `> ${s}`);
      return [...lines.slice(0, end + 1), ...added, ...lines.slice(end + 1)].join("\n");
    }
  }
  const block = [`> [!note]- 图片文字`, ...text.split(/\r?\n/).map((s) => `> ${s}`)];
  let insertAt = 0;
  if (lines[0]?.trim() === "---") {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === "---") {
        insertAt = i + 1;
        break;
      }
    }
  }
  while (insertAt < lines.length && lines[insertAt].trim() === "") insertAt++;
  return [...lines.slice(0, insertAt), ...block, "", ...lines.slice(insertAt)].join("\n");
}

// ---------- 进程探测辅助（M1 ProcessManager 的纯解析部分） ----------

/** 从 `netstat -ano` 输出中解析出监听指定端口的 PID 集合（去重、只保留 LISTENING）。 */
export function parsePidsFromNetstat(output: string, port: number): number[] {
  const pids = new Set<number>();
  for (const line of output.split(/\r?\n/)) {
    if (!line.includes(`:${port} `)) continue;
    if (!/LISTENING/i.test(line)) continue;
    const m = line.trim().match(/(\d+)\s*$/);
    if (m) {
      const pid = Number(m[1]);
      if (Number.isFinite(pid) && pid > 0) pids.add(pid);
    }
  }
  return [...pids];
}

/** 校验字符串是否为纯数字（防命令注入：taskkill 参数必须为纯数字 PID）。 */
export function isNumericPid(v: string): boolean {
  return /^\d{1,10}$/.test(v.trim());
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

/** 问题 6：重试路径从既有笔记回收的可复用资产（免二次下载 / 免重复 OCR / 免重复分类）。 */
export interface ReusedNoteAssets {
  coverPath: string;
  category: string;
  images: string[];
  visionTexts: { index: number; text: string; status: string }[];
  framePaths: string[];
  /** 既有摘要正文（摘要折叠块内容）；重建笔记后用于回填，避免「摘要重生成失败 = 摘要永久丢失」 */
  summaryText: string;
  /** 既有摘要格式版本（frontmatter summary_v） */
  summaryV: string;
}

/**
 * 从既有笔记回收可复用资产（问题 6：重试只需重跑 transcribe + writeNote，不再触发全套副作用）。
 * 解析口径与 noteBuilder 的产出格式一一对应：frontmatter cover/category（引号无关，兼容
 * processFrontMatter 重写后去引号）、行首 `![[...]]` 图片、`> ![[...]]` 关键帧、图片文字折叠块的
 * `**图 N**（status）` 逐图分段。任何一段解析失败都以空值返回，调用方回退到联网路径。
 */
export function collectExistingAssets(markdown: string): ReusedNoteAssets {
  const lines = markdown.split(/\r?\n/);
  const empty: ReusedNoteAssets = {
    coverPath: "",
    category: "",
    images: [],
    visionTexts: [],
    framePaths: [],
    summaryText: "",
    summaryV: "",
  };
  if (lines[0]?.trim() !== "---") return empty;
  let fmEnd = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
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

  // 正文图片：行首 ![[...]]（关键帧在折叠块内，行首是 "> ![[...]]"，不会混入）
  const images: string[] = [];
  for (const l of lines) {
    const m = l.match(/^!\[\[([^\]]+)\]\]/);
    if (m) images.push(m[1]);
  }

  // 关键帧：折叠块内的 "> ![[...]]"
  const framePaths: string[] = [];
  for (const l of lines) {
    const m = l.match(/^> !\[\[([^\]]+)\]\]/);
    if (m) framePaths.push(m[1]);
  }

  // 图片文字（逐图）：按 **图 N**（status） 分段回收
  const ocrStart = lines.findIndex((l) => l.startsWith(OCR_HEAD));
  const visionTexts: { index: number; text: string; status: string }[] = [];
  if (ocrStart >= 0) {
    let end = ocrStart;
    while (end + 1 < lines.length && lines[end + 1].startsWith(">")) end++;
    const body = lines.slice(ocrStart, end + 1).map((l) => l.replace(/^>\s?/, ""));
    let cur: { index: number; text: string; status: string } | null = null;
    for (const l of body) {
      const m = l.match(/^\*\*图 (\d+)\*\*（(.+?)）$/);
      if (m) {
        if (cur) visionTexts.push(cur);
        cur = { index: Number(m[1]), text: "", status: m[2] };
      } else if (cur && l.trim() && !l.startsWith("[!")) {
        cur.text += (cur.text ? "\n" : "") + l;
      }
    }
    if (cur) visionTexts.push(cur);
  }

  // 既有摘要：折叠块正文 + frontmatter 版本号（重建笔记时回填，防止摘要因重生成失败而丢失）
  let summaryText = "";
  const absStart = lines.findIndex((l) => l.startsWith(ABSTRACT_HEAD));
  if (absStart >= 0) {
    let end = absStart;
    while (end + 1 < lines.length && lines[end + 1].startsWith(">")) end++;
    summaryText = lines
      .slice(absStart + 1, end + 1)
      .map((l) => l.replace(/^>\s?/, ""))
      .join("\n")
      .trim();
  }

  return {
    coverPath: fmVal("cover"),
    category: fmVal("category"),
    images,
    visionTexts,
    framePaths,
    summaryText,
    summaryV: fmVal("summary_v"),
  };
}
