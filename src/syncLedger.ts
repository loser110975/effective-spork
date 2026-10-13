// syncLedger.ts — 从 syncEngine（P1-1）拆出的台账 / 基础设施块：
// ① ASR 重试簿记（enqueue/bump/clear，性能治理 P1）；② 转写结果暂存（B3/F7）；
// ③ data.json 落盘节流（markStateDirty/flushState，含 flushTimer 主动定时器与
//    window/globalThis 兼容——此处曾出过回归，见方法内注释，改动前先逐行对照）；
// ④ id → 笔记路径反向索引与三层兜底定位（问题 8 / 第九轮 A6）。
// SyncEngine 保留编排职责并持有 ledger 实例；台账本体（state）由 ledger 持有，
// SyncEngine 经 getter/setter 透传（loadState/resetState 的整体替换语义不变）。
import { App, TFile, normalizePath } from "obsidian";
import type { DouyinSyncSettings } from "./types/settings";
import type { SyncState } from "./types/state";
import type { AsrResult } from "./types/asr";
import { nowIso } from "./util";

/**
 * ledger 对宿主（SyncEngine）的晚绑定视图：app / settings / onStateChange 一律经由 getter
 * 每次现读——测试与运行时会直接替换引擎实例属性（engine.app = … / engine.onStateChange = …），
 * 若在构造期捕获值，替换后的引用对 ledger 不可见（回归护栏：sync-engine.test.mjs 落盘失败
 * 重标脏、round9-fixes.test.mjs findNotePath frontmatter 兜底均依赖此晚绑定）。
 */
export interface SyncLedgerHost {
  readonly app: App;
  readonly settings: DouyinSyncSettings;
  readonly onStateChange: () => Promise<void>;
}

/** 落盘节流阈值（性能治理 P0-2）：每处理 N 条、或距上次落盘超过 T 毫秒，才真正写一次 data.json。 */
const FLUSH_EVERY_OPS = 10;
const FLUSH_EVERY_MS = 30_000;

/**
 * ASR 重试退避阶梯（性能治理 P1，单位毫秒）：第 n 次失败后要等 BACKOFF[n] 才能再试。
 * 原实现每次同步开头无差别重试全部失败条目，且条间只 sleep(1000)，
 * 对「地址已失效 / CDN 持续拒绝」这类永久失败等于无限空转。
 */
const ASR_RETRY_BACKOFF_MS = [0, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 6 * 3_600_000];
/** 连续失败达到该次数 → 转入 dead-letter，不再自动重试。 */
export const ASR_RETRY_MAX = ASR_RETRY_BACKOFF_MS.length;

export class SyncLedger {
  /** 同步台账本体（data.json 的 state 段）。SyncEngine 经 getter/setter 透传此字段。 */
  state: SyncState;
  /** id → 笔记路径反向索引（问题 8：替代每次重试的全 vault O(n) 扫描），懒建 + 存在性校验。 */
  private noteIndex: Map<string, string> | null = null;
  // ---------- 落盘节流（性能治理 P0-2）----------
  // 现状问题：processItem 每条都 await saveState()，而 data.json 全量约 689KB（含 Cookie 与全部台账），
  // 681 条 ≈ 458MB 累计写盘，且随台账增长呈 O(n²) 恶化。
  // 策略：普通进度点只标脏，累计 FLUSH_EVERY_OPS 条或距上次落盘超过 FLUSH_EVERY_MS 才真正写盘；
  // 同步结束 / 异常 / resetState 等关键节点仍强制落盘，保证状态不丢。
  dirty = false;
  private opsSinceFlush = 0;
  private lastFlushAt = Date.now();
  private flushInFlight: Promise<void> | null = null;
  /** 主动落盘定时器（2026-09-27 第四轮）：节流的时间阈值是被动检查，长阶段（转写/摘要）
   *  期间无人调 markStateDirty 时，脏窗口会被拉长到整个阻塞期，崩溃丢整段进度。 */
  private flushTimer: number | null = null;

  constructor(
    private host: SyncLedgerHost,
    state: SyncState,
  ) {
    this.state = state;
  }

  /** 台账整体替换（loadState / resetState 调用）→ 反向索引失效，待懒建。 */
  invalidateNoteIndex(): void {
    this.noteIndex = null;
  }

  /**
   * 标记进度已变更（节流路径）。绝大多数「处理完一条」的场景用这个，不要直接 await saveState()。
   * 达到条数阈值或时间阈值时异步触发落盘（fire-and-forget，不阻塞处理流水线）。
   */
  markStateDirty() {
    this.dirty = true;
    this.opsSinceFlush++;
    if (this.opsSinceFlush >= FLUSH_EVERY_OPS || Date.now() - this.lastFlushAt >= FLUSH_EVERY_MS) {
      void this.flushState();
      return;
    }
    // 主动定时器（2026-09-27 第四轮）：时间阈值原是被动检查——连续 9 条处理后进入一条
    // 5-10 分钟的转写/摘要长任务，期间无人调 markStateDirty，30s 阈值不会触发，
    // 崩溃丢整段进度（含已计费转写）。定时器保证脏窗口不超过 FLUSH_EVERY_MS。
    if (this.flushTimer === null) {
      // window/globalThis 兼容（第六轮）：定时器逻辑要能在 Node 单测环境跑（obsidian 是
      // Electron 渲染层有 window，node 里只有 globalThis）
      const g: { setTimeout: (fn: () => void, ms: number) => number; clearTimeout: (t: number) => void } =
        typeof window !== "undefined" ? window : (globalThis as unknown as { setTimeout: (fn: () => void, ms: number) => number; clearTimeout: (t: number) => void });
      this.flushTimer = g.setTimeout(() => {
        this.flushTimer = null;
        if (this.dirty) void this.flushState();
      }, FLUSH_EVERY_MS);
    }
  }

  /**
   * 立即落盘（关键节点：同步结束、异常退出、重置台账、插件卸载）。
   * 并发调用串行排队，落盘失败时重新标脏，由下一次落盘补写，避免状态丢失。
   */
  async flushState(): Promise<void> {
    while (this.flushInFlight) await this.flushInFlight;
    if (!this.dirty) return;
    this.dirty = false;
    this.opsSinceFlush = 0;
    this.lastFlushAt = Date.now();
    if (this.flushTimer !== null) {
      (typeof window !== "undefined" ? window : (globalThis as unknown as { clearTimeout: (t: number) => void })).clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const p = this.host.onStateChange().catch(() => {
      this.dirty = true; // 写盘失败 → 重新标脏，下一次补写
    });
    this.flushInFlight = p;
    try {
      await p;
    } finally {
      if (this.flushInFlight === p) this.flushInFlight = null;
    }
  }

  /** 强制落盘（保持原有调用语义；resetState / 同步收尾等关键节点使用）。 */
  async saveState() {
    this.dirty = true;
    await this.flushState();
  }

  /** 插件卸载前落盘（onunload 调用）：避免节流窗口内的进度丢失。 */
  flushNow(): Promise<void> {
    this.dirty = true;
    return this.flushState();
  }

  /** 反向索引懒建（问题 8）：从 processed 台账一次性装载 id → path。 */
  noteIndexGet(): Map<string, string> {
    if (!this.noteIndex) {
      const m = new Map<string, string>();
      for (const [id, entry] of Object.entries(this.state.processed)) {
        if (entry?.path) m.set(id, entry.path);
      }
      this.noteIndex = m;
    }
    return this.noteIndex;
  }

  /** 在 vault 中按 ID 定位当前笔记路径（文件可能被分类回填等外部操作移动过）。
   *  问题 8：先查反向索引（O(1)，含存在性校验），未命中才回退全量扫描并回填索引。 */
  findNotePath(id: string): string | null {
    const suffix = `[${id}].md`;
    const root = this.host.settings.rootFolder + "/";
    // ① 索引命中且文件仍在原位 → 直接返回
    const cached = this.noteIndexGet().get(id);
    if (cached) {
      const f = this.host.app.vault.getAbstractFileByPath(normalizePath(cached));
      if (f instanceof TFile && f.name.endsWith(suffix)) return cached;
      this.noteIndexGet().delete(id); // 索引过期（外部移动 /删除），回退扫描
    }
    // ② 全量扫描兜底；多份时优先取非「未分类」目录的副本
    let found: string | null = null;
    for (const f of this.host.app.vault.getFiles()) {
      if (f.name.endsWith(suffix) && f.path.startsWith(root)) {
        if (!found || (found.includes("未分类") && !f.path.includes("未分类"))) found = f.path;
      }
    }
    if (found) {
      this.noteIndexGet().set(id, found);
      return found;
    }
    // ③ douyin_id frontmatter 兜底（第九轮 A6 配套）：文件被用户改名后文件名后缀失配，
    // 仍能按 frontmatter 定位——否则重试路径会误判「已删除」而结清重试队列。
    // metadataCache 不可用（测试替身/极端宿主）时跳过，按未找到处理。
    try {
      const cache = (this.host.app as any).metadataCache;
      const files = this.host.app.vault.getMarkdownFiles?.();
      if (cache && typeof cache.getFileCache === "function" && Array.isArray(files)) {
        for (const f of files) {
          const fm = cache.getFileCache(f)?.frontmatter;
          if (fm && String(fm.douyin_id ?? "") === id) {
            this.noteIndexGet().set(id, f.path);
            return f.path;
          }
        }
      }
    } catch {
      /* 缓存不可用时按未找到处理 */
    }
    return found;
  }

  // ---------- ASR 重试台账（性能治理 P1）----------

  /** 失败入队：登记待重试 id 与重试台账（首次 attempts=0，立即可试）。 */
  enqueueAsrRetry(id: string, error: string): void {
    if (!this.state.pendingAsr.includes(id)) this.state.pendingAsr.push(id);
    if (!this.state.asrRetry) this.state.asrRetry = {};
    if (this.state.asrRetry[id]) {
      this.bumpAsrRetry(id, error);
      return;
    }
    this.state.asrRetry[id] = {
      attempts: 0,
      lastError: error.slice(0, 200),
      nextRetryAt: new Date(Date.now() + ASR_RETRY_BACKOFF_MS[0]).toISOString(),
    };
  }

  /** 记一次重试失败：次数 +1，按阶梯设置下次可重试时间；达上限标记 dead（不再自动重试）。 */
  bumpAsrRetry(id: string, error: string): void {
    if (!this.state.asrRetry) this.state.asrRetry = {};
    const attempts = (this.state.asrRetry[id]?.attempts ?? 0) + 1;
    const idx = Math.min(attempts, ASR_RETRY_BACKOFF_MS.length - 1);
    this.state.asrRetry[id] = {
      attempts,
      lastError: error.slice(0, 200),
      nextRetryAt: new Date(Date.now() + ASR_RETRY_BACKOFF_MS[idx]).toISOString(),
      dead: attempts >= ASR_RETRY_MAX,
    };
  }

  /** 结清：移出待重试队列并删除台账（转写成功 / 确认无语音 / 条目已失效）。 */
  clearAsrRetry(id: string): void {
    this.state.pendingAsr = this.state.pendingAsr.filter((x) => x !== id);
    if (this.state.asrRetry) delete this.state.asrRetry[id];
  }

  // ---------- 转写结果暂存（第九轮 B3：防「转写成功但写笔记失败」重复计费） ----------

  /** 转写成功即暂存（FIFO ≤20 条防 data.json 膨胀）；写笔记成功后由 finalizeProcessed 清除。 */
  stashTranscript(id: string, asr: AsrResult): void {
    if (!asr.transcript) return;
    const c = (this.state.transcriptCache ??= {});
    c[id] = { transcript: asr.transcript, provider: asr.provider ?? "", at: nowIso() };
    const keys = Object.keys(c);
    if (keys.length > 20) {
      keys.sort((a, b) => (Date.parse(c[a].at) || 0) - (Date.parse(c[b].at) || 0));
      for (const k of keys.slice(0, keys.length - 20)) delete c[k];
    }
  }

  /** 查暂存（只窥不取：写笔记成功才算消耗，失败保留下轮再用）。
   *  F7（第十轮）：供应商不匹配的暂存视为过期并删除——用户切换 ASR 供应商（如对旧供应商
   *  转录质量不满）后期望按新供应商重转，暂存抢先落账会让该条目永不重转（连重置台账都
   *  绕不开，resetState 保留暂存）。宁可重付一次转录费，不交付违背当前配置的结果。
   *  provider 名与 settings.asrProvider 同名；dashscope_qwen3 的成功结果用子模型名（qwen3-*），
   *  按前缀识别。provider 为空（loadState 消毒前的旧数据）按不匹配处理。 */
  peekStashedTranscript(id: string): AsrResult | null {
    const e = this.state.transcriptCache?.[id];
    if (!e?.transcript) return null;
    const want = this.host.settings.asrProvider;
    const got = e.provider;
    // 第十轮复审批：paraformer 通道的成功结果 provider 是子模型名（"paraformer-v2" /
    // 兜底 "fun-asr-mtl"，见 asr/dashscope.ts collectResult 的 provider: model ?? this.name），
    // 与 want="dashscope_paraformer" 严格不等——缺这条前缀规则的话，B3 暂存保护对该通道
    // 整体失效（暂存条目每次被 F7 判不匹配删除、下轮重新计费，恰是 F7 要防的对侧）。
    const providerMatched =
      !!got &&
      (got === want ||
        (want === "dashscope_qwen3" && /^qwen3/i.test(got)) ||
        (want === "dashscope_paraformer" && /^(paraformer|fun-asr)/i.test(got)));
    if (!providerMatched) {
      delete this.state.transcriptCache![id];
      return null;
    }
    return { status: "success", transcript: e.transcript, provider: got || "cached" };
  }
}
