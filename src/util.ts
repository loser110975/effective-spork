export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 插件侧统一 UA（2026-09-27 收敛：douyinClient / media / videoMedia 三处各写一份，
 * 曾经漂移成 130 / 140 两个版本）。改 UA 只改这一处；桥接进程侧的 UA 在 bridge-common.js 单独维护。
 * 注意：sec-ch-ua 指纹头（douyinClient.SEC_HEADERS）里的版本号必须与这里的 Chrome 主版本一致。
 */
export const DOUYIN_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

// ---------- Node 模块统一访问（问题 3：替代分散的 (window as any).require） ----------

/**
 * Electron 渲染进程的 Node require 统一入口：带错误边界与类型收敛。
 * 不可用（非桌面端 / nodeIntegration 关闭）时返回 null，调用方据此走降级分支。
 */
export function nodeRequireFn(): ((id: string) => any) | null {
  try {
    const req = (window as any).require;
    return typeof req === "function" ? req : null;
  } catch {
    return null;
  }
}

/** 按模块 id require；不可用时返回 null。 */
export function nodeRequire<T = any>(id: string): T | null {
  const req = nodeRequireFn();
  try {
    return req ? (req(id) as T) : null;
  } catch {
    return null;
  }
}

/** 「配置 → 实际可执行文件」决策结果（nodepath 过期加固）。 */
export interface NodeExeResolution {
  /** 实际用于 spawn 的可执行文件：配置路径有效时为原路径，否则为 PATH 上的 "node" */
  exe: string;
  /** 配置了但文件已不存在的原路径（stale 标记；健康路径与未配置时为空） */
  stalePath?: string;
}

/**
 * 配置路径 → 实际 spawn 用的 node 可执行文件（纯函数，existsFn 注入便于单测）。
 * 三分支：未配置/空白 → "node"；配置且文件存在 → 原路径（健康路径行为零变化）；
 * 配置但文件不存在 → 回退 "node" 并返回 stalePath 供调用方发一次性警告
 * （事故背景：WorkBuddy 更新会换 node 版本目录并删除旧目录，data.json 里的
 * bridgeNodePath 随之失效，spawn 异步 ENOENT 只能空等 15s 超时）。
 */
export function resolveNodeExe(opts: {
  bridgeNodePath?: string | null;
  existsFn?: (p: string) => boolean;
}): NodeExeResolution {
  const exists = opts.existsFn ?? fsExists;
  const configured = (opts.bridgeNodePath ?? "").trim();
  if (!configured) return { exe: "node" };
  if (exists(configured)) return { exe: configured };
  return { exe: "node", stalePath: configured };
}

/** 同步存在性检查；fs 不可用时返回 false（调用方应有候选回退或 stderr 兜底）。 */
export function fsExists(p: string): boolean {
  const fs = nodeRequire<{ existsSync(p: string): boolean }>("fs");
  return !!fs && fs.existsSync(p);
}

const ILLEGAL = /[\\/:*?"<>|#^[\]%\u0000-\u001f\u007f]/g;
/** Windows 保留设备名（CON.md 这类形式同样非法）。 */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

export function sanitizeFilename(name: string, maxLen = 60): string {
  let cleaned = (name || "")
    .replace(ILLEGAL, " ")
    .replace(/\s+/g, " ")
    .trim();
  // NTFS 会剥离组件结尾的 `.` 与空格 → 请求路径与实际落盘名不一致，vault.create 直接报错
  cleaned = cleaned.replace(/[. ]+$/, "");
  if (RESERVED.test(cleaned)) cleaned = `_${cleaned}`;
  if (!cleaned) return "";
  if (cleaned.length <= maxLen) return cleaned;
  // 按码点截断（复审 P1）：slice 按 UTF-16 code unit 切会把 emoji 代理对劈成孤代理——
  // 非法 UTF-16 文件名会让 vault.create 报错（该条目每轮同步固定失败）或落盘后往返不一致
  return Array.from(cleaned)
    .slice(0, maxLen)
    .join("")
    .replace(/[. ]+$/, "")
    .trim();
}

export function noteTitleFor(desc: string, id: string): string {
  const firstLine = (desc || "").split("\n")[0].trim();
  const t = sanitizeFilename(firstLine);
  return t || `抖音_${id}`;
}

/** YAML 双引号标量：JSON 串接近似（YAML 双引号支持 JSON 转义）。 */
export function yamlStr(v: unknown): string {
  if (v === null || v === undefined) return '""';
  return JSON.stringify(String(v));
}

export function isoFromUnix(sec: number): string {
  if (!sec) return "";
  return new Date(sec * 1000).toISOString();
}

export function localDate(sec: number): string {
  if (!sec) return "";
  const d = new Date(sec * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function fmtDuration(sec: number): string {
  if (!sec || sec < 0) return "";
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m > 0 ? `${m}分${s}秒` : `${s}秒`;
}

export function mmss(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function randomHex(len: number): string {
  const chars = "0123456789abcdef";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * 16)];
  return out;
}

/**
 * 按码点截断（与 noteBuilder 800 字分段同一策略）：slice 按 UTF-16 code unit 切会把
 * emoji 代理对劈成孤代理，JSON.stringify 后部分严格的服务端直接 400，整条请求失败。
 * 所有「送进模型提示词前的文本截断」一律走这里。
 */
export function sliceByCodePoints(s: string, max: number): string {
  if (!s) return s;
  const chars = Array.from(s);
  return chars.length <= max ? s : chars.slice(0, max).join("");
}

/** headTailSlice 的中段省略标记（醒目、肉眼可辨；视频/图文两通道共用同一份）。 */
export const HEAD_TAIL_OMITTED_MARK = "\n……（中段已省略）……\n";

/**
 * 截断明示句（拼进提示词，让模型知道中段缺失、严禁编造；视频/图文两通道共用同一口径）。
 * 历史：头部截断（sliceByCodePoints）静默丢内容且提示词不明示——模型把截断结果当成完整
 * 原文，长视频结尾的结论/recap 段直接消失，摘要在「总结与意义」节只能凭前文脑补。
 */
export const SOURCE_TRUNCATION_NOTICE =
  "注意：原文过长，已仅保留开头与结尾，中段省略；严禁对未提供的中间内容做任何编造或填充。";

/** headTailSlice 的返回：text 为拼装后的文本；truncated 标记是否发生了首尾截断。 */
export interface HeadTailSliceResult {
  text: string;
  truncated: boolean;
}

/**
 * 首尾保留式截断（第十四轮）：headTailSlice(text, headChars, tailChars)。
 * 为什么不用 sliceByCodePoints 头部截断：长视频/长图文的结尾（结论、recap、总结段）是
 * 最有价值的要点候选，头部截断会静默丢弃；改为「首 head + 中段省略标记 + 尾 tail」，
 * 截断事实由调用方用 SOURCE_TRUNCATION_NOTICE 明示进提示词，模型据此不编造中段。
 * 与 sliceByCodePoints 同口径：按码点切分（Array.from），emoji / 星体字符不会被代理对劈开。
 * 长度 ≤ head+tail（含空串）原样返回且 truncated=false；某侧为 0 时该侧为空。
 */
export function headTailSlice(text: string, headChars: number, tailChars: number): HeadTailSliceResult {
  const chars = Array.from(text ?? "");
  if (chars.length <= headChars + tailChars) return { text, truncated: false };
  const head = chars.slice(0, headChars).join("");
  // 注意不能写 chars.slice(-tailChars)：tailChars=0 时 -0 即 0，会把全文当尾段拼回来
  const tail = tailChars > 0 ? chars.slice(chars.length - tailChars).join("") : "";
  return { text: head + HEAD_TAIL_OMITTED_MARK + tail, truncated: true };
}

export function parseList(text: string): string[] {
  return (text || "")
    .split(/[,\n，、]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 去水印播放地址：playwm → play */
export function noWatermark(url: string): string {
  return url ? url.replace("playwm", "play") : url;
}
