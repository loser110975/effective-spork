// embeddingService.ts — 语义向量基础设施（批次三，2026-10-16）。
// 三件套：
// ① EmbeddingClient：OpenAI 兼容 /embeddings 客户端（默认百炼 compatible-mode + text-embedding-v4），
//    429/5xx 退避节奏与 AiClient 同款；v4 单请求 input 上限 10 条，embed() 自动按批切分。
// ② 纯函数：cosineSim / cosineTopK（内存余弦扫描 + 相似度门槛）/ contentHash（双 seed FNV-1a）。
// ③ VectorStore：向量落盘（<pluginDir>/vectors.json，Float32Array→base64 紧凑存储），
//    按 douyin_id 索引 + contentHash 增量（正文没变不重算不重付）；model 变更一键全量重置。
//
// 规模依据（2026-10-16 库存）：全库 ~1100 篇 × 1024 维 Float32 ≈ 4.4MB（base64 ≈ 5.9MB），
// 全量内存余弦扫描 1100 次 1024 维点积 < 5ms——不需要任何向量库，一个 Map + 一次遍历就是最优解。
// 存储写入复用 pluginStorage 的窄适配器口径（KvAdapter），Node 单测注入内存实现，全程不触网。
import type { KvAdapter } from "./pluginStorage";
import { requestUrl, type RequestUrlParam } from "obsidian";
import { sleep } from "./util";

/** v4 系列单请求 input 上限（OpenAI 兼容 /embeddings 批量约束），客户端按此切批。 */
export const EMBED_BATCH_SIZE = 10;
/** 429 限流退避（与 AiClient 同节奏）。 */
const RATE_LIMIT_BACKOFF_MS = [5_000, 15_000, 30_000];
/** 5xx 服务端过载退避（与 AiClient 同节奏）。 */
const SERVER_BUSY_BACKOFF_MS = [3_000, 10_000, 20_000];

/** OpenAI 兼容 /embeddings 客户端（百炼 compatible-mode / 硅基流动 / OpenAI 等）。 */
export class EmbeddingClient {
  constructor(
    private readonly baseUrl: string,
    private readonly key: string,
    private readonly model: string,
  ) {
    this.baseUrl = (baseUrl ?? "").trim();
    this.key = (key ?? "").trim();
    this.model = (model ?? "").trim();
  }

  private endpoint(): string {
    const base = this.baseUrl.replace(/\/+$/, "");
    return /\/embeddings$/.test(base) ? base : `${base}/embeddings`;
  }

  /**
   * 单批（≤EMBED_BATCH_SIZE 条）向量化；429/5xx 退避重试后仍失败抛错（调用方决定回落/终止）。
   * 返回向量数组与 inputs 顺序严格一一对应（OpenAI 兼容契约）。
   */
  async embedBatch(inputs: string[]): Promise<number[][]> {
    if (inputs.length === 0) return [];
    if (inputs.length > EMBED_BATCH_SIZE) {
      throw new Error(`embedBatch 单批最多 ${EMBED_BATCH_SIZE} 条，收到 ${inputs.length}（请走 embed() 自动切批）`);
    }
    let attempt = 0;
    let busyAttempt = 0;
    for (;;) {
      let res;
      try {
        res = await requestUrl({
          url: this.endpoint(),
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.key}` },
          body: JSON.stringify({ model: this.model, input: inputs }),
          throw: false,
          timeout: 60_000,
        } as RequestUrlParam & { timeout: number });
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        if (/timed?\s*out|timeout|abort/i.test(msg)) {
          if (busyAttempt++ < 1) {
            await sleep(3_000);
            continue;
          }
          throw new Error(`embedding 请求超时（重试 1 次后仍超时）：${msg.slice(0, 120)}`);
        }
        throw e;
      }
      if (res.status === 429 && attempt < RATE_LIMIT_BACKOFF_MS.length) {
        await sleep(RATE_LIMIT_BACKOFF_MS[attempt++]);
        continue;
      }
      if (res.status >= 500 && busyAttempt < SERVER_BUSY_BACKOFF_MS.length) {
        await sleep(SERVER_BUSY_BACKOFF_MS[busyAttempt++]);
        continue;
      }
      if (res.status >= 300) {
        throw new Error(`embedding HTTP ${res.status}: ${res.text.slice(0, 200)}`);
      }
      let data: any;
      try {
        data = res.json;
      } catch {
        throw new Error(`embedding 响应非 JSON（HTTP ${res.status}）：${res.text.slice(0, 120)}`);
      }
      const rows: any[] = data?.data;
      if (!Array.isArray(rows) || rows.length !== inputs.length) {
        throw new Error(`embedding 返回条数不匹配（期望 ${inputs.length}，实际 ${Array.isArray(rows) ? rows.length : "无 data"}）`);
      }
      // 按 index 归位（兼容不保证顺序的兼容层）；index 缺失时按原顺序放置，inputs.map 直接对位
      const byIndex = new Map<number, number[]>();
      for (let i = 0; i < rows.length; i++) {
        const vec = rows[i]?.embedding;
        if (!Array.isArray(vec) || vec.length === 0) {
          throw new Error(`embedding 返回第 ${i} 条向量为空`);
        }
        byIndex.set(typeof rows[i].index === "number" ? rows[i].index : i, vec as number[]);
      }
      return inputs.map((_, i) => byIndex.get(i)!);
    }
  }

  /** 任意长度输入：按 EMBED_BATCH_SIZE 切批顺序调用；单批失败即整体抛错（索引构建里按批记进度，失败批不落库）。 */
  async embed(inputs: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < inputs.length; i += EMBED_BATCH_SIZE) {
      out.push(...(await this.embedBatch(inputs.slice(i, i + EMBED_BATCH_SIZE))));
    }
    return out;
  }

  /** 单条向量化；失败返回 null（互链/搜索路径用它做「失败即回落」的软调用）。 */
  async embedOne(text: string): Promise<number[] | null> {
    try {
      return (await this.embedBatch([text]))[0] ?? null;
    } catch {
      return null;
    }
  }
}

/** 余弦相似度；零向量（范数 0）按 0 处理，不产生 NaN。 */
export function cosineSim(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

/** 一条命中：douyin_id + 相似度分。 */
export interface VectorHit {
  id: string;
  score: number;
}

/**
 * 内存余弦 topK：遍历条目计算相似度 → 过滤 minScore 门槛 → 降序取前 k。
 * entries 收 Iterable<[id, vec]>（Map 直接兼容；带载荷的表传 entries 视图，避免复制向量）。
 * 同分按 id 字典序尾序（与 pickRelatedLinks 的确定性尾序同哲学，保证重复执行产出一致）。
 */
export function cosineTopK(
  query: ArrayLike<number>,
  entries: Iterable<[string, ArrayLike<number>]>,
  k: number,
  minScore = 0.3,
): VectorHit[] {
  const cap = Math.max(0, Math.floor(Number(k) || 0));
  if (cap === 0) return [];
  const hits: VectorHit[] = [];
  for (const [id, vec] of entries) {
    const score = cosineSim(query, vec);
    if (score >= minScore) hits.push({ id, score });
  }
  hits.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return hits.slice(0, cap);
}

/**
 * 双 seed FNV-1a 内容指纹（16 hex）：仅用于「正文变没变」的增量判定，
 * 碰撞后果最多漏一次重算，32bit 双遍足够且比完整 SHA 快一个量级。
 */
export function contentHash(text: string): string {
  const s = String(text ?? "");
  const fnv = (seed: number): number => {
    let h = seed >>> 0;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  };
  const a = fnv(0x811c9dc5);
  const b = fnv(0x01935271);
  return (a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0"));
}

// ---------- Float32Array ↔ base64（向量紧凑落盘） ----------

export function f32ToB64(v: Float32Array): string {
  const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  let s = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)) as unknown as number[]);
  }
  return btoa(s);
}

export function b64ToF32(s: string): Float32Array {
  const bin = atob(String(s ?? ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

// ---------- VectorStore（向量落盘 + 增量） ----------

export const VECTOR_FILE = "vectors.json";

interface VectorFilePayload {
  model: string;
  dim: number;
  vectors: Record<string, { h: string; v: string }>;
}

/** 向量库：load 懒加载（首次访问读盘）、persist 原子写（.tmp + rename，口径同 PluginFileStore）。 */
export class VectorStore {
  /** id → { 内容指纹, 向量 }。 */
  private table = new Map<string, { h: string; v: Float32Array }>();
  private model = "";
  private dim = 0;
  private loadPromise: Promise<void> | null = null;

  constructor(
    private readonly adapter: KvAdapter,
    private readonly dir: string,
  ) {}

  private path(): string {
    return `${this.dir}/${VECTOR_FILE}`.replace(/\/{2,}/g, "/");
  }

  /** 懒加载（幂等，并发调用合并为一次读盘）；missing / corrupt 都按空库起步。 */
  async ensureLoaded(): Promise<void> {
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = (async () => {
      try {
        if (!(await this.adapter.exists(this.path()))) return;
        const payload = JSON.parse(await this.adapter.read(this.path())) as VectorFilePayload;
        if (!payload || typeof payload !== "object" || typeof payload.vectors !== "object" || !payload.vectors) return;
        this.model = String(payload.model ?? "");
        this.dim = Number(payload.dim) || 0;
        for (const [id, rec] of Object.entries(payload.vectors)) {
          if (!rec || typeof rec.h !== "string" || typeof rec.v !== "string") continue;
          try {
            this.table.set(id, { h: rec.h, v: b64ToF32(rec.v) });
          } catch {
            /* 单条损坏跳过（base64 非法），不影响其余向量 */
          }
        }
      } catch {
        /* 读盘失败按空库起步：最多触发一轮全量重算，绝不打断同步主流程 */
      }
    })();
    return this.loadPromise;
  }

  /** 原子落盘：write(.tmp) → rename 覆盖（个别实现 rename 不覆盖时 remove 后重试一次）。 */
  async persist(): Promise<void> {
    const p = this.path();
    const tmp = `${p}.tmp`;
    const payload: VectorFilePayload = { model: this.model, dim: this.dim, vectors: {} };
    for (const [id, rec] of this.table) {
      payload.vectors[id] = { h: rec.h, v: f32ToB64(rec.v) };
    }
    await this.adapter.write(tmp, JSON.stringify(payload));
    try {
      await this.adapter.rename(tmp, p);
    } catch {
      if (await this.adapter.exists(p)) await this.adapter.remove(p);
      await this.adapter.rename(tmp, p);
    }
  }

  /** 当前落盘模型名是否等于期望模型（false = 调用方应 resetForModel 全量重算）。 */
  isModel(model: string): boolean {
    return this.model === (model ?? "").trim();
  }

  /** 换模型（或首次）：清空全表换标——旧维度向量对新模型查询毫无意义，增量逻辑必须整体作废。 */
  resetForModel(model: string): void {
    this.table.clear();
    this.model = (model ?? "").trim();
  }

  get(id: string): { h: string; v: Float32Array } | undefined {
    return this.table.get(id);
  }

  set(id: string, hash: string, vec: Float32Array): void {
    if (!this.dim) this.dim = vec.length;
    this.table.set(id, { h: hash, v: vec });
  }

  delete(id: string): void {
    this.table.delete(id);
  }

  /** 清掉不在 keep 集合里的孤儿向量（笔记已删/台账已清）。 */
  pruneExcept(keep: Set<string>): number {
    let removed = 0;
    for (const id of [...this.table.keys()]) {
      if (!keep.has(id)) {
        this.table.delete(id);
        removed++;
      }
    }
    return removed;
  }

  size(): number {
    return this.table.size;
  }

  /** 以 query 向量做余弦 topK（封装内部表，调用方不接触 Map 本体）。 */
  topKFor(query: ArrayLike<number>, k: number, minScore = 0.3): VectorHit[] {
    const entries: Array<[string, ArrayLike<number>]> = [];
    for (const [id, rec] of this.table) entries.push([id, rec.v]);
    return cosineTopK(query, entries, k, minScore);
  }
}
