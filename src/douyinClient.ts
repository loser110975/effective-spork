import { requestUrl, RequestUrlParam, RequestUrlResponse } from "obsidian";
import { DouyinAwemeRaw, DouyinPage, SyncItem, ItemType } from "./types";
import { noWatermark, DOUYIN_UA } from "./util";
import { classifyItemType } from "./itemType";

/**
 * 抖音 Web API 客户端。
 *
 * 签名策略：与旧工具（douyin-favorites-to-knowledge，2026-09 前持续可用）一致，
 * 对收藏/喜欢列表端点不做 a_bogus 签名，仅携带完整 Cookie + 浏览器 UA + Referer。
 * 若抖音后续强制签名，请求会返回 status_code != 0 / HTTP 403，
 * "测试连接"命令会把服务器原始响应展示出来便于诊断。
 */

const UA = DOUYIN_UA;

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

/**
 * 收藏夹接口是否已被抖音下线（2026-10-01 桥接实测：/aweme/v1/web/collection/* 整个子树
 * 对 GET/POST 一律返回 404 "Unsupported path(Janus)"，list 与 item/list 双双失效；
 * listcollection / favorite / post 端点正常）。判定依据是 listFolders / listFolderItems
 * 抛出的错误文本；调用方据此把「收藏夹模式失败」从 error 降级为 notice（扁平兜底已覆盖全部收藏）。
 */
export function isFolderApiUnavailableError(msg: string): boolean {
  return /HTTP 404|Unsupported path/i.test(String(msg ?? ""));
}

/**
 * 生效的请求头档位记忆（问题 7）：跨实例保留。
 * 每次重建 DouyinClient 都从 0 开始重试会重复「全套头→最小集」的降级链路，
 * 模块级记忆让后续实例直接从上一次成功的档位发起。
 * 写入带单调约束（复审 P2）：并发请求用旧档成功时不得把已回升的档位再降回去——
 * 「末者胜」会让试探刚回升到全套头、记忆又被并发的旧档成功写回最小头档。
 */
let rememberedVariant = 0;
/** 全套头试探标记（模块级）：全会话只在「确证被拒」后停止试探；瞬时网络异常不烧掉机会（复审 P2）。 */
let probedFullHeaders = false;
/** 本会话试探是否验证过全套头可用（复审 P2）：验证过之后，旧档并发成功不再允许把记忆档降回去。 */
let probeSucceeded = false;
/** 进行中的试探（复审 P2）：并发请求共享同一次试探，不再各发各的。 */
let probeInFlight: Promise<{ ok: boolean; res?: RequestUrlResponse }> | null = null;

export class DouyinClient {
  /** 生效的请求头档位：0=全套（含 sec-ch-ua/sec-fetch） 1=无指纹头 2=最小集（UA+Cookie）。 */
  private variant = rememberedVariant;

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
        // P3-3（第十轮）：显式超时对齐桥端最坏恢复路径（探活 10s + evaluate 60s + reload 30s
        // + 重试 60s ≈ 160s）。默认 ~30s 会在页面挂死恢复窗口内先超时，触发无谓的 spawnBridge
        // 探测 + 同 URL 重复入队（桥内 enqueue 无深度限制，原任务完成后重复执行一次）。
        // 类型断言同 ai.ts：obsidian 的 RequestUrlParam 未声明 timeout 字段
        timeout: 180_000,
        throw: false,
      } as RequestUrlParam & { timeout: number });
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
    // 全套头试探（2026-09-27 修）：跨实例记忆可能把档位钉死在降级档，而那次降级可能只是一次
    // 瞬时网络故障——每个会话首个直连请求先试一次全套头，成功则恢复完整指纹，失败仍回退记忆档。
    // 试探拿到 4xx（如风控 403）时不直接采信（回归审查 #10）：那正是当初降级的原因，应回落记忆档。
    // 复审 P2：试探改共享单飞 Promise——并发请求不再各发各的试探；瞬时网络异常不再烧掉
    // 全会话唯一一次回升机会（只有拿到确定响应才标记试探结束）。
    if (!probedFullHeaders && start > 0) {
      const owner = !probeInFlight;
      if (!probeInFlight) {
        const p = (async (): Promise<{ ok: boolean; res?: RequestUrlResponse }> => {
          try {
            const res = await requestUrl({ ...opts, headers: variants[0], throw: false } as RequestUrlParam);
            if (res.status < 400) {
              rememberedVariant = 0; // 单调回升
              probedFullHeaders = true;
              probeSucceeded = true;
              return { ok: true, res };
            }
            probedFullHeaders = true; // 4xx 确证被拒，全会话不再试探
            return { ok: false };
          } catch {
            return { ok: false }; // 瞬时网络异常：保留后续试探机会
          }
        })();
        p.finally(() => {
          probeInFlight = null;
        });
        probeInFlight = p;
      }
      const probed = await probeInFlight;
      if (probed.ok && probed.res) {
        this.variant = 0;
        // 仅试探发起者能复用试探响应（并发等待者的 opts 不同，复用会串数据）
        if (owner) return probed.res;
        try {
          return await requestUrl({ ...opts, headers: variants[0], throw: false } as RequestUrlParam);
        } catch (e) {
          // 全套头试探刚成功仍可能瞬时网络异常（第六轮）：不直接抛出冲出 req()，
          // 落入下方降档循环走完整重试（原实现绕过了「失败自动降档」契约）
        }
      }
    }
    let lastErr: unknown = null;
    for (let i = start; i < variants.length; i++) {
      try {
        const res = await requestUrl({ ...opts, headers: variants[i], throw: false } as RequestUrlParam);
        this.variant = i;
        // 记忆写入（复审 P2）：升级恒可写；降级只在「本会话还没验证过全套头可用」时写——
        // 试探刚回升到 0 后，并发旧档请求的成功不得把记忆降回去（全套头本会话已证明可用）
        if (i < rememberedVariant || !probeSucceeded) rememberedVariant = i;
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
    // 桥接模式跳过（第九轮 C3）：/req 由真实浏览器上下文自带登录态发请求，插件 Cookie 不参与。
    // 原实现无条件强制校验，与设置页文案「桥接模式下此项仅用于直连回退」直接冲突——
    // 照文案操作（桥接模式不填 Cookie）的用户同步/测试连接全部硬报缺 sessionid
    if (this.bridgeUrl) return;
    if (!this.cookie || !/sessionid/.test(this.cookie)) {
      throw new Error("Cookie 未配置或缺少 sessionid（请从浏览器 Network 面板复制完整 Cookie；桥接模式下可留空）");
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

  /** 收藏夹列表（ folders）。循环翻页聚合（复审 P2）：原实现单页截断，超页收藏夹静默丢失。 */
  async listFolders(cursor = 0, count = 20): Promise<CollectionFolder[]> {
    this.assertCookie();
    const out: CollectionFolder[] = [];
    let cur = cursor;
    for (let page = 0; page < 50; page++) {
      const url = `https://www.douyin.com/aweme/v1/web/collection/list/?${this.qs({
        count: String(count),
        cursor: String(cur),
      })}`;
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
      for (const c of rawList) {
        const id = String(c?.collection_id ?? c?.collect_id ?? c?.id ?? "");
        const name = String(c?.collect_name ?? c?.collection_name ?? c?.name ?? "").trim();
        if (id && name) out.push({ id, name });
      }
      if (!data.has_more || rawList.length === 0) break;
      cur = Number(data.cursor ?? cur + count);
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
    // 类型明确区分：is_note / aweme_type 显式信号优先，「有图即图文」作回退
    const awemeType = typeof raw.aweme_type === "number" ? raw.aweme_type : undefined;
    const mediaType = typeof raw.media_type === "number" ? raw.media_type : undefined;
    const type: ItemType = classifyItemType({
      hasImages: images.length > 0,
      isNote: raw.is_note === true,
      awemeType,
    });
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
      awemeType,
      mediaType,
      stats: {
        likes: Number(raw.statistics?.digg_count ?? 0),
        comments: Number(raw.statistics?.comment_count ?? 0),
        collects: Number(raw.statistics?.collect_count ?? 0),
        shares: Number(raw.statistics?.share_count ?? 0),
      },
    };
  }
}
