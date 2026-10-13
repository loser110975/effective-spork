import { requestUrl, Vault, normalizePath, TFile } from "obsidian";
import { imageMimeFromName } from "./statusCore";
import { DOUYIN_UA } from "./util";

const CDN_HEADERS = {
  Referer: "https://www.douyin.com/",
  "User-Agent": DOUYIN_UA,
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

/** F5（第十轮）：图片完整性魔数校验。0 字节残档可被 size>0 之外的路径自愈，
 *  但「写入中段崩溃」留下的是**非 0 截断残档**——size>0 判据放行后笔记永久嵌一张坏图。
 *  命中已存在文件时校验头部魔数：jpg/png/webp/gif 的头都不对即视为残档重新下载
 *  （截断文件头部通常仍完好，但头部损坏的文件必定不可用——宁可靠一次 CDN 流量）。
 *  未知扩展名/读取失败按完好处理（不拦主流程）。 */
async function imageHeaderIntact(vault: Vault, path: string, ext: string): Promise<boolean> {
  const expected: Record<string, number[]> = {
    jpg: [0xff, 0xd8, 0xff],
    jpeg: [0xff, 0xd8, 0xff],
    png: [0x89, 0x50, 0x4e, 0x47],
    gif: [0x47, 0x49, 0x46, 0x38],
    // webp: "RIFF"...."WEBP"
    webp: [0x52, 0x49, 0x46, 0x46],
  };
  const sig = expected[ext];
  if (!sig) return true;
  try {
    const f = vault.getAbstractFileByPath(path);
    if (!(f instanceof TFile)) return false;
    const buf = await vault.readBinary(f);
    if (buf.byteLength < sig.length) return false;
    const head = new Uint8Array(buf, 0, sig.length);
    for (let i = 0; i < sig.length; i++) {
      if (head[i] !== sig[i]) return false;
    }
    return true;
  } catch {
    return true; // 读取失败不拦主流程：按完好处理（下游引用失败再走重下通道）
  }
}

export class MediaStore {
  constructor(
    private vault: Vault,
    private mediaRoot: string,
  ) {}

  /** 下载封面/图片到 Media 目录，返回 vault 相对路径；失败返回 ""。 */
  async saveImage(url: string, relPathWithoutExt: string): Promise<string> {
    if (!url) return "";
    const ext = extFromUrl(url);
    const full = normalizePath(`${this.mediaRoot}/${relPathWithoutExt}.${ext}`);
    // 幂等前置：扩展名由 URL 确定，命中有效文件就免一次 CDN 流量；
    // 0 字节残档（上次中断产物，ASR 报告证实过该模式）视为不存在，重新下载覆盖；
    // F5（第十轮）：非 0 截断残档按头部魔数识别，同样重下覆盖
    const existing = this.vault.getAbstractFileByPath(full);
    if (existing instanceof TFile && existing.stat.size > 0 && (await imageHeaderIntact(this.vault, full, ext))) {
      return full;
    }
    // 瞬时失败一次重试（2026-09-27 第四轮）：条目写入 processed 台账后不再重跑，
    // 单次 CDN 抖动 = 缺图永久定格；封面/图片下载幂等，重试无副作用
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        if (attempt > 0) await new Promise((r) => setTimeout(r, 800));
        const res = await requestUrl({ url, method: "GET", headers: CDN_HEADERS, throw: false });
        if (res.status !== 200 || !res.arrayBuffer || res.arrayBuffer.byteLength === 0) {
          // 5xx 服务端瞬时故障与 429 限流值得重试（第九轮 B6：429 不重试会让瞬时限流
          // 定格为永久缺图——条目写入 processed 台账后不再重跑）；403/404 重试无意义
          if ((res.status >= 500 || res.status === 429) && attempt === 0) continue;
          return "";
        }
        await ensureFolder(this.vault, full.slice(0, full.lastIndexOf("/")));
        // 0 字节残档文件已存在 → createBinary 会抛「already exists」，必须走 modifyBinary 覆盖写
        //（单测发现：原实现重下后仍在 catch 里回查到 0 字节旧文件，残档永久卡死无法自愈）
        const expectBytes = res.arrayBuffer.byteLength;
        let target: TFile;
        if (existing instanceof TFile) {
          await this.vault.modifyBinary(existing, res.arrayBuffer);
          target = existing;
        } else {
          target = await this.vault.createBinary(full, res.arrayBuffer);
        }
        // F5（第十轮）：写后字节核对——写盘中段被杀留下非 0 短文件的话，size>0 命中判据
        // 会把它当有效图定格进笔记。不符即覆盖重写一次（modifyBinary 幂等，代价可忽略）
        if (target.stat.size !== expectBytes) {
          await this.vault.modifyBinary(target, res.arrayBuffer);
        }
        return full;
      } catch {
        // 条目级并发下两个流同时写同一路径：后写方 createBinary 抛「已存在」时文件其实已就位，回查一次
        const retry = this.vault.getAbstractFileByPath(full);
        if (retry instanceof TFile && retry.stat.size > 0) return full;
        // 否则进入下一轮重试；两轮都失败返回 ""
      }
    }
    return "";
  }

  /** 已入库图片文件 → base64 data URL（OCR 直接复用已下载字节，免二次走 CDN）；失败返回 ""。 */
  async dataUrlFromFile(vaultPath: string): Promise<string> {
    try {
      const buf = await this.vault.adapter.readBinary(normalizePath(vaultPath));
      const mime = imageMimeFromName(vaultPath) ?? "image/jpeg";
      const b64 = Buffer.from(buf).toString("base64");
      return `data:${mime};base64,${b64}`;
    } catch {
      return "";
    }
  }

  /** 图片 URL 转 base64 data URL（视觉模型无法直连抖音 CDN 时的兜底）。
   *  maxBytes 可选上限：超限返回 ""（调用方回退 URL 直传），防超大图 base64 后内存峰值失控。
   *  2026-09-27：mime 收敛到 imageMimeFromName——heic 等不支持的格式不再被误标成 jpeg 送模型。 */
  async toDataUrl(url: string, maxBytes = Number.POSITIVE_INFINITY): Promise<string> {
    try {
      // 剥掉 query/hash 再取扩展名（回归审查 #4）：抖音 url_list 的图片地址普遍带 query，
      // 不剥的话 imageMimeFromName 查不到 → 恒返回空串，OCR 的 base64 兜底路径全部失效
      const mime = imageMimeFromName(url.replace(/[?#].*$/, ""));
      if (!mime) return "";
      const res = await requestUrl({ url, method: "GET", headers: CDN_HEADERS, throw: false });
      if (res.status !== 200 || !res.arrayBuffer) return "";
      if (res.arrayBuffer.byteLength > maxBytes) return "";
      const b64 = Buffer.from(res.arrayBuffer).toString("base64");
      return `data:${mime};base64,${b64}`;
    } catch {
      return "";
    }
  }
}
