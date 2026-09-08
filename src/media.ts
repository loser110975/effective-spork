import { requestUrl, Vault, normalizePath } from "obsidian";

const CDN_HEADERS = {
  Referer: "https://www.douyin.com/",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
};

export async function ensureFolder(vault: Vault, path: string): Promise<void> {
  const p = normalizePath(path);
  const parts = p.split("/").filter(Boolean);
  let cur = "";
  for (const part of parts) {
    cur = cur ? `${cur}/${part}` : part;
    const existing = vault.getAbstractFileByPath(cur);
    if (!existing) {
      try {
        await vault.createFolder(cur);
      } catch {
        /* 并发或已存在 */
      }
    }
  }
}

function extFromUrl(url: string, fallback = "jpg"): string {
  const m = url.match(/\.(jpe?g|png|webp|gif|heic)(?:\?|$)/i);
  return m ? m[1].toLowerCase() : fallback;
}

export class MediaStore {
  constructor(
    private vault: Vault,
    private mediaRoot: string,
  ) {}

  /** 下载封面/图片到 Media 目录，返回 vault 相对路径；失败返回 ""。 */
  async saveImage(url: string, relPathWithoutExt: string): Promise<string> {
    if (!url) return "";
    try {
      const res = await requestUrl({ url, method: "GET", headers: CDN_HEADERS, throw: false });
      if (res.status !== 200 || !res.arrayBuffer || res.arrayBuffer.byteLength === 0) return "";
      const ext = extFromUrl(url);
      const full = normalizePath(`${this.mediaRoot}/${relPathWithoutExt}.${ext}`);
      const existing = this.vault.getAbstractFileByPath(full);
      const buf = res.arrayBuffer;
      if (existing) return full;
      await ensureFolder(this.vault, full.slice(0, full.lastIndexOf("/")));
      await this.vault.createBinary(full, buf);
      return full;
    } catch {
      return "";
    }
  }

  /** 图片 URL 转base64 data URL（视觉模型无法直连抖音 CDN 时的兜底）。 */
  async toDataUrl(url: string): Promise<string> {
    try {
      const res = await requestUrl({ url, method: "GET", headers: CDN_HEADERS, throw: false });
      if (res.status !== 200 || !res.arrayBuffer) return "";
      const mime = url.match(/\.(png)(?:\?|$)/i)
        ? "image/png"
        : url.match(/\.(webp)(?:\?|$)/i)
          ? "image/webp"
          : "image/jpeg";
      const b64 = Buffer.from(res.arrayBuffer).toString("base64");
      return `data:${mime};base64,${b64}`;
    } catch {
      return "";
    }
  }
}
