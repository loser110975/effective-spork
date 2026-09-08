export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const ILLEGAL = /[\\/:*?"<>|#^[\]%\u0000-\u001f]/g;

export function sanitizeFilename(name: string, maxLen = 60): string {
  const cleaned = (name || "")
    .replace(ILLEGAL, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "";
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen).trim() : cleaned;
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

export function parseList(text: string): string[] {
  return (text || "")
    .split(/[,\n，、]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function clampInt(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, Math.round(v)));
}

/** 去水印播放地址：playwm → play */
export function noWatermark(url: string): string {
  return url ? url.replace("playwm", "play") : url;
}

export function truncate(s: string, n: number): string {
  if (!s) return "";
  return s.length > n ? s.slice(0, n) + "…" : s;
}
