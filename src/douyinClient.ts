import { requestUrl, RequestUrlParam, RequestUrlResponse } from "obsidian";
import { DouyinAwemeRaw, DouyinPage, SyncItem, ItemType } from "./types";
import { noWatermark } from "./util";

/**
 * 抖音 Web API 客户端。
 *
 * 签名策略：与旧工具（douyin-favorites-to-knowledge，2026-09 前持续可用）一致，
 * 对收藏/喜欢列表端点不做 a_bogus 签名，仅携带完整 Cookie + 浏览器 UA + Referer。
 * 若抖音后续强制签名，请求会返回 status_code != 0 / HTTP 403，
 * "测试连接"命令会把服务器原始响应展示出来便于诊断。
 */

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

// 与真实浏览器请求保持一致的指纹头（Argus 风控会核对 UA 与 sec-ch-ua 一致性）
const SEC_HEADERS: Record<string, string> = {
  "sec-ch-ua": `"Chromium";v="130", "Google Chrome";v="130", "Not?A_Brand";v="99"`,
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-origin",
};

const BASE_PARAMS: Record<string, string> = {
  device_platform: "webapp",
  aid: "6383",
  channel: "channel_pc_web",
  cookie_enabled: "true",
  browser_language: "zh-CN",
  browser_platform: "Win32",
  browser_name: "Chrome",
  version_code: "170400",
};

export interface CollectionFolder {
  id: string;
  name: string;
}

export class DouyinClient {
  /** 生效的请求头档位：0=全套（含 sec-ch-ua/sec-fetch） 1=无指纹头 2=最小集（UA+Cookie）。 */
  private variant = 0;

  constructor(
    private cookie: string,
    private bridgeUrl?: string,
    private spawnBridge?: () => Promise<void>,
  ) {}

  /** 桥接响应 → parsePage 兼容的响应形状（status/text/json）。 */
  private shim(status: number, text: string): RequestUrlResponse {
    let parsed: any = null;
    let ok = false;
    try {
      parsed = JSON.parse(text);
      ok = true;
    } catch {
      /* parsePage 会自行处理非 JSON */
    }
    return {
      status,
      text,
      get json() {
        if (!ok) throw new Error("响应不是 JSON");
        return parsed;
      },
    } as unknown as RequestUrlResponse;
  }

  /** 经本地桥接（真实 Chromium 页面上下文）发请求，绕过 Argus 对非浏览器指纹的拦截。 */
  private async reqViaBridge(
    opts: { url: string; method?: string; body?: string },
    extra?: Record<string, string>,
  ): Promise<RequestUrlResponse> {
    const payload = JSON.stringify({
      url: opts.url,
      method: opts.method || "GET",
      body: opts.body,
      contentType: extra?.["Content-Type"],
    });
    const post = () =>
      requestUrl({
        url: `${this.bridgeUrl}/req`,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
        throw: false,
      });
    let res: RequestUrlResponse;
    try {
      res = await post();
    } catch {
      if (!this.spawnBridge) throw new Error("本地桥接未运行且未配置自动启动");
      await this.spawnBridge();
      res = await post();
    }
    if (res.status !== 200) {
      throw new Error(`桥接 HTTP ${res.status}: ${String(res.text).slice(0, 120)}`);
    }
    let out: { status: number; text: string };
    try {
      out = JSON.parse(res.text);
    } catch {
      throw new Error(`桥接响应异常: ${String(res.text).slice(0, 120)}`);
    }
    if (out.status === -1) throw new Error(String(out.text).slice(0, 200));
    return this.shim(out.status, out.text);
  }

  private headerVariants(extra?: Record<string, string>): Record<string, string>[] {
    const base: Record<string, string> = {
      "User-Agent": UA,
      Cookie: this.cookie,
      Referer: "https://www.douyin.com/user/self?showTab=favorite_collection",
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "zh-CN,zh;q=0.9",
    };
    const minimal: Record<string, string> = { "User-Agent": UA, Cookie: this.cookie };
    return [
      { ...base, ...SEC_HEADERS, ...(extra || {}) },
      { ...base, ...(extra || {}) },
      { ...minimal, ...(extra || {}) },
    ];
  }

  private static VARIANT_NAMES = ["全套头", "无指纹头", "最小头"];

  /**
   * 自适应请求。Obsidian 的 requestUrl 底层对请求头校验比标准浏览器严格，
   * 部分头（如 sec-ch-ua 的裸引号值）会触发 net::ERR_INVALID_ARGUMENT，
   * 因此失败时自动降档重试，并记住本次会话可用的档位。
   */
  private async req(
    opts: { url: string; method?: string; body?: string },
    extra?: Record<string, string>,
  ): Promise<RequestUrlResponse> {
    if (this.bridgeUrl) return this.reqViaBridge(opts, extra);
    const variants = this.headerVariants(extra);
    const start = Math.min(this.variant, variants.length - 1);
    let lastErr: unknown = null;
    for (let i = start; i < variants.length; i++) {
      try {
        const res = await requestUrl({ ...opts, headers: variants[i], throw: false } as RequestUrlParam);
        this.variant = i;
        return res;
      } catch (e) {
        lastErr = e;
      }
    }
    throw new Error(
      `请求发送失败（已尝试 ${DouyinClient.VARIANT_NAMES.slice(start).join("、")}）：${
        lastErr instanceof Error ? lastErr.message : String(lastErr)
      }`,
    );
  }

  private qs(extra?: Record<string, string>): string {
    const all = { ...BASE_PARAMS, ...(extra || {}) };
    return Object.entries(all)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join("&");
  }

  private assertCookie() {
    if (!this.cookie || !/sessionid/.test(this.cookie)) {
      throw new Error("Cookie 未配置或缺少 sessionid（请从浏览器 Network 面板复制完整 Cookie）");
    }
  }

  /** 收藏列表（扁平，POST，旧工具验证过的端点）。 */
  async listCollection(cursor: number, count = 20): Promise<DouyinPage> {
    this.assertCookie();
    const url = `https://www.douyin.com/aweme/v1/web/aweme/listcollection/?${this.qs()}`;
    const res = await this.req(
      { url, method: "POST", body: `count=${count}&cursor=${cursor}` },
      { "Content-Type": "application/x-www-form-urlencoded" },
    );
    return this.parsePage(res, ["aweme_list"], "listcollection");
  }

  /** 收藏夹列表（ folders）。 */
  async listFolders(cursor = 0, count = 20): Promise<CollectionFolder[]> {
    this.assertCookie();
    const url = `https://www.douyin.com/aweme/v1/web/collection/list/?${this.qs({ count: String(count), cursor: String(cursor) })}`;
    const res = await this.req({ url, method: "GET" });
    let data: any = null;
    try {
      data = res.json;
    } catch {
      /* ignore */
    }
    if (!data || res.status !== 200) {
      throw new Error(`collection/list HTTP ${res.status}`);
    }
    const rawList: any[] = data.collections || data.collection_list || [];
    const out: CollectionFolder[] = [];
    for (const c of rawList) {
      const id = String(c?.collection_id ?? c?.collect_id ?? c?.id ?? "");
      const name = String(c?.collect_name ?? c?.collection_name ?? c?.name ?? "").trim();
      if (id && name) out.push({ id, name });
    }
    return out;
  }

  /** 某个收藏夹内的条目。 */
  async listFolderItems(folderId: string, cursor = 0, count = 20): Promise<DouyinPage> {
    this.assertCookie();
    const url = `https://www.douyin.com/aweme/v1/web/collection/item/list/?${this.qs({
      collection_id: folderId,
      cursor: String(cursor),
      count: String(count),
    })}`;
    const res = await this.req({ url, method: "GET" });
    return this.parsePage(res, ["aweme_list", "collection_items"], "collection/item/list");
  }

  /** 喜欢（点赞）列表，需要自己的 sec_user_id。 */
  async listLikes(secUid: string, maxCursor = 0, count = 20): Promise<DouyinPage> {
    this.assertCookie();
    const url = `https://www.douyin.com/aweme/v1/web/aweme/favorite/?${this.qs({
      sec_user_id: secUid,
      max_cursor: String(maxCursor),
      count: String(count),
    })}`;
    const res = await this.req({ url, method: "GET" });
    return this.parsePage(res, ["aweme_list"], "favorite");
  }

  /** 自己的作品列表。 */
  async listPosts(secUid: string, maxCursor = 0, count = 20): Promise<DouyinPage> {
    this.assertCookie();
    const url = `https://www.douyin.com/aweme/v1/web/aweme/post/?${this.qs({
      sec_user_id: secUid,
      max_cursor: String(maxCursor),
      count: String(count),
    })}`;
    const res = await this.req({ url, method: "GET" });
    return this.parsePage(res, ["aweme_list"], "post");
  }

  /** 单条详情（重试转写时刷新 play_url 用）。 */
  async getAwemeDetail(awemeId: string): Promise<DouyinAwemeRaw | null> {
    const url = `https://www.douyin.com/aweme/v1/web/aweme/detail/?${this.qs({ aweme_id: awemeId })}`;
    const res = await this.req({ url, method: "GET" });
    let data: any = null;
    try {
      data = res.json;
    } catch {
      /* ignore */
    }
    return data?.aweme_detail ?? null;
  }

  /** 从 self 页面 HTML 抠出自己的 sec_user_id（旧工具同款正则）。 */
  async getSelfSecUid(): Promise<string> {
    this.assertCookie();
    const res = await this.req(
      {
        url: "https://www.douyin.com/user/self?showTab=favorite_collection",
        method: "GET",
      },
      { Accept: "text/html,application/xhtml+xml" },
    );
    const html = res.text || "";
    const m =
      html.match(/"sec_user_id"\s*:\s*"([^"]+)"/) || html.match(/sec_user_id=([^&"\s]+)/);
    if (!m) {
      throw new Error("无法从个人页获取 sec_user_id（登录可能已失效）");
    }
    return m[1];
  }

  private parsePage(res: any, listKeys: string[], tag: string): DouyinPage {
    let data: any = null;
    try {
      data = res.json;
    } catch {
      /* ignore */
    }
    if (res.status !== 200 || !data) {
      throw new Error(`${tag}: HTTP ${res.status}${typeof res.text === "string" ? ` ${res.text.slice(0, 120)}` : ""}`);
    }
    if (data.status_code !== 0) {
      throw new Error(`${tag}: status_code=${data.status_code}${data.status_msg ? ` (${data.status_msg})` : ""}`);
    }
    let items: DouyinAwemeRaw[] = [];
    for (const k of listKeys) {
      if (Array.isArray(data?.[k])) {
        items = data[k];
        break;
      }
    }
    return {
      ok: true,
      hasMore: Boolean(data.has_more),
      cursor: Number(data.cursor ?? data.max_cursor ?? 0),
      items,
    };
  }

  /** 测试连通性与登录态。 */
  async testConnection(): Promise<string> {
    this.assertCookie();
    const page = await this.listCollection(0, 3);
    const first = page.items[0];
    return `收藏接口正常：本页 ${page.items.length} 条，has_more=${page.hasMore}` +
      (first ? `，首条: ${String(first.desc || "").slice(0, 20) || first.aweme_id}` : "");
  }

  // ---------- 归一化 ----------

  static normalize(raw: DouyinAwemeRaw, source: SyncItem["source"]): SyncItem | null {
    const id = String(raw.aweme_id ?? "");
    if (!/^\d{6,30}$/.test(id)) return null;
    const desc = String(raw.desc ?? "").trim();
    const images: string[] = [];
    const imgLists = raw.images || raw.image_infos?.images || [];
    for (const img of imgLists) {
      const urls = img?.url_list || [];
      const best = urls[urls.length - 1] || urls[0];
      if (best) images.push(best);
      if (images.length >= 10) break;
    }
    const type: ItemType = images.length > 0 ? "note" : "video";
    const cover =
      raw.video?.cover?.url_list?.[0] ||
      raw.video?.origin_cover?.url_list?.[0] ||
      images[0] ||
      "";
    return {
      id,
      type,
      source,
      title: desc.split("\n")[0].trim() || `抖音_${id}`,
      desc,
      author: String(raw.author?.nickname ?? "").trim(),
      authorId: String(raw.author?.sec_uid ?? "").trim(),
      createTime: Number(raw.create_time ?? 0),
      playUrl: noWatermark(raw.video?.play_addr?.url_list?.[0] ?? ""),
      coverUrl: cover,
      imageUrls: images,
      durationSec: Math.round(Number(raw.video?.duration ?? 0) / 1000),
      stats: {
        likes: Number(raw.statistics?.digg_count ?? 0),
        comments: Number(raw.statistics?.comment_count ?? 0),
        collects: Number(raw.statistics?.collect_count ?? 0),
        shares: Number(raw.statistics?.share_count ?? 0),
      },
    };
  }
}
