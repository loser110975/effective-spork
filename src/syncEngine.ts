import { App, Notice, TFile, normalizePath } from "obsidian";
import { DouyinClient, isFolderApiUnavailableError } from "./douyinClient";
import { createAsrProvider } from "./asr";
import { AiClient } from "./ai";
import { resolveAiChannel, resolveVisionChannel, resolveVideoSummaryChannel, resolveEmbeddingChannel, isQuotaExhaustedError } from "./aiConfig";
import { MediaStore } from "./media";
import { VideoMediaStore, VideoAssets, isDeterministicMediaError, type MediaErrorKind } from "./videoMedia";
import { generateBases } from "./bases";
import { buildNote, planNotePath } from "./noteBuilder";
import { generateAndWriteVideoSummary, listVideoFramePaths } from "./videoSummaryService";
import { extractSummarySources, collectExistingAssets, applySummaryToNote, frontmatterBlock, pushSummaryRecord, upsertOcrRowsToCallout, upsertFmScalar, type ReusedNoteAssets } from "./statusCore";
import { ensureFolder } from "./media";
import { applyRelatedToNote, buildRelatedBlock, pickRelatedLinks, type RelatedCandidate, type RelatedLink } from "./relatedNotes";
import type { DouyinSyncSettings } from "./types/settings";
import type { SyncState } from "./types/state";
import type { SyncItem, DouyinAwemeRaw, ItemSource } from "./types/domain";
import { SOURCE_LABEL } from "./types/domain";
import type { AsrResult } from "./types/asr";
import type { StageTimings } from "./types/state";
import { nowIso, parseList, noteTitleFor, sleep, sliceByCodePoints } from "./util";
import { isAudioOnlyItem, AUDIO_ONLY_REASON } from "./itemType";
import { clampConcurrency, mapLimit, Semaphore } from "./concurrency";
import { detailStageTimings, summarizeStageTimings, StageTimer } from "./perf";
import { SyncLedger, ASR_RETRY_MAX } from "./syncLedger";
import { EmbeddingClient, VectorStore, contentHash, type VectorHit } from "./embeddingService";
// P2-2：确定性失败正则迁至 asr/failureKind.ts 供 provider 与引擎共用（正则文本逐字未动，仍为兜底）
import { DETERMINISTIC_ASR_FAILURE_RE } from "./asr/failureKind";

export interface SyncSummary {
  total: number;
  created: number;
  skipped: number;
  transcribed: number;
  asrFailed: number;
  /** 因「无视频轨」等结构性原因跳过转写的条数（不计入失败） */
  asrSkipped: number;
  visionOk: number;
  videoSummaries: number;
  /** 强制重抽帧条数（forceFrameResync 置位轮）：本轮按强制意图重抽的视频数 */
  forcedFrameResync: number;
  errors: string[];
  /** 提示性信息（2026-09-27 自 errors 拆出）：Bases 已生成 / 重试延后等，观感不像报错 */
  notices: string[];
  startedAt: string;
  finishedAt: string;
}

/** 补录链单轮计数出参（批次二 G）：backfillVision / backfillVideos 的可选 out 参数，
 *  供 backfillAll 循环终止判定与累计统计；返回字符串形态不变，既有调用方零改动。 */
export interface BackfillTally {
  done: number;
  failed: number;
}

// ---------- processItem 管线的阶段产物类型（2026-09-27 第七轮拆分，字段即拆分前的局部变量） ----------

/** 单图 OCR 结果行（recognizeImageTexts → buildNote 的 visionTexts 形状）。 */
interface VisionRow {
  index: number;
  text: string;
  status: string;
}

/** 视频素材阶段产物：assets 供写笔记/摘要用；needAudio 与素材错误类别供转写阶段做失败分类。 */
interface VideoAssetsOutcome {
  assets: VideoAssets | null;
  needAudio: boolean;
  mediaErrorKind: MediaErrorKind;
  mediaPullError: string;
  /** 本次 framePaths 的真实抽帧间隔（秒），0 = 无帧。回写 frame_interval 用（第九轮 A1）。 */
  frameIntervalSec: number;
}

/** 图文图片阶段产物：images 进笔记图片块；localImageByIndex 供 OCR 复用已下载字节（免二次走 CDN）。 */
interface ImageDownloads {
  images: string[];
  localImageByIndex: Map<number, string>;
}

/** 写笔记阶段输入。 */
interface NoteWriteInput {
  item: SyncItem;
  folder: string;
  overwritePath?: string;
  reused: ReusedNoteAssets | null;
  category: string;
  coverPath: string;
  imagesDownloaded: string[];
  visionTexts: VisionRow[];
  asr: AsrResult | null;
  assets: VideoAssets | null;
  /** 本次帧的真实抽帧间隔（秒），0 = 无帧（第九轮 A1：不再盲写当前设置值） */
  frameIntervalSec: number;
}

/**
 * 「确定性失败」特征正则已随 P2-2 迁至 asr/failureKind.ts（DETERMINISTIC_ASR_FAILURE_RE，
 * 本文件 import 使用）；结构化分类字段为 AsrResult.failureKind，正则仍为漏标兜底。
 */

// 落盘节流阈值 / ASR 重试退避阶梯（性能治理 P0-2 / P1）已随 P1-1 拆至 syncLedger.ts
// （FLUSH_EVERY_*、ASR_RETRY_BACKOFF_MS、ASR_RETRY_MAX）。

/** 分阶段耗时样本保留条数（性能埋点 P2-15）：够看分布，又不至于把 data.json 撑大。 */
const RECENT_METRICS = 100;

function newSyncSummary(): SyncSummary {
  return {
    total: 0,
    created: 0,
    skipped: 0,
    transcribed: 0,
    asrFailed: 0,
    asrSkipped: 0,
    visionOk: 0,
    videoSummaries: 0,
    forcedFrameResync: 0,
    errors: [],
    notices: [],
    startedAt: "",
    finishedAt: "",
  };
}

export class SyncEngine {
  /** 台账 / 基础设施（P1-1 拆至 syncLedger.ts）：state 本体、落盘节流、重试簿记、转写暂存、反向索引。 */
  private ledger: SyncLedger;
  /** 台账本体（data.json 的 state 段）：由 SyncLedger 持有，getter/setter 透传——
   *  loadState / resetState 的整体替换与各处 this.state 直接读写语义均不变。 */
  get state(): SyncState {
    return this.ledger.state;
  }
  set state(s: SyncState) {
    this.ledger.state = s;
  }
  /** 落盘脏标记（SyncLedger 透传，测试/诊断读取）。 */
  get dirty(): boolean {
    return this.ledger.dirty;
  }
  running = false;
  private client: DouyinClient;
  private media: MediaStore;
  private videoMedia: VideoMediaStore;
  private ai: AiClient | null = null;
  /** 同步进行中的常驻进度 Notice（任务 4 条目级进度）：syncAll 持有，processItem 完成时原位更新文本 */
  private syncNotice: Notice | null = null;
  /** OCR 专用视觉通道：配了独立基址/Key 时与分类通道分离（实测硅基流动视觉模型会 503 过载） */
  private visionAi: AiClient | null = null;
  /** OCR 全局并发闸门：跨条目统一限流，避免条目级 × 图片级并发把请求放大 9 倍（见 visionConcurrency 说明） */
  private ocrGate: Semaphore | null = null;
  /**
   * embedding 客户端与向量库（批次三语义检索 / 向量互链共用）：
   * - embedClient 按 settings 重建（refreshClients，与 ai/visionAi 同口径——Key 未配置时保持 null）；
   * - vectorStore 与 settings 无关（插件目录固定），由宿主 attachVectorStore 注入（manifest.dir
   *   在引擎里不可得，也不该成为引擎构造签名的一部分）；未注入（旧宿主/测试）时语义功能整体静默缺席，
   *   互链自动回落同分类/同作者打分——零破坏。
   */
  private embedClient: EmbeddingClient | null = null;
  private vectorStore: VectorStore | null = null;
  /**
   * 本次同步的转写预算（2026-09-27 第四轮）：maxTranscribePerSync 此前只约束重试队列，
   * 全新条目的转写完全不受限——首次全量同步 1000 条会一次性烧掉几百条转写费。
   * processItem 的转写分支先扣减本计数，耗尽后条目进 pendingAsr（不 bump attempts），下次同步续传。
   */
  private asrBudgetLeft = 0;
  /** 详情接口串行闸门（2026-09-27 第四轮）：直连模式下 backfill 并发条目各自 getAwemeDetail
   *  会绕开「抖音 API 串行」的风控口径；桥接模式桥内已串行，此闸门仅对直连生效。 */
  private detailGate = new Semaphore(1);
  /**
   * 视频摘要配额熔断（2026-10-01 第十三轮，真实数据驱动）：09-21 补跑实测出现 50 连发相同的
   * 「Free quota exhausted」403——配额耗尽后每条视频照样白打一次调用（summary records 全红），
   * 更贵的是 needFrames 恒真让每条新视频都为「无人消费的帧」白付全片下载 + ffmpeg
   * （该次 metrics：ffmpeg p50 37.8s × 62 条）。会话级熔断：连续 3 次配额类失败后，
   * 本次运行跳过摘要阶段并抑制帧路；每次 syncAll / backfillVideos 开始时复位重新探测
   * （配额可能已恢复；每轮最多付 3 次轻量 403 的探明成本）。
   */
  private videoSummaryQuotaFails = 0;
  private videoSummaryQuotaDead = false;

  /** 桥接拉起函数（refreshClients 重建 DouyinClient 时复用）。 */
  private spawnBridgeFn?: () => Promise<void>;

  constructor(
    private app: App,
    private settings: DouyinSyncSettings,
    private onStateChange: () => Promise<void>,
    private onStatus: (text: string) => void,
    spawnBridge?: () => Promise<void>,
  ) {
    // 台账与基础设施先行创建（P1-1）：loadState / resetState / 各处 this.state 读写都经其透传。
    // host 用 getter 晚绑定 app / settings / onStateChange——测试与运行时会直接替换引擎实例属性，
    // ledger 必须每次现读而非构造期捕获（见 SyncLedgerHost 注释）。
    const self = this;
    this.ledger = new SyncLedger(
      {
        get app() {
          return self.app;
        },
        get settings() {
          return self.settings;
        },
        get onStateChange() {
          return self.onStateChange;
        },
      },
      { processed: {}, pendingAsr: [] },
    );
    this.spawnBridgeFn = spawnBridge;
    this.client = new DouyinClient(
      settings.cookie,
      settings.bridgeEnabled ? settings.bridgeUrl : undefined,
      spawnBridge,
    );
    this.media = new MediaStore(app.vault, settings.mediaFolder);
    this.videoMedia = new VideoMediaStore(app.vault, settings.mediaFolder, settings, this.client);
    this.refreshClients();
  }

  /**
   * 按当前 settings 重建 AI 客户端。
   *
   * 背景（实测踩坑 2026-09-19）：AiClient 原先只在构造函数里创建一次，而 Obsidian 改设置
   * 并不会重载插件 —— 导致「在设置页把 OCR 通道/模型换掉后，本次会话仍用旧客户端」：
   * 用户把 aiBaseUrl 从硅基流动改成百炼后，运行中的插件继续打硅基流动并持续 503，
   * 白白多跑了一轮 832s 的同步。现在每次同步开始前刷新一次，设置改动即时生效。
   */
  refreshClients(): void {
    const s = this.settings;
    // DouyinClient 同样按最新设置重建（2026-09-27 修）：构造时只捕获一次 cookie / bridgeEnabled / bridgeUrl，
    // 用户在设置页换 Cookie 或切换直连/桥接后，不重建的话定时同步仍拿旧值跑——
    // 而「测试连接」每次 new 新客户端会显示成功，形成「测试通过但同步失败」的排查陷阱。
    this.client = new DouyinClient(s.cookie, s.bridgeEnabled ? s.bridgeUrl : undefined, this.spawnBridgeFn);
    this.videoMedia.updateClient(this.client);
    // 媒体目录同样按最新设置重建（2026-09-27 第四轮）：MediaStore/VideoMediaStore 在构造期
    // 快照 mediaFolder，不重建的话改设置后封面/帧仍写旧目录——更糟的是补跑的帧查找用实时
    // settings、入库用旧目录，两处错位让补跑永远找不到帧、每轮白付一次全片下载 + ffmpeg。
    this.media = new MediaStore(this.app.vault, s.mediaFolder);
    this.videoMedia = new VideoMediaStore(this.app.vault, s.mediaFolder, s, this.client);
    this.ai = null;
    this.visionAi = null;
    this.ocrGate = null;
    // 统一接入：Base URL + API Key 由 aiConfig 从 settings 解析（含旧配置回退链）。
    // 配置不完整时此处仍不建客户端（保持原行为），真正发起请求时由 AiClient / 各服务抛出明确配置错误。
    const aiChan = resolveAiChannel(s);
    if (aiChan.apiKey) {
      this.ai = new AiClient(aiChan.baseUrl, aiChan.apiKey, s.aiModel);
      this.ai.setVisionModel(s.visionModel);
      // 超时下调（性能实测）：分类实测 0.2s、单图 base64 OCR 正常 <20s，
      // 默认 120s 只会让失败路径白等两分钟（原 OCR 的 240s 里就有这一项）。
      this.ai.setTimeoutMs(60_000);
    }
    // OCR 视觉通道：独立基址/Key 留空时复用通用 AI 通道。
    // 注意：若配了独立基址却复用主通道 Key，会出现「基址与 Key 不匹配」
    // （例如百炼基址 + 硅基流动 Key → 全部 401）。回退优先级由 resolveVisionChannel 统一维护。
    const vChan = resolveVisionChannel(s);
    if (vChan.apiKey) {
      this.visionAi = new AiClient(vChan.baseUrl, vChan.apiKey, s.aiModel, s.visionModel);
      this.visionAi.setTimeoutMs(60_000);
      this.ocrGate = new Semaphore(clampConcurrency(s.visionConcurrency, 3));
    }
    // embedding 通道（批次三）：与 ai 同口径——Key 未配置不建客户端，语义功能走「未配置」提示；
    // vectorStore 与 settings 无关，不在本方法动（attachVectorStore 注入，manifest.dir 属宿主）。
    const eChan = resolveEmbeddingChannel(s);
    this.embedClient = eChan.apiKey
      ? new EmbeddingClient(eChan.baseUrl, eChan.apiKey, s.embeddingModel)
      : null;
  }

  /** 宿主（main）注入向量库：插件目录在引擎外才可得。重复注入以最后一次为准（幂等）。 */
  attachVectorStore(store: VectorStore): void {
    this.vectorStore = store;
  }

  /** ffmpeg 可用性检测（设置页按钮用）：返回版本首行或 null；force=true 绕过结果缓存重新探测。 */
  checkFfmpeg(force = false): Promise<string | null> {
    return this.videoMedia.checkFfmpeg(force);
  }

  /** onload 即清理上次会话的临时素材残留（P3-2）：懒清理要等首次视频素材拉取，图文-only 用户永不触发。 */
  cleanupTempRoot(): void {
    this.videoMedia.clearTempRoot();
  }

  async loadState(raw: unknown) {
    if (raw && typeof raw === "object") {
      const s = raw as Partial<SyncState>;
      // 台账形状校验（2026-09-27 第四轮）：data.json 手改/旧版本残留可能把 processed 写成
      // 字符串、pendingAsr 写成非数组——原实现只兜 null/undefined，错位类型会在 processItem
      // 的赋值或 syncAll 的 filter 处抛 TypeError，整轮同步异常退出
      const isPlainObject = (v: unknown): v is Record<string, unknown> =>
        !!v && typeof v === "object" && !Array.isArray(v);
      const isStrArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
      this.state = {
        processed: (isPlainObject(s.processed) ? s.processed : {}) as SyncState["processed"],
        pendingAsr: isStrArray(s.pendingAsr) ? s.pendingAsr : [],
        asrRetry: (isPlainObject(s.asrRetry) ? s.asrRetry : {}) as SyncState["asrRetry"],
        // 性能埋点（P2-15）：兼容旧 data.json，缺省给空数组
        metrics: Array.isArray(s.metrics) ? s.metrics : [],
        lastPerfSummary: s.lastPerfSummary,
        lastSyncAt: s.lastSyncAt,
        lastSyncSummary: s.lastSyncSummary,
        // 四项新功能的状态（系统设计 §4.2.3~4.2.5）：兼容旧 data.json（缺省时给默认值）
        processManager: s.processManager ?? {
          bridgePid: -1,
          panelPid: -1,
          treePids: [],
          lastStartAt: null,
          lastStopAt: null,
          lastCommandKey: null,
          lastErrorCode: null,
          updatedAt: null,
        },
        vision: Array.isArray(s.vision) ? s.vision : [],
        summary: Array.isArray(s.summary) ? s.summary : [],
        backfillFails: (isPlainObject(s.backfillFails) ? s.backfillFails : {}) as SyncState["backfillFails"],
        transcriptCache: (isPlainObject(s.transcriptCache) ? s.transcriptCache : {}) as SyncState["transcriptCache"],
      };
      this.ledger.invalidateNoteIndex(); // 台账整体替换 → 反向索引失效，待懒建
      // asrRetry 条目形状消毒（第六轮）：手改 data.json 里 attempts 非数字会让 bumpAsrRetry 的
      // attempts+1 变字符串拼接、BACKOFF[NaN] 变 undefined，new Date(NaN).toISOString() 抛
      // RangeError 冲出 retryPendingAsr 的 catch、中止本轮全部重试（每次同步复现）
      if (this.state.asrRetry) {
        for (const [k, v] of Object.entries(this.state.asrRetry)) {
          const attempts = Number((v as { attempts?: unknown })?.attempts);
          const t = Date.parse(String((v as { nextRetryAt?: unknown })?.nextRetryAt ?? ""));
          this.state.asrRetry[k] = {
            attempts: Number.isFinite(attempts) && attempts >= 0 ? Math.floor(attempts) : 0,
            lastError: String((v as { lastError?: unknown })?.lastError ?? "").slice(0, 200),
            nextRetryAt: Number.isFinite(t) ? new Date(t).toISOString() : new Date(0).toISOString(),
            dead: Boolean((v as { dead?: unknown })?.dead),
          };
        }
      }
      // transcriptCache 条目形状消毒（第九轮复审批 1）：顶层 isPlainObject 只挡整体错位，
      // 手改 data.json 出的条目级脏值（transcript 非字符串）会穿过 peekStashedTranscript 的
      // 真值检查流进 asrOverride → buildNote 渲染出非文本内容。与 asrRetry 同口径逐条校验：
      // transcript 非非空字符串的条目直接丢弃（宁可下轮重新计费，也不把脏值当已付费转录复用）
      if (isPlainObject(this.state.transcriptCache)) {
        const clean: NonNullable<SyncState["transcriptCache"]> = {};
        for (const [k, v] of Object.entries(this.state.transcriptCache)) {
          const e = v as { transcript?: unknown; provider?: unknown; at?: unknown } | null;
          if (e && typeof e.transcript === "string" && e.transcript) {
            const at = typeof e.at === "string" ? Date.parse(e.at) : NaN;
            clean[k] = {
              transcript: e.transcript,
              provider: typeof e.provider === "string" ? e.provider : "",
              at: Number.isFinite(at) ? new Date(at).toISOString() : new Date(0).toISOString(),
            };
          }
        }
        this.state.transcriptCache = clean;
      }
    }
  }

  resetState() {
    // 「重置同步状态」只清同步台账与重试队列；进程管控 / OCR / 摘要结果不属同步数据，保留（安全设计 §3.3.5）
    this.state = {
      processed: {},
      pendingAsr: [],
      asrRetry: {},
      // 性能样本与摘要/OCR 记录同属诊断数据，不随同步台账重置（安全设计 §3.3.5 的同一取舍）
      metrics: this.state.metrics,
      lastPerfSummary: this.state.lastPerfSummary,
      processManager: this.state.processManager,
      vision: this.state.vision,
      summary: this.state.summary,
      backfillFails: {},
      // 转写暂存是成本保护数据：清掉的话「重置台账后重同步」会对未落账的已付费转录重新计费
      transcriptCache: this.state.transcriptCache,
    };
    this.ledger.invalidateNoteIndex();
    void this.onStateChange();
  }

  /**
   * 标记进度已变更（节流路径）。绝大多数「处理完一条」的场景用这个，不要直接 await saveState()。
   * 实现随 P1-1 拆至 syncLedger.ts（含 flushTimer 定时器与 window/globalThis 兼容逻辑，逐行保真）。
   */
  private markStateDirty() {
    this.ledger.markStateDirty();
  }

  /** 立即落盘（关键节点）：实现随 P1-1 拆至 syncLedger.ts（并发串行排队 + 失败重标脏）。 */
  private async flushState(): Promise<void> {
    return this.ledger.flushState();
  }

  /** 强制落盘（保持原有调用语义；resetState / 同步收尾等关键节点使用）。 */
  private async saveState() {
    return this.ledger.saveState();
  }

  /** 插件卸载前落盘（onunload 调用）：避免节流窗口内的进度丢失。 */
  flushNow(): Promise<void> {
    return this.ledger.flushNow();
  }

  // ---------- 性能埋点（P2-15）----------

  /** 记录一条处理的分阶段耗时；环形保留最近 RECENT_METRICS 条。 */
  private recordStageTimings(item: SyncItem, perf: Record<string, number>, totalMs: number): void {
    if (!this.state.metrics) this.state.metrics = [];
    this.state.metrics.push({
      id: item.id,
      type: item.type,
      totalMs,
      reuseMs: perf.reuseMs ?? 0,
      coverMs: perf.coverMs ?? 0,
      ffmpegMs: perf.ffmpegMs ?? 0,
      imagesMs: perf.imagesMs ?? 0,
      ocrMs: perf.ocrMs ?? 0,
      asrMs: perf.asrMs ?? 0,
      categoryMs: perf.categoryMs ?? 0,
      noteWriteMs: perf.noteWriteMs ?? 0,
      summaryMs: perf.summaryMs ?? 0,
      recordedAt: nowIso(),
    });
    if (this.state.metrics.length > RECENT_METRICS) {
      this.state.metrics = this.state.metrics.slice(-RECENT_METRICS);
    }
  }

  /** 取某时刻之后记录的样本（用于「本次同步」的画像，而不是历史累积）。 */
  private metricsSince(iso: string): StageTimings[] {
    const from = Date.parse(iso);
    const all = this.state.metrics ?? [];
    if (!Number.isFinite(from)) return all;
    return all.filter((m) => {
      const t = Date.parse(m.recordedAt);
      // 时间戳损坏的历史样本（手改 data.json / 旧版本数据）直接排除，不再混进「本次」画像
      return Number.isFinite(t) && t >= from;
    });
  }

  /** 一行耗时画像（命令「查看同步性能画像」用）。 */
  perfSummary(): string {
    const rows = this.state.metrics ?? [];
    return summarizeStageTimings(rows) || "暂无性能样本（先跑一次同步）";
  }

  /** 分阶段明细（命令「查看同步性能画像」用）。 */
  perfDetail(): string {
    return detailStageTimings(this.state.metrics ?? []);
  }

  /**
   * 转写重试队列一行画像（命令「查看转写重试队列」用）：
   * 队列规模 / 待试 / 退避中 / dead-letter，dead 条目附最后一次错误摘录，供人工判断是否值得手工处理。
   */
  retryQueueSummary(): string {
    const pending = this.state.pendingAsr ?? [];
    const retry = this.state.asrRetry ?? {};
    const dead = pending.filter((id) => retry[id]?.dead);
    const deferred = pending.filter((id) => {
      const e = retry[id];
      if (!e || e.dead) return false;
      const t = Date.parse(e.nextRetryAt);
      return Number.isFinite(t) && t > Date.now();
    });
    const readyNow = pending.length - dead.length - deferred.length;
    const lines: string[] = [
      `转写重试队列：共 ${pending.length} 条｜可立即试 ${readyNow}｜退避中 ${deferred.length}｜已放弃(dead) ${dead.length}`,
    ];
    for (const id of dead.slice(0, 5)) {
      lines.push(`  ✗ ${id}：${(retry[id]?.lastError ?? "").slice(0, 80)}`);
    }
    if (dead.length > 5) lines.push(`  … 其余 ${dead.length - 5} 条见 data.json → state.asrRetry`);
    if (pending.length === 0) lines.length = 1;
    return lines.join("\n");
  }

  /** 反向索引懒建（问题 8）：实现随 P1-1 拆至 syncLedger.ts（noteIndex 字段同迁）。 */
  private noteIndexGet(): Map<string, string> {
    return this.ledger.noteIndexGet();
  }

  // ---------- 主入口 ----------

  async syncAll(): Promise<SyncSummary> {
    if (this.running) throw new Error("同步正在进行中");
    this.running = true;
    const summary = newSyncSummary();
    summary.startedAt = nowIso();
    const notice = new Notice("抖音同步：开始…", 0);
    this.syncNotice = notice;
    try {
      // 设置可能在本会话内被改过（Obsidian 改设置不会重载插件）→ 按最新设置重建 AI 客户端，
      // 否则「在设置页换了 OCR 通道/模型」不会生效（实测踩坑：换了通道仍打旧服务端并持续 503）。
      this.refreshClients();
      // 配额熔断复位（每轮重新探测，见字段注释）
      this.videoSummaryQuotaFails = 0;
      this.videoSummaryQuotaDead = false;
      let asrBudget = this.settings.maxTranscribePerSync;

      // 1) 重试上次失败的转写
      asrBudget = await this.retryPendingAsr(asrBudget, summary, notice);
      // 剩余预算交给新条目的转写（2026-09-27 第四轮）：此前 maxTranscribePerSync 只约束重试，
      // 全新条目无上限——首次全量同步一次性烧掉几百条转写费
      this.asrBudgetLeft = Math.max(0, asrBudget);

      const whitelist = parseList(this.settings.folderWhitelist);

      // 2) 收藏（收藏夹模式）
      if (this.settings.syncCollection) {
        let folderOk = false;
        if (this.settings.useFolderMode) {
          try {
            const folders = await this.client.listFolders(0, 100);
            const targets = whitelist.length ? folders.filter((f) => whitelist.includes(f.name)) : folders;
            if (folders.length === 0) {
              summary.notices.push("收藏夹列表为空（可能无收藏夹或接口变更）");
            }
            // 白名单一个都匹配不到（收藏夹改名/拼写不一致）：原实现静默零同步且无任何提示
            if (whitelist.length > 0 && targets.length === 0) {
              summary.errors.push(`收藏夹白名单均未匹配到（${whitelist.join("、")}），请核对设置中的收藏夹名称`);
            }
            for (const f of targets) {
              this.onStatus(`同步收藏夹：${f.name}`);
              const n = await this.syncCollectionFolder(f.id, f.name, summary, notice);
              notice.setMessage(`抖音同步：收藏夹「${f.name}」新增 ${n}`);
            }
            folderOk = targets.length > 0 || whitelist.length > 0;
          } catch (e: any) {
            const msg = String(e?.message ?? e);
            // 404 = 收藏夹 API 已被抖音网关下线（2026-10-01 实测：/aweme/v1/web/collection/*
            // 整个子树返回 404 "Unsupported path(Janus)"，list 与 item/list 双双失效）。
            // 这是确定性结果——每次同步都报 error 纯属噪音（扁平兜底本就覆盖全部收藏内容），
            // 降级为 notice；其余错误（网络/5xx）维持 error 观感。
            if (isFolderApiUnavailableError(msg)) {
              summary.notices.push(`收藏夹接口已不可用（抖音 API 变更），本次按扁平模式同步全部收藏（${msg.slice(0, 60)}）`);
            } else {
              summary.errors.push(`收藏夹模式失败：${msg}`);
            }
          }
        }
        // 3) 扁平兜底（无白名单时；或收藏夹模式失败时）
        if (!folderOk || !this.settings.useFolderMode || whitelist.length === 0) {
          this.onStatus("同步收藏（扁平）");
          await this.syncFlat("未分类", summary, notice);
        }
      }

      // 4) 喜欢 / 作品
      if (this.settings.syncLike || this.settings.syncPost) {
        try {
          const secUid = await this.client.getSelfSecUid();
          if (this.settings.syncLike) {
            this.onStatus("同步喜欢列表");
            await this.syncPaged(
              (cursor, count) => this.client.listLikes(secUid, cursor, count),
              summary,
              notice,
              "like",
            );
          }
          if (this.settings.syncPost) {
            this.onStatus("同步作品列表");
            await this.syncPaged(
              (cursor, count) => this.client.listPosts(secUid, cursor, count),
              summary,
              notice,
              "post",
            );
          }
        } catch (e: any) {
          summary.errors.push(`喜欢/作品同步失败：${e?.message ?? e}`);
        }
      }

      // 5) Bases
      if (this.settings.generateBases) {
        try {
          const n = await generateBases(this.app.vault, this.settings.basesFolder);
          if (n > 0) summary.notices.push(`已生成 ${n} 个 Bases 文件（已存在的不覆盖）`);
        } catch (e: any) {
          summary.errors.push(`Bases 生成失败：${e?.message ?? e}`);
        }
      }

      summary.finishedAt = nowIso();
      this.state.lastSyncAt = summary.finishedAt;
      this.state.lastSyncSummary = `新增 ${summary.created} / 转写 ${summary.transcribed} / 视频摘要 ${summary.videoSummaries} / 跳过 ${summary.asrSkipped} / 失败 ${summary.asrFailed}`;
      // 性能画像（P2-15）：只统计本次同步产生的样本，避免历史样本污染（并发的各条在同一窗口内并行，p50 反映典型条）
      const perfLine = summarizeStageTimings(this.metricsSince(summary.startedAt));
      if (perfLine) {
        this.state.lastPerfSummary = perfLine;
        console.log(`[douyin-sync] ${perfLine}`);
        console.log(`[douyin-sync]\n${detailStageTimings(this.metricsSince(summary.startedAt))}`);
      }
      await this.saveState();

      const msg =
        `抖音同步完成：新增 ${summary.created}，跳过 ${summary.skipped}，` +
        `转写成功 ${summary.transcribed}，视频摘要 ${summary.videoSummaries}，转写失败 ${summary.asrFailed}` +
        (summary.errors.length
          ? `。注意：${summary.errors[0]}`
          : summary.notices.length
            ? `。${summary.notices[0]}`
            : "");
      notice.setMessage(msg);
      setTimeout(() => notice.hide(), 6000);
      this.onStatus(`上次同步 ${new Date().toLocaleTimeString("zh-CN")}`);
      return summary;
    } catch (e: any) {
      notice.setMessage(`抖音同步失败：${e?.message ?? e}`);
      setTimeout(() => notice.hide(), 8000);
      summary.errors.push(String(e?.message ?? e));
      summary.finishedAt = nowIso();
      // 异常退出也要把节流窗口内的进度落盘（flushState 内部自带失败重标脏，不会二次抛出）
      await this.saveState().catch(() => {});
      return summary;
    } finally {
      this.syncNotice = null;
      this.running = false;
    }
  }

  // ---------- 分页 ----------

  /**
   * 消费一页条目（性能治理 P0-3）。
   *
   * 先串行判定「已处理」，保留 scanStopAfterProcessed 依赖的连续计数语义；再对未处理条目
   * 按 syncConcurrency 限并发处理 —— 这些条目的耗时几乎全在等待（CDN 下载、ffmpeg 转码、
   * 云端 ASR/摘要推理），并发后一批的时长由「各条之和」变为「较长者」。
   * 列表分页本身仍严格串行：cursor 有顺序依赖，且抖音风控对并发列表请求敏感。
   */
  private async consumePage(
    raws: DouyinAwemeRaw[],
    source: SyncItem["source"],
    folder: string,
    summary: SyncSummary,
    notice: Notice | undefined,
  ): Promise<{ created: number; streak: number }> {
    let streak = 0;
    const fresh: SyncItem[] = [];
    for (const raw of raws) {
      const item = DouyinClient.normalize(raw, source);
      if (!item) continue;
      if (this.state.processed[item.id]) {
        streak++;
        summary.skipped++;
        continue;
      }
      streak = 0;
      fresh.push(item);
    }
    if (fresh.length === 0) return { created: 0, streak };
    const limit = clampConcurrency(this.settings.syncConcurrency, 3);
    // 同页重复 id 防线（第九轮 A3 补强）：并发 ≥2 时「先到者写台账后后到者再检查」的时序
    // 保证不成立——两个同 id 任务可同时启动、都在对方 finalize 前通过检查，造成双重 ASR 计费
    // 与同一计划路径两次并发全量重写。任务入队即登记 in-flight，结束后解除。
    const inflight = new Set<string>();
    const results = await mapLimit(fresh, limit, async (it) => {
      if (this.state.processed[it.id] || inflight.has(it.id)) {
        summary.skipped++;
        return false;
      }
      inflight.add(it.id);
      try {
        return await this.processItem(it, folder, summary, notice);
      } finally {
        inflight.delete(it.id);
      }
    });
    return { created: results.filter(Boolean).length, streak };
  }

  private async syncCollectionFolder(
    folderId: string,
    folderName: string,
    summary: SyncSummary,
    notice: Notice,
  ): Promise<number> {
    let cursor = 0;
    let created = 0;
    let processedStreak = 0;
    for (let page = 0; page < 200; page++) {
      const res = await this.client.listFolderItems(folderId, cursor, 20);
      summary.total += res.items.length;
      const r = await this.consumePage(res.items, "collection", folderName, summary, notice);
      created += r.created;
      // streak 累计（2026-09-27 修回归）：consumePage 的 streak 是「页尾连续已处理数」（单页最大 = 页大小 20），
      // 必须**跨页累加**才能达到 scanStopAfterProcessed（默认 100）；原重构误写成替换，
      // 导致提前停止永不触发、每次同步都把收藏列表完整翻到最后。
      // 页尾 streak=0 说明最后一条是新条目 → 清零，与重构前的「遇新归零」语义一致。
      processedStreak = r.streak > 0 ? processedStreak + r.streak : 0;
      // scanStopAfterProcessed ≤0（手改 data.json）时视为禁用提前停止（2026-09-27 第四轮）：
      // 原 `0 >= 0` 恒真会让每个来源只扫一页，静默漏同步
      if (this.settings.scanStopAfterProcessed > 0 && processedStreak >= this.settings.scanStopAfterProcessed) break;
      if (!res.hasMore || res.items.length === 0) break;
      cursor = res.cursor ?? cursor + 20;
      await sleep(600);
    }
    return created;
  }

  private async syncFlat(
    defaultFolder: string,
    summary: SyncSummary,
    notice: Notice,
  ): Promise<void> {
    let cursor = 0;
    let processedStreak = 0;
    for (let page = 0; page < 500; page++) {
      const res = await this.client.listCollection(cursor, 20);
      summary.total += res.items.length;
      const r = await this.consumePage(res.items, "collection", defaultFolder, summary, notice);
      processedStreak = r.streak > 0 ? processedStreak + r.streak : 0; // streak 跨页累计（见 syncCollectionFolder 注释）
      if (this.settings.scanStopAfterProcessed > 0 && processedStreak >= this.settings.scanStopAfterProcessed) break;
      if (!res.hasMore || res.items.length === 0) break;
      cursor = res.cursor ?? cursor + 20;
      await sleep(600);
    }
  }

  private async syncPaged(
    fetcher: (cursor: number, count: number) => Promise<{ hasMore: boolean; cursor?: number; items: any[] }>,
    summary: SyncSummary,
    notice: Notice,
    source: SyncItem["source"],
  ): Promise<void> {
    let cursor = 0;
    let processedStreak = 0;
    for (let page = 0; page < 500; page++) {
      const res = await fetcher(cursor, 20);
      summary.total += res.items.length;
      const r = await this.consumePage(res.items, source, "", summary, notice);
      processedStreak = r.streak > 0 ? processedStreak + r.streak : 0; // streak 跨页累计（见 syncCollectionFolder 注释）
      if (this.settings.scanStopAfterProcessed > 0 && processedStreak >= this.settings.scanStopAfterProcessed) break;
      if (!res.hasMore || res.items.length === 0) break;
      cursor = res.cursor ?? cursor + 20;
      await sleep(600);
    }
  }

  // ---------- 单条处理 ----------

  /**
   * 单条收藏的处理管线（2026-09-27 第七轮拆分：原 340 行单函数 → 编排器 + 9 个阶段方法）。
   * 阶段顺序与计时键（perf.cut）保持拆分前逐位一致——state.metrics 的耗时画像口径不变。
   * 行为不变式由 tests/sync-engine.test.mjs 的引擎级用例守护（processItem 全链路 / ASR 台账 /
   * 预算顺延 / 来源还原 / 补跑筛选等）。
   */
  private async processItem(
    item: SyncItem,
    folder: string,
    summary: SyncSummary,
    notice: Notice | undefined,
    overwritePath?: string,
    asrOverride?: AsrResult | null,
    frameHint?: string[],
    reextractFrames?: boolean,
  ): Promise<boolean> {
    try {
      const perf = new StageTimer();
      notice?.setMessage(`抖音同步：处理 ${noteTitleFor(item.title, item.id).slice(0, 24)}`);

      // A2（第九轮）：全新路径撞上已存在笔记（台账丢失：节流落盘窗口内崩溃 / 重置状态后重同步）
      // 时，原实现按 buildNote 全量覆盖——用户后续编辑与已付费的摘要块一并丢失。
      // 按 id 现场定位后与重试路径共用同一套资产回收（封面/图片/OCR/分类/帧/摘要回填）。
      // collided 标记区分「撞库恢复」与「调用方显式传入的重试/补跑路径」：两者的
      // asrOverride 语义不同——撞库应优先复用笔记既有逐字稿，补跑则代表重出自愈意图。
      let collided = false;
      if (!overwritePath) {
        const existing = this.findNotePath(item.id);
        if (existing) {
          overwritePath = existing;
          collided = true;
        }
      }

      // B3（第九轮）：转写结果暂存命中 → 直接当 asrOverride 用，跳过音频拉取与 ASR 计费
      //（上次转写成功但写笔记失败的情形，原实现下轮会重新计费一整次）；台账收尾时清除暂存。
      // asrReused（第十轮复审批）：转录来自复用源（B3 暂存 / F1 笔记旧稿）时为 true——
      // keepExistingSummary 与阶段 3 的 needFrames 抑制都由它门控。暂存命中同样可能撞库到
      // 已有 v3 摘要的完整笔记（转写成功 → 写笔记失败 → 暂存 → 重置台账 → 撞库），此时
      // 转录内容与笔记一致，重出摘要同样是纯浪费的付费调用 + 精修摘要被覆盖。
      let asrReused = false;
      if (asrOverride === undefined) {
        const stashed = this.peekStashedTranscript(item.id);
        if (stashed) {
          asrOverride = stashed;
          asrReused = true;
        }
      }

      // 阶段 1：重试路径资产回收——只重跑转写 + 写笔记，封面/图片/OCR/分类从既有笔记回收（问题 6）
      const reused = await this.collectReusedAssets(overwritePath);
      perf.cut("reuseMs");

      // F1（第十轮）：撞库路径从笔记正文回收既有逐字稿。B3 暂存只覆盖「转写成功但写笔记失败」
      // 的崩溃窗口（成功落账即清），对早已成功同步的视频笔记必然为空——台账丢失（重置状态/
      // 节流窗口崩溃）后重同步时，原实现两路 asrOverride 都为空：预算内条目重新下载全片 +
      // 重复计费 ASR，预算外条目被 asr=null 的 buildNote 降级重写（逐字稿块删除、
      // transcript_status 退回 not_requested）。与 backfillVideos 的复用口径一致：
      // success + 非空逐字稿直接构造 asrOverride，needAudio 随之为 false（免下载免计费）。
      // 注意只对撞库路径生效——补跑传 asrOverride=undefined 是「重新转写自愈」的显式意图（A8），
      // 不能被笔记旧稿劫持。
      if (
        collided &&
        asrOverride === undefined &&
        reused &&
        item.type === "video" &&
        reused.transcriptStatus === "success" &&
        reused.transcript.trim()
      ) {
        asrOverride = { status: "success", transcript: reused.transcript, provider: reused.transcriptProvider || "reused" };
        asrReused = true;
      }

      // F2（第十轮）：撞库路径已有摘要且格式健康时跳过阶段 9 重出。摘要回填（阶段 8）刚把
      // 既有摘要写回笔记，若无门控，阶段 9 会立刻用现生成版本覆盖——重置状态后重同步会把
      // 不可再生的精修摘要整批替换掉（328 篇 Agent 亲写层级体），且这是一次纯浪费的付费调用。
      // 存量保护（批次二 v4 升版）：判定从「=== SUMMARY_V」放宽为「>= 3 即格式健康」——
      // 否则升 v4 后 v3 笔记在撞库路径会被整批重写成 v4，违反「存量不自动重出」（2026-10-16 拍板）。
      // 只保护「转录来自复用源」的路径：转录确实变化时（重新转写）照常重出。
      const keepExistingSummary =
        asrReused && !!reused?.summaryText && parseInt(reused.summaryV, 10) >= 3;

      // 阶段 2：封面
      const coverPath = await this.resolveCover(item, reused);
      perf.cut("coverMs");

      // 阶段 3：视频素材（转录用音频 + 关键帧）——视频类专用，图文类不转录不抽帧。
      // keepExistingSummary 透传（第十轮复审批）：摘要既不重出，帧就没有任何消费方——
      // 不抑制的话 needFrames 恒真会为无帧笔记白跑一次全片下载 + ffmpeg 抽帧，
      // 而 403 条撞库恢复里多数恰是无帧笔记（摘要已被保护跳过），整轮全是白付的 IO。
      const video = await this.resolveVideoAssets(
        item,
        reused,
        asrOverride,
        frameHint,
        reextractFrames === true,
        summary,
        keepExistingSummary,
      );
      perf.cut("ffmpegMs");

      // 阶段 4：图文图片下载
      const images = await this.downloadImages(item, reused);
      perf.cut("imagesMs");

      // 阶段 5：图片 OCR
      const visionTexts = await this.recognizeImageTexts(item, reused, images.localImageByIndex, summary);
      perf.cut("ocrMs");

      // 阶段 6：ASR 逐字稿（asrOverride 非 undefined 时直接复用调用方结果，避免重试路径二次转写）
      const asr = await this.transcribeVideo(
        item,
        summary,
        asrOverride,
        video.needAudio,
        video.mediaErrorKind,
        video.mediaPullError,
      );
      // 音频临时文件清理（帧图已入库 vault；缓存清除后下次需要时重新拉取）。
      // 无条件调用（cleanup 幂等）：素材拉取失败时也要清掉临时目录——
      // 旧写法 `if (assets)` 会让失败路径把最大 200MB 的 source.mp4 永久留在 OS 临时目录，失败一次泄一份。
      this.videoMedia.cleanup(item.id);
      perf.cut("asrMs");

      // 阶段 7：AI 分类
      const category = await this.categorizeItem(item, reused, asr, summary);
      perf.cut("categoryMs");

      // 阶段 8：写笔记（含既有摘要回填——重建会清掉摘要块，回填保证「摘要重生成失败」不抹掉已有摘要）
      const { path, noteFile } = await this.writeItemNote({
        item,
        folder,
        overwritePath,
        reused,
        category,
        coverPath,
        imagesDownloaded: images.images,
        visionTexts,
        asr,
        assets: video.assets,
        frameIntervalSec: video.frameIntervalSec,
      });
      perf.cut("noteWriteMs");

      // 阶段 9：视频多模态综合总结（自动；图文类不走此分支）。keepExistingSummary（第十轮 F2）：
      // 撞库恢复且摘要已是当前版本时跳过，防既有精修摘要被现生成版本批量覆盖。
      await this.runVideoSummary(item, noteFile, asr, video.assets, summary, keepExistingSummary);
      perf.cut("summaryMs");

      // 阶段 10：相关笔记互链（第八轮；图文/视频都走）。不设计时键——本阶段仅元数据
      // 内存扫描 + 幂等块回写（毫秒级），不入 StageTimings（recordStageTimings 只取白名单键，
      // 这里不加键即自然不落画像，metrics 口径不变）。
      await this.linkRelatedNotes(item, noteFile, category);

      this.finalizeProcessed(item, path, folder, asr);
      this.recordStageTimings(item, perf.perf, perf.totalMs());
      this.markStateDirty(); // 节流落盘（原 await saveState()：每条全量写 689KB）
      summary.created++;
      this.updateSyncProgress(summary);
      return true;
    } catch (e: any) {
      summary.errors.push(`[${item.id}] ${String(e?.message ?? e).slice(0, 100)}`);
      // 失败也要触发落盘（第九轮 B3）：转写暂存写在 state 里，不落盘的话崩溃窗口内暂存丢失，
      // 下轮仍会重新计费
      this.markStateDirty();
      this.updateSyncProgress(summary);
      return false;
    }
  }

  /** 条目级进度更新（任务 4）：常驻 Notice 原位改写累计计数。条目级并发下完成频率低（秒级间隔），无闪烁问题。 */
  private updateSyncProgress(summary: SyncSummary): void {
    this.syncNotice?.setMessage(
      `抖音同步：已入库 ${summary.created}｜跳过 ${summary.skipped}｜转写失败 ${summary.asrFailed}` +
        (summary.errors.length ? `｜错误 ${summary.errors.length}` : ""),
    );
  }

  /** 阶段 1：资产回收（重试路径与「全新撞库」路径共用）。回收失败回退 null（调用方走原联网路径）。 */
  private async collectReusedAssets(overwritePath: string | undefined): Promise<ReusedNoteAssets | null> {
    // 门控放宽为只看 overwritePath（第九轮 A2）：全新路径撞上已存在笔记时同样要回收资产，
    // 原实现要求 asrOverride 非 undefined，撞库条目的摘要/封面/帧全部白丢
    if (!overwritePath) return null;
    try {
      const existingFile = this.app.vault.getAbstractFileByPath(normalizePath(overwritePath));
      if (existingFile instanceof TFile) {
        return collectExistingAssets(await this.app.vault.read(existingFile));
      }
      return null;
    } catch {
      return null;
    }
  }

  /** 阶段 2：封面。重试路径复用既有封面，否则按设置下载。 */
  private async resolveCover(item: SyncItem, reused: ReusedNoteAssets | null): Promise<string> {
    if (reused?.coverPath) return reused.coverPath;
    if (this.settings.downloadCover && item.coverUrl) {
      return this.media.saveImage(item.coverUrl, `cover/${item.id}`);
    }
    return "";
  }

  /**
   * 阶段 3：视频素材（转录用音频 + 关键帧）。重试路径（asrOverride 已带转写结果）不再拉音频，
   * 仅按需为摘要抽帧；关键帧优先复用既有笔记里已入库的帧网格（问题 6）。
   * 素材门控在函数级（第六轮接手收尾）：转写阶段的「素材已失败」快捷路径要读 needAudio——
   * 前会话的编辑事故（条件表达式丢失）正发生在此处。
   * 素材错误类别随本次 pullAssets 结果走（结构化返回值），无需共享字段清零——
   * 旧共享字段在条目级并发下会被其他条目覆写，导致确定性失败误入重试队列、或可重试失败被误删（2026-09-27 修）。
   */
  private async resolveVideoAssets(
    item: SyncItem,
    reused: ReusedNoteAssets | null,
    asrOverride: AsrResult | null | undefined,
    frameHint: string[] | undefined,
    reextractFrames: boolean,
    summary: SyncSummary,
    summaryProtected = false,
  ): Promise<VideoAssetsOutcome> {
    const needAudio =
      asrOverride === undefined &&
      this.settings.asrProvider === "siliconflow_sensevoice" &&
      !!this.settings.siliconflowKey;
    // 摘要门控按实际解析链判定（2026-09-27 第四轮）：原写死 `aiKey || dashscopeKey`，
    // 只配了 videoSummaryApiKey（设置页「多模态 API Key」）的用户 needFrames 恒 false——
    // 不拉视频不抽帧、摘要分支整体跳过，且无任何报错，专用通道静默失效。
    // summaryProtected（第十轮复审批）：既有摘要被保护跳过时帧没有消费方，抑制帧路——
    // 否则撞库恢复场景为无帧笔记白跑全片下载 + ffmpeg，成果又被阶段 9 的跳过丢掉
    const needFrames =
      !summaryProtected &&
      !this.videoSummaryQuotaDead && // 配额熔断（第十三轮）：摘要无人消费时帧路一并抑制
      this.settings.videoSummaryEnabled &&
      !!resolveVideoSummaryChannel(this.settings).apiKey;
    const wantInterval = Math.max(1, Math.min(60, this.settings.keyframeIntervalSec || 10));
    let assets: VideoAssets | null = null;
    let mediaErrorKind: MediaErrorKind = "none";
    let mediaPullError = "";
    let frameIntervalSec = 0;
    if (item.type === "video") {
      // 帧复用与「本次帧的真实间隔」（第九轮 A1/B7 重构；间隔语义 2026-10 改为不追溯）：
      // - backfill 的 frameHint 在帧网格已存在时传入 → 直接复用，回写保持笔记记录的原间隔；
      // - reused 帧回退：仅当没有重抽意图（reextractFrames=false），或本次没有任何拉取方
      //   （needAudio/needFrames 全 false——回退只为保住笔记里已有的帧块）；
      //   原实现 reused 帧无条件劫持，backfill 的重抽意图被吞掉且 frame_interval 被盖章成
      //   当前设置，「改间隔/补帧」场景永久失效（下一轮 framesOk 恒真 → 永远 skipped）。
      const hintFromBackfill = !!(frameHint && frameHint.length > 0);
      const reuseOk = hintFromBackfill || !reextractFrames || (!needAudio && !needFrames);
      const hint = hintFromBackfill
        ? frameHint!
        : reuseOk && reused?.framePaths.length
          ? reused.framePaths
          : undefined;
      // 真实间隔：复用帧一律以笔记记录的既有间隔为准（keyframeIntervalSec 不追溯，2026-10 行为变更）：
      // 存的 frame_interval 与当前设置不一致时不再自动重抽，复用既有帧并原样回写记录值；
      // 仅全新抽帧（走拉取分支产出新帧）才用当前设置值。旧笔记缺记录时按当前设置收编。
      const hintInterval = parseInt(reused?.frameInterval ?? "", 10) || wantInterval;
      if (hint && hint.length > 0 && !needAudio) {
        assets = { audioPath: "", framePaths: hint };
        frameIntervalSec = hintInterval;
      } else if (needAudio || needFrames) {
        // B7（第九轮）：已有完好帧网格时不再为「只要音频」的拉取重编帧路（免一次全片解码 + JPEG 编码）
        const pulled = await this.videoMedia.pullAssets(item, {
          wantAudio: needAudio,
          wantFrames: needFrames && !(hint && hint.length > 0),
        });
        assets = pulled.assets;
        mediaErrorKind = pulled.errorKind;
        if (!assets) {
          mediaPullError = pulled.error;
          summary.errors.push(`[${item.id}] 视频素材拉取失败：${pulled.error.slice(0, 100)}`);
        } else if (assets.framePaths.length === 0 && hint && hint.length > 0) {
          assets.framePaths = hint;
          frameIntervalSec = hintInterval;
        } else if (assets.framePaths.length > 0) {
          frameIntervalSec = wantInterval;
        }
      }
    }
    return { assets, needAudio, mediaErrorKind, mediaPullError, frameIntervalSec };
  }

  /**
   * 阶段 4：图文图片下载。重试路径复用既有笔记中已入库的图片，不重复下载；
   * 同时登记序号 → 本地路径，供 OCR 阶段复用已下载字节。
   */
  private async downloadImages(item: SyncItem, reused: ReusedNoteAssets | null): Promise<ImageDownloads> {
    const imagesDownloaded: string[] = [];
    const localImageByIndex = new Map<number, string>(); // 图片序号 → 已入库路径（OCR 复用已下载字节，免二次走 CDN）
    if (reused?.images.length) {
      imagesDownloaded.push(...reused.images);
      // 重试路径同样登记序号 → 本地路径（复审 P2）：否则 OCR 对已入库图片仍走 toDataUrl 重新下载
      reused.images.forEach((p, i) => localImageByIndex.set(i, p));
    } else if (item.type === "note" && this.settings.downloadImages) {
      const n = Math.min(item.imageUrls.length, this.settings.maxImages);
      for (let i = 0; i < n; i++) {
        const p = await this.media.saveImage(item.imageUrls[i], `images/${item.id}/${i + 1}`);
        if (p) {
          imagesDownloaded.push(p);
          localImageByIndex.set(i, p);
        }
        await sleep(200);
      }
    }
    return { images: imagesDownloaded, localImageByIndex };
  }

  /**
   * 阶段 5：图片 OCR。重试路径复用既有笔记的识别文本，不重复调用视觉模型。
   * 性能实测与根因（2026-09-19）：
   * ① 原实现把抖音 CDN 的图片 URL 直接交给视觉模型服务端拉取 → 拉取慢/被拒时撞满 120s 超时再走 base64 重试；
   *    而本地下载 10 张仅需 1.6s，故改为「先本地取字节转 base64」。
   * ② 改完仍慢（实测 42~1092s）。笔记里的失败原因揭示真凶：
   *    HTTP 503 {"code":50508,"message":"System is too busy now"} —— 视觉模型服务端过载。
   *    而条目级并发 3 × 图片级并发 3 = 9 路同时打过去，只会让它更过载、单张更慢。
   *    故 OCR 请求统一交给全局闸门（visionConcurrency）限流，与条目级并发解耦。
   */
  private async recognizeImageTexts(
    item: SyncItem,
    reused: ReusedNoteAssets | null,
    localImageByIndex: Map<number, string>,
    summary: SyncSummary,
  ): Promise<VisionRow[]> {
    const visionTexts: VisionRow[] = [];
    if (reused?.visionTexts.length) {
      visionTexts.push(...reused.visionTexts);
    } else if (
      item.type === "note" &&
      this.settings.enableVision &&
      (this.visionAi || this.ai) &&
      item.imageUrls.length > 0
    ) {
      const ai = (this.visionAi || this.ai)!;
      const gate = this.ocrGate;
      const n = Math.min(item.imageUrls.length, this.settings.maxImages);
      const rows = await mapLimit(
        Array.from({ length: n }, (_, i) => i),
        2,
        async (i) => {
          const url = item.imageUrls[i];
          try {
            // 输入优先复用刚下载入库的同一张图（P1-10：此前同一条目的每张图会被下载两遍）；
            // 文件读不到再退回 URL 重新下载，仍失败才退回 URL 直传
            const localPath = localImageByIndex.get(i);
            const dataUrl =
              (localPath ? await this.media.dataUrlFromFile(localPath) : "") ||
              (await this.media.toDataUrl(url)) ||
              url;
            const text = await (gate
              ? gate.run(() => ai.ocrImage(dataUrl, item.title))
              : ai.ocrImage(dataUrl, item.title));
            if (text) summary.visionOk++;
            return { index: i + 1, text, status: text ? "识别成功" : "未识别" };
          } catch (e: any) {
            return { index: i + 1, text: "", status: `识别失败：${String(e?.message ?? e).slice(0, 60)}` };
          }
        },
      );
      visionTexts.push(...rows); // mapLimit 结果保持输入顺序，index 与图片顺序一致
    }
    return visionTexts;
  }

  /**
   * 阶段 6：ASR 逐字稿。asrOverride 非 undefined 时直接复用调用方结果（重试路径不二次转写）。
   * 含无视频轨判定、素材失败快捷分类、转写预算扣减与重试台账簿记（入队/结清/顺延）。
   */
  private async transcribeVideo(
    item: SyncItem,
    summary: SyncSummary,
    asrOverride: AsrResult | null | undefined,
    needAudio: boolean,
    mediaErrorKind: MediaErrorKind,
    mediaPullError: string,
  ): Promise<AsrResult | null> {
    if (asrOverride !== undefined) return asrOverride;
    if (item.type !== "video" || this.settings.asrProvider === "none") return null;
    if (isAudioOnlyItem(item)) {
      // 策略 B（2026-09-21 实测定位）：aweme_type=163 / media_type=43 的条目在抖音侧
      // **不提供视频轨**——video.duration=0、bit_rate=[]、download_addr=[]，
      // play_addr.url_list[0] 直接指向背景音乐。本地 ffmpeg 拿不到视频轨（-map 0:v:0 必失败），
      // 而走 URL 直传通道转出来的只是 BGM 歌词。
      // 因此既不抽帧也不转写，直接记 unavailable 并移出重试队列，避免把配乐当逐字稿污染知识库。
      this.clearAsrRetry(item.id);
      summary.asrSkipped++;
      return { status: "unavailable", transcript: "", provider: "none", error: AUDIO_ONLY_REASON };
    }
    if (needAudio && mediaErrorKind !== "none") {
      // 素材拉取已失败且 provider 需要本地音频（复审 P1；条件表达式由第六轮接手补回——
      // 前会话编辑事故丢失了它，导致全仓语法错误无法构建）：此时再调 provider 只会经
      // resolveAudio 把整套拉取重跑一遍（白付一次 ffmpeg/下载），且其通用错误文案
      // 「无法取得音频文件」会被确定性正则误判 → 一次网络抖动变成
      // 「无转写 + 台账记已处理 + 永不重试」。直接按素材错误分类。
      summary.asrFailed++;
      if (isDeterministicMediaError(mediaErrorKind)) {
        this.clearAsrRetry(item.id);
        summary.errors.push(`转写失败（素材侧，不重试）：${mediaPullError.slice(0, 70)}`);
      } else {
        this.enqueueAsrRetry(item.id, mediaPullError || mediaErrorKind);
      }
      return null;
    }
    // 音频路拉取的错误类别（复审 P1）：provider 失败时按结构化类别分类，不再依赖其
    // 通用错误文案撞确定性正则（网络抖动会被误杀成「永不重试」）
    let audioPullKind: MediaErrorKind | null = null;
    const provider = createAsrProvider(this.settings, this.client, {
      resolveAudio: async (url, videoId, durationSec) => {
        const pulled = await this.videoMedia.pullAssets(
          { id: videoId || item.id, playUrl: url, durationSec: durationSec ?? item.durationSec },
          { wantAudio: true, wantFrames: false },
        );
        audioPullKind = pulled.assets ? (pulled.assets.audioPath ? "none" : "no_audio") : pulled.errorKind;
        return pulled.assets?.audioPath || null;
      },
    });
    if (provider && item.playUrl) {
      if (this.asrBudgetLeft <= 0) {
        // 转写预算接线（第四轮声明、第六轮补实现）：maxTranscribePerSync 此前只约束重试队列，
        // 全新条目的转写完全不受限——首次全量同步会一次性烧掉几百条转写费。预算耗尽后
        // 新条目顺延到下次同步续传（不记失败、不进退避，attempts=0 下轮立即可试）。
        this.deferAsrToNextSync(item.id);
        return null;
      }
      this.asrBudgetLeft--;
      const asr = await provider.transcribe(item.playUrl, item.id, { durationSec: item.durationSec });
      if (asr.status === "success") {
        summary.transcribed++;
        // B3（第九轮）：已付费的转录先暂存再往下走——后续写笔记失败时条目不进台账，
        // 原实现转录文本只存在内存、下轮按全新条目重新计费
        this.stashTranscript(item.id, asr);
      } else if (asr.status === "unavailable") {
        // 已调通接口、确认无可转写内容（纯音乐/无对白）→ 移出队列，不反复重试
        summary.asrFailed++;
        this.clearAsrRetry(item.id);
        } else {
          summary.asrFailed++;
          const kind = audioPullKind && audioPullKind !== "none" ? audioPullKind : mediaErrorKind;
          // P2-2 双轨判定：先读结构化 failureKind（provider 已明确判定的），字段缺失时回退原正则
          // ——原正则保留为兜底，任何 provider 漏标时判定与改造前完全一致
          if (
            isDeterministicMediaError(kind) ||
            (kind === "none" &&
              (asr.failureKind === "deterministic" ||
                (asr.failureKind === undefined && DETERMINISTIC_ASR_FAILURE_RE.test(asr.error ?? ""))))
          ) {
          // 素材侧失败是确定性的：重试必然复现同一结果，不入队（P2）
          this.clearAsrRetry(item.id);
          summary.errors.push(`转写失败（素材侧，不重试）：${(asr.error ?? "").slice(0, 70)}`);
        } else {
          this.enqueueAsrRetry(item.id, asr.error ?? asr.status);
        }
      }
      return asr;
    }
    if (!item.playUrl) {
      return { status: "unavailable", transcript: "", error: "无播放地址" };
    }
    return null;
  }

  /** 阶段 7：AI 分类。重试路径复用既有分类；分类失败不中断条目（记入 errors，落「未分类」）。 */
  private async categorizeItem(
    item: SyncItem,
    reused: ReusedNoteAssets | null,
    asr: AsrResult | null,
    summary: SyncSummary,
  ): Promise<string> {
    if (reused?.category) return reused.category;
    if (!(this.settings.enableCategory && this.ai)) return "未分类";
    const cats = parseList(this.settings.aiCategories);
    if (cats.length === 0) return "未分类";
    try {
      return await this.ai.categorize(cats, item.title, item.desc, asr?.transcript ?? "");
    } catch (e: any) {
      summary.errors.push(`分类失败：${String(e?.message ?? e).slice(0, 80)}`);
      return "未分类";
    }
  }

  /**
   * 阶段 8：写笔记（buildNote 全量内容 → writeNoteFile → 既有摘要回填）。
   * 回填是关键修复：重建笔记会清掉既有摘要（buildNote 不含摘要块/frontmatter summary），
   * 先按既有摘要回填，保证「摘要重生成失败」不会把已有摘要永久抹掉；生成成功时再被覆盖。
   * 2026-09-27：改单次 vault.process 原子写（frontmatter + 摘要块一次变换完成），
   * 消除「processFrontMatter 写 → 再 read → 再 modify」三遍全文件 IO 与两次写之间的覆盖竞态。
   */
  private async writeItemNote(input: NoteWriteInput): Promise<{ path: string; noteFile: TFile | null }> {
    const { item, folder, overwritePath, reused, category, coverPath, imagesDownloaded, visionTexts, asr, assets } =
      input;
    const title = noteTitleFor(item.title, item.id);
    const path = overwritePath ?? planNotePath(this.settings.rootFolder, item, folder, title);
    const content = buildNote({
      item,
      folder,
      category,
      coverPath,
      imagesDownloaded,
      visionTexts,
      asr,
      framePaths: assets?.framePaths ?? [],
      // 只在真的有帧时写 frame_interval（复审 P2）：部分成功（帧缺席）也写间隔的话，
      // 补跑 framesOk 判定会误判「帧已达标」，这类笔记从此永远不再补抽帧。
      // 值用「本次帧的真实间隔」（第九轮 A1）：复用帧时原样回写笔记记录的间隔，
      // 保持补跑 framesOk 判定自洽——原实现盖当前设置值，把「间隔已变、需重抽」状态永久抹掉
      keyframeIntervalSec:
        assets && assets.framePaths.length > 0
          ? Math.max(1, Math.min(60, input.frameIntervalSec || this.settings.keyframeIntervalSec || 10))
          : 0,
      syncedAt: nowIso(),
    });
    // F3（第十轮）：既有摘要回填合并进同一次落盘。原「覆盖写 → 再 vault.process 回填」两段
    // 之间崩溃的话，磁盘旧摘要已被抹掉、仅存内存（reused.summaryText）——视频笔记可靠补跑
    // 自愈，图文笔记没有自动摘要通道、摘要永久丢失。summaryText 写前已在手，内存合并零成本。
    let finalContent = content;
    if (reused?.summaryText) {
      // 回填失败不影响主流程（保持原两段写的容错语义：宁可丢摘要回填，不炸整条）
      try {
        const v = parseInt(reused.summaryV, 10);
        // 版本号解析失败时传 undefined（第六轮修）：捏造 v3 会让 v1/v2 旧摘要被标成 v3，
        // 补跑判定恒真、旧格式摘要永远不再按新格式重出
        finalContent = applySummaryToNote(content, reused.summaryText, Number.isFinite(v) && v > 0 ? v : undefined);
      } catch {
        finalContent = content;
      }
    }
    const noteFile = await this.writeNoteFile(path, finalContent, overwritePath);
    return { path, noteFile };
  }

  /**
   * 阶段 9：视频多模态综合总结（自动；图文类不走此分支）：转录文字 + 关键帧 → 视觉模型。
   * 生成门与拉帧门同源（第六轮接线，第四轮只改了 needFrames 一半）：专用通道用户
   * 此前「照付抽帧成本但摘要静默不跑」，且补跑候选判定永假、每轮重复补跑。
   */
  private async runVideoSummary(
    item: SyncItem,
    noteFile: TFile | null,
    asr: AsrResult | null,
    assets: VideoAssets | null,
    summary: SyncSummary,
    keepExistingSummary = false,
  ): Promise<void> {
    // F2（第十轮）：撞库恢复且笔记已有当前版本摘要 → 整个阶段跳过。放在 settings 门之前：
    // 即使摘要通道可用，用现生成版本覆盖回填好的精修摘要也是净损失（付费 + 质量不可控）。
    if (keepExistingSummary) return;
    // 配额熔断（第十三轮）：配额类失败连续 3 次后跳过本阶段——每条白打一次 403 且逐条刷 error
    if (this.videoSummaryQuotaDead) return;
    if (
      !(
        item.type === "video" &&
        this.settings.videoSummaryEnabled &&
        !!resolveVideoSummaryChannel(this.settings).apiKey &&
        noteFile
      )
    ) {
      return;
    }
    try {
      const r = await generateAndWriteVideoSummary(this.app, noteFile, this.settings, {
        title: item.title,
        desc: item.desc,
        transcript: asr?.transcript ?? "",
        framePaths: assets?.framePaths ?? [],
      });
      if (r.record) this.state.summary = pushSummaryRecord(this.state.summary, r.record);
      if (r.ok) {
        this.videoSummaryQuotaFails = 0;
        summary.videoSummaries++;
      } else {
        const failMsg = r.msg ?? "";
        if (isQuotaExhaustedError(failMsg)) {
          // 09-21 真实数据：配额耗尽后 50 连发同错误（summary records 全红）。3 次即熔断——
          // 抑制后续条目的摘要调用与帧路拉取（needFrames），一次 notice 说明，不再逐条报错
          if (++this.videoSummaryQuotaFails >= 3 && !this.videoSummaryQuotaDead) {
            this.videoSummaryQuotaDead = true;
            summary.notices.push("多模态通道配额疑似耗尽（连续 3 次失败），本次运行剩余视频跳过摘要与抽帧；额度恢复后下轮自动恢复");
          }
        }
        summary.errors.push(`[${item.id}] 视频摘要：${r.msg.slice(0, 100)}`);
      }
    } catch (e: any) {
      summary.errors.push(`[${item.id}] 视频摘要异常：${String(e?.message ?? e).slice(0, 80)}`);
    }
  }

  /** 台账收尾：processed 记录 + 反向索引 + 转写成功/确认无语音时结清重试台账。 */
  private finalizeProcessed(item: SyncItem, path: string, folder: string, asr: AsrResult | null): void {
    this.state.processed[item.id] = {
      path,
      syncedAt: nowIso(),
      folder: folder || SOURCE_LABEL[item.source],
      asrStatus: asr?.status,
      // 来源入台账（第四轮声明、第六轮接线）：重试/补跑重建时还原 frontmatter source，
      // 不再把点赞/作品笔记改写成「收藏」
      source: item.source,
    };
    this.noteIndexGet().set(item.id, path); // 反向索引同步更新（问题 8）
    if (asr?.status === "success" || asr?.status === "unavailable") {
      this.clearAsrRetry(item.id);
    }
    // B3（第九轮）：条目已成功落账，转写暂存使命完成
    if (this.state.transcriptCache) delete this.state.transcriptCache[item.id];
  }

  // ---------- 相关笔记互链（2026-09-27 第八轮，借鉴 Learning-Vault-Skills） ----------

  /**
   * 阶段 10：给刚写好的笔记挂「相关笔记」块（同分类/同作者），并让被链笔记回链本条。
   * 候选一次收集、全链路复用（本条 + ≤N 条回链都从同一份候选集计算，保证互链一致）；
   * 块写入是幂等 upsert（relatedNotes.applyRelatedToNote），重复同步不产生重复块。
   * 任何失败只放弃互链，不影响同步主流程。
   */
  private async linkRelatedNotes(item: SyncItem, noteFile: TFile | null, category: string): Promise<void> {
    if (!this.settings.relatedNotesEnabled || !noteFile) return;
    try {
      const candidates = this.collectRelatedCandidates();
      // metadataCache 索引新建文件有延迟：把本条手工补进候选集，保证被链笔记的回链即时建立
      // 而不必等下一次重建；若缓存里已有（重同步路径）按 path 去重覆盖为内存里的最新分类/作者
      const selfEntry: RelatedCandidate = {
        path: noteFile.path,
        id: item.id,
        category,
        author: item.author,
        title: noteTitleFor(item.title, item.id),
        likes: item.stats?.likes ?? 0,
      };
      const selfIdx = candidates.findIndex((c) => c.path === selfEntry.path || c.id === selfEntry.id);
      if (selfIdx >= 0) candidates[selfIdx] = selfEntry;
      else candidates.push(selfEntry);

      const links = await this.writeRelatedBlock(noteFile, { id: item.id, category, author: item.author }, candidates);
      for (const lk of links) {
        // 互链：被链笔记重算自己的相关列表（候选集已含本条新笔记），回链自动建立
        const f = this.app.vault.getAbstractFileByPath(normalizePath(lk.path));
        const cand = candidates.find((c) => c.path === lk.path);
        if (f instanceof TFile && cand) {
          await this.writeRelatedBlock(f, { id: cand.id, category: cand.category, author: cand.author }, candidates);
        }
      }
    } catch {
      /* 互链失败不影响主流程 */
    }
  }

  /**
   * 从 metadataCache 收集互链候选（rootFolder 之下、有 douyin_id frontmatter 的 markdown）。
   * 纯内存查询（Obsidian 已解析好 frontmatter），O(vault 文件数) 毫秒级；
   * metadataCache / getMarkdownFiles 不可用（极端宿主环境、测试替身未提供）时返回空集，
   * 互链整体静默跳过——候选为空时 writeRelatedBlock 也不会留空块。
   */
  private collectRelatedCandidates(): RelatedCandidate[] {
    try {
      const cache = (this.app as any).metadataCache;
      const files = this.app.vault.getMarkdownFiles?.();
      if (!cache || typeof cache.getFileCache !== "function" || !Array.isArray(files)) return [];
      const root = normalizePath(this.settings.rootFolder || "").replace(/\/+$/, "");
      const out: RelatedCandidate[] = [];
      for (const f of files) {
        if (root && f.path !== root && !f.path.startsWith(root + "/")) continue;
        const fm = cache.getFileCache(f)?.frontmatter;
        if (!fm) continue;
        const id = typeof fm.douyin_id === "string" ? fm.douyin_id : String(fm.douyin_id ?? "");
        if (!id) continue;
        out.push({
          path: f.path,
          id,
          category: typeof fm.category === "string" ? fm.category : "",
          author: typeof fm.author === "string" ? fm.author : "",
          title: typeof fm.title === "string" && fm.title.trim() ? fm.title : f.basename,
          likes: Number(fm.likes) || 0,
        });
      }
      return out;
    } catch {
      return [];
    }
  }

  /** 对单个文件幂等写入「相关笔记」块；返回本次实际互链的条目（供互链回写）。 */
  private async writeRelatedBlock(
    file: TFile,
    self: { id: string; category: string; author: string },
    candidates: RelatedCandidate[],
  ): Promise<RelatedLink[]> {
    // 批次三：向量索引可用时按余弦 topK 选链，回落同分类/同作者打分（pickLinksForCurrent 内部封装）
    const links = await this.pickLinksForCurrent(
      { ...self, path: file.path, title: "", likes: 0 },
      candidates,
    );
    const block = buildRelatedBlock(links);
    // 无变化不写盘（第九轮 A4，与 refreshAllRelatedNotes 同口径）：内容不变时 vault.process
    // 也会重写文件、mtime 每轮跳动，污染「最近7天」视图与同步/备份工具的变更检测
    let cur: string | null = null;
    try {
      cur = await this.app.vault.read(file);
    } catch {
      cur = null; // 读取失败按「有变化」处理，走 process 兜底（原行为）
    }
    if (cur !== null && applyRelatedToNote(cur, block) === cur) return links;
    await this.app.vault.process(file, (data) => applyRelatedToNote(data, block));
    return links;
  }

  /**
   * 重建全部相关笔记链接（命令/设置页入口）：全量候选 × 全量笔记重算互链块，
   * 内容无变化的文件不写盘。返回扫描与更新篇数供 Notice 反馈。
   */
  async refreshAllRelatedNotes(): Promise<{ scanned: number; updated: number }> {
    // 守卫（第九轮 A12）：互链开关关闭时不写库（命令入口另有明确提示）；同步进行中拒绝并发写
    if (this.running) throw new Error("同步正在进行中");
    if (!this.settings.relatedNotesEnabled) return { scanned: 0, updated: 0 };
    // F6（第十轮）：重建期间置位 running——原实现只查不置，双击重建命令会并发跑两轮全库
    // 扫描写盘，重建进行中也能启动 syncAll/backfill 与之交错。与 backfillVideos 同款 finally 复位。
    this.running = true;
    try {
      const candidates = this.collectRelatedCandidates();
      let updated = 0;
      for (const cand of candidates) {
        const f = this.app.vault.getAbstractFileByPath(normalizePath(cand.path));
        if (!(f instanceof TFile)) continue;
        const links = await this.pickLinksForCurrent(cand, candidates);
        const block = buildRelatedBlock(links);
        let cur: string;
        try {
          cur = await this.app.vault.read(f);
        } catch {
          continue;
        }
        if (applyRelatedToNote(cur, block) === cur) continue; // 无变化不写盘（mtime 不动）
        await this.app.vault.process(f, (data) => applyRelatedToNote(data, block));
        updated++;
      }
      return { scanned: candidates.length, updated };
    } finally {
      this.running = false;
    }
  }

  // ---------- 语义检索 / 向量互链（批次三，2026-10-16） ----------

  /** 向量互链相似度门槛：低于它的候选视为「不相关」，宁缺毋滥（互链价值的本意是少而准）。 */
  private static readonly VECTOR_LINK_MIN_SCORE = 0.3;
  /** 语义搜索最低相似度：比互链门槛松一档（搜索场景用户想看「沾边」的结果）。 */
  private static readonly SEARCH_MIN_SCORE = 0.15;

  /**
   * 笔记的向量输入文本：frontmatter 之外的正文，压掉多余空白后取前 2000 码点。
   * OCR 文本 / 逐字稿 / 摘要都在正文里，前 2000 码点已足够撑起语义（v4 上限 8192 token，
   * 2000 中文字符 ≈ 2000~3000 token，留足余量且省费用）。
   */
  private async noteTextForEmbed(path: string): Promise<string> {
    try {
      const f = this.app.vault.getAbstractFileByPath(normalizePath(path));
      if (!(f instanceof TFile)) return "";
      const raw = await this.app.vault.read(f);
      const body = raw.startsWith("---")
        ? (() => {
            const lines = raw.split(/\r?\n/);
            for (let i = 1; i < lines.length; i++) {
              if (/^(---|\.\.\.)\s*$/.test(lines[i])) return lines.slice(i + 1).join("\n");
            }
            return raw; // frontmatter 未闭合：整个文件按正文算（宁可多 embed 不丢内容）
          })()
        : raw;
      return sliceByCodePoints(body.replace(/[ \t]+/g, " ").replace(/\n{2,}/g, "\n").trim(), 2000);
    } catch {
      return "";
    }
  }

  /**
   * 互链接链选择器（批次三重构的核心接线）：向量索引可用时按余弦 topK 选「内容真正相似」的笔记，
   * 不可用 / self 无向量 / 命中过门槛的不足 1 条时回落同分类/同作者打分——零破坏旧路径。
   * self 不在索引里（新笔记刚写完）时现场 embed 一次（单次调用数百 ms，互链阶段本身是收尾低频路径；
   * embed 失败静默回落打分，互链永不阻断同步主流程）。
   */
  private async pickLinksForCurrent(self: RelatedCandidate, candidates: RelatedCandidate[]): Promise<RelatedLink[]> {
    const max = Math.max(1, Math.min(30, this.settings.relatedNotesMax || 8));
    const vs = this.vectorStore;
    if (vs && this.embedClient && vs.size() > 0) {
      try {
        await vs.ensureLoaded();
        let selfVec = vs.get(self.id)?.v;
        if (!selfVec) {
          const text = await this.noteTextForEmbed(self.path);
          if (text) {
            const v = await this.embedClient.embedOne(text);
            if (v && v.length > 0) selfVec = new Float32Array(v);
          }
        }
        if (selfVec) {
          // 多取 25% 候选：过滤「id 已不在候选集」（笔记刚被移动/删除，索引滞后一轮）后仍可能满额
          const hits: VectorHit[] = vs.topKFor(selfVec, max + 5, SyncEngine.VECTOR_LINK_MIN_SCORE);
          const byId = new Map(candidates.map((c) => [c.id, c]));
          const links: RelatedLink[] = [];
          for (const hit of hits) {
            if (hit.id === self.id) continue;
            const c = byId.get(hit.id);
            if (!c) continue;
            links.push({
              path: c.path,
              title: c.title,
              sameCategory: !!self.category && !!c.category && self.category === c.category,
              sameAuthor: !!self.author && !!c.author && self.author === c.author,
            });
            if (links.length >= max) break;
          }
          // 有向量就如实返回（含空）：低于门槛宁缺毋滥是向量互链的价值前提，
          // 此时回落同分类打分会把「确实无内容相似」的笔记硬凑回互链块
          return links;
        }
      } catch (e) {
        if (typeof console !== "undefined" && (globalThis as any).__R3DEBUG) console.warn("[r3 debug] vec link path threw:", e);
        /* 向量路径任何异常都回落打分，互链不阻断 */
      }
    }
    // 向量路径整体不可用（无索引 / 无客户端 / self 向量拿不到）：回落同分类/同作者打分
    return pickRelatedLinks(self, candidates, max);
  }

  /**
   * 构建语义索引（命令入口）：全库候选 × contentHash 增量向量化。
   * - 换过 embeddingModel → resetForModel 全量重算（旧维度向量对新模型无意义）；
   * - 正文没变（hash 相同）→ 跳过，零重复计费；
   * - 每 10 条一批串行调用（429/5xx 退避在 EmbeddingClient 内），批间推进度；
   * - 收尾 pruneExcept 清孤儿向量（笔记已删），persist 原子落盘。
   * 返回给用户看的一句话汇总；通道未配置返回说明文案。
   */
  async buildSemanticIndex(onProgress?: (text: string) => void): Promise<string> {
    if (this.running) throw new Error("同步正在进行中");
    this.running = true;
    try {
      const chan = resolveEmbeddingChannel(this.settings);
      if (chan.problem || !this.embedClient) {
        return `语义索引不可用：${chan.problem || "embedding 通道未配置"}`;
      }
      const vs = this.vectorStore;
      if (!vs) return "语义索引不可用：向量库未注入（插件宿主异常）";
      await vs.ensureLoaded();
      if (!vs.isModel(this.settings.embeddingModel)) vs.resetForModel(this.settings.embeddingModel);
      const candidates = this.collectRelatedCandidates();
      if (candidates.length === 0) return "没有可索引的笔记（先完成一次同步）";
      const todo: { id: string; text: string; hash: string }[] = [];
      for (const c of candidates) {
        const text = await this.noteTextForEmbed(c.path);
        if (!text) continue;
        const hash = contentHash(text);
        if (vs.get(c.id)?.h === hash) continue; // 正文没变：不重算不重付
        todo.push({ id: c.id, text, hash });
      }
      let done = 0;
      for (let i = 0; i < todo.length; i += 10) {
        const batch = todo.slice(i, i + 10);
        const vecs = await this.embedClient.embed(batch.map((b) => b.text));
        for (let j = 0; j < batch.length; j++) {
          vs.set(batch[j].id, batch[j].hash, new Float32Array(vecs[j]));
        }
        done += batch.length;
        onProgress?.(`语义索引：已向量化 ${done}/${todo.length}`);
      }
      const pruned = vs.pruneExcept(new Set(candidates.map((c) => c.id)));
      await vs.persist();
      return todo.length === 0
        ? `语义索引已是最新（共 ${vs.size()} 篇${pruned ? `，清理孤儿 ${pruned} 条` : ""}）`
        : `语义索引完成：新增/更新 ${todo.length}，总 ${vs.size()} 篇${pruned ? `，清理孤儿 ${pruned} 条` : ""}`;
    } finally {
      this.running = false;
    }
  }

  /**
   * 语义搜索（命令入口）：查询文本向量化 → 余弦 topN。
   * 返回 null = 当前不可搜（通道未配置 / 索引为空），调用方负责提示「先构建语义索引」；
   * 返回空数组 = 索引在但没有沾边的命中。
   */
  async semanticSearch(
    query: string,
    topN = 10,
  ): Promise<{ path: string; title: string; category: string; score: number }[] | null> {
    const chan = resolveEmbeddingChannel(this.settings);
    if (chan.problem || !this.embedClient) return null;
    const vs = this.vectorStore;
    if (!vs) return null;
    await vs.ensureLoaded();
    if (vs.size() === 0) return null;
    const qv = await this.embedClient.embedOne(query);
    if (!qv || qv.length === 0) return null;
    const hits = vs.topKFor(new Float32Array(qv), Math.max(1, Math.min(30, topN)), SyncEngine.SEARCH_MIN_SCORE);
    if (hits.length === 0) return [];
    const byId = new Map(this.collectRelatedCandidates().map((c) => [c.id, c]));
    const out: { path: string; title: string; category: string; score: number }[] = [];
    for (const hit of hits) {
      const c = byId.get(hit.id);
      if (!c) continue;
      out.push({ path: c.path, title: c.title, category: c.category, score: hit.score });
    }
    return out;
  }

  private async writeNoteFile(path: string, content: string, overwrite?: string): Promise<TFile | null> {
    const normalized = normalizePath(path);
    if (overwrite) {
      const f = this.app.vault.getAbstractFileByPath(normalized);
      if (f instanceof TFile) {
        await this.app.vault.process(f, () => content);
        return f;
      }
    }
    await this.ensureParent(normalized);
    const existing = this.app.vault.getAbstractFileByPath(normalized);
    if (existing instanceof TFile) {
      await this.app.vault.process(existing, () => content);
      return existing;
    }
    return await this.app.vault.create(normalized, content);
  }

  private async ensureParent(path: string) {
    const idx = path.lastIndexOf("/");
    if (idx > 0) {
      const { ensureFolder } = await import("./media");
      await ensureFolder(this.app.vault, path.slice(0, idx));
    }
  }

  // ---------- 重试转写 ----------

  /** 在 vault 中按 ID 定位当前笔记路径（文件可能被分类回填等外部操作移动过）。
   *  实现（索引 → 全量扫描 → douyin_id frontmatter 三层兜底）随 P1-1 拆至 syncLedger.ts，
   *  逐行保真搬运；app 引用与 settings.rootFolder 由 ledger 构造注入。 */
  private findNotePath(id: string): string | null {
    return this.ledger.findNotePath(id);
  }

  /** 仅更新笔记逐字稿 warning 区块的错误文本（不动笔记其他内容） */
  private async writeAsrErrorNote(path: string, error: string) {
    try {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) return;
      // 错误文本压成一行（第九轮 A7）：多行错误直接嵌入会让后续行失去 `>` 前缀，
      // callout 结构与块尾判定（\n\n / \n---）都被扰动
      const text = error.replace(/\r?\n/g, " ").replace(/^>+\s*/, "").slice(0, 300);
      // vault.process 原子读改写（第九轮 B8）：原 read→modify 两段式在 await 窗口内
      // 会用陈旧快照覆盖用户编辑，与全仓其他写点的口径一致化
      await this.app.vault.process(file, (cur) => {
        const idx = cur.indexOf("> [!warning]- 逐字稿");
        if (idx < 0) return cur; // 已是成功/其他状态，不动
        const ends = [cur.indexOf("\n\n", idx), cur.indexOf("\n---", idx)].filter((x) => x > 0);
        const end = ends.length ? Math.min(...ends) : cur.length;
        const block = [
          "> [!warning]- 逐字稿",
          `> 转写未成功：${text}`,
          "> 可用命令「重试失败转写」重试。",
        ].join("\n");
        return cur.slice(0, idx) + block + cur.slice(end);
      });
    } catch {
      // 回写失败不影响主流程
    }
  }

  // ---------- ASR 重试台账（性能治理 P1，实现随 P1-1 拆至 syncLedger.ts）----------

  /** 失败入队：登记待重试 id 与重试台账（首次 attempts=0，立即可试）。 */
  private enqueueAsrRetry(id: string, error: string): void {
    this.ledger.enqueueAsrRetry(id, error);
  }

  /** 记一次重试失败：次数 +1，按阶梯设置下次可重试时间；达上限标记 dead（不再自动重试）。 */
  private bumpAsrRetry(id: string, error: string): void {
    this.ledger.bumpAsrRetry(id, error);
  }

  /** 结清：移出待重试队列并删除台账（转写成功 / 确认无语音 / 条目已失效）。 */
  private clearAsrRetry(id: string): void {
    this.ledger.clearAsrRetry(id);
  }

  /** 预算顺延（第四轮声明、第六轮补实现）：转写预算耗尽时把新条目排进下次同步，不计失败不进退避。 */
  private deferAsrToNextSync(id: string): void {
    if (!this.state.pendingAsr.includes(id)) this.state.pendingAsr.push(id);
    if (!this.state.asrRetry) this.state.asrRetry = {};
    if (!this.state.asrRetry[id]) {
      this.state.asrRetry[id] = {
        attempts: 0,
        lastError: "转写预算耗尽，顺延到下次同步",
        nextRetryAt: new Date().toISOString(),
      };
    }
  }

  // ---------- 转写结果暂存（第九轮 B3：防「转写成功但写笔记失败」重复计费；随 P1-1 拆至 syncLedger.ts） ----------

  /** 转写成功即暂存（FIFO ≤20 条防 data.json 膨胀）；写笔记成功后由 finalizeProcessed 清除。 */
  private stashTranscript(id: string, asr: AsrResult): void {
    this.ledger.stashTranscript(id, asr);
  }

  /** 查暂存（只窥不取；F7 供应商前缀匹配规则随 P1-1 拆至 syncLedger.peekStashedTranscript，逐行保真）。 */
  private peekStashedTranscript(id: string): AsrResult | null {
    return this.ledger.peekStashedTranscript(id);
  }

  /** 当前是否允许重试：已 dead 或未到退避时间点则跳过。 */
  private asrRetryReady(id: string): boolean {
    const e = this.state.asrRetry?.[id];
    if (!e) return true;
    if (e.dead) return false;
    const t = Date.parse(e.nextRetryAt);
    return !Number.isFinite(t) || t <= Date.now();
  }

  private async retryPendingAsr(budget: number, summary: SyncSummary, notice: Notice): Promise<number> {
    if (this.state.pendingAsr.length === 0 || budget <= 0 || this.settings.asrProvider === "none") {
      return budget;
    }
    // 性能治理 P1：只挑「未到退避时间 / 未 dead」的条目，避免对永久失败项无退避空转
    const ids = this.state.pendingAsr.filter((id) => this.asrRetryReady(id)).slice(0, budget);
    const deadCount = this.state.pendingAsr.filter((id) => this.state.asrRetry?.[id]?.dead).length;
    const deferred = this.state.pendingAsr.length - ids.length - deadCount;
    if (deadCount > 0) {
      summary.errors.push(`转写重试：${deadCount} 条已失败 ${ASR_RETRY_MAX} 次，放弃自动重试（见 state.asrRetry）`);
    }
    if (deferred > 0) summary.notices.push(`转写重试：${deferred} 条未到退避时间，本次跳过`);
    for (const id of ids) {
      const entry = this.state.processed[id];
      if (!entry || !entry.path) {
        this.clearAsrRetry(id); // 无可用笔记路径 → 无从重试，结清避免长期占位
        continue;
      }
      // entry.path 可能因外部移动（如分类回填）过期，按 ID 现场定位，避免在旧路径重建出重复笔记
      const located = this.findNotePath(id);
      if (!located) {
        const oldFile = this.app.vault.getAbstractFileByPath(normalizePath(entry.path));
        if (!(oldFile instanceof TFile)) {
          // 笔记已被用户删除（第九轮 A6）：尊重删除——结清重试队列但不再重建复活；
          // 保留 processed 台账，否则下轮同步会把它当新条目重建，删了又回来
          this.clearAsrRetry(id);
          this.markStateDirty();
          continue;
        }
      }
      const currentPath = located ?? entry.path;
      notice.setMessage(`抖音同步：重试转写 ${id}`);
      try {
        const raw = await this.client.getAwemeDetail(id);
        if (!raw) {
          summary.errors.push(`重试转写：无法获取详情 ${id}`);
          this.bumpAsrRetry(id, "无法获取作品详情");
          this.markStateDirty();
          continue;
        }
        // 来源还原（第四轮声明、第六轮接线）：按台账记录的来源重建，不再硬编码 collection
        const item = DouyinClient.normalize(raw, entry.source ?? "collection");
        if (!item) {
          this.clearAsrRetry(id); // 作品已不可解析（被删除 / 权限变更）→ 不再重试
          this.markStateDirty();
          continue;
        }
        if (item.type !== "video") {
          this.clearAsrRetry(id); // 类型已非视频 → 无转写语义，结清
          this.markStateDirty();
          continue;
        }
        if (isAudioOnlyItem(item)) {
          // 无视频轨条目（aweme_type=163）：重试也拿不到视频轨，只会转出 BGM。
          // 改写笔记为「未转写」并结清台账 —— 这 5 条曾在此处无限空转（attempts 2~3 → dead）。
          const ok = await this.processItem(item, entry.folder, summary, notice, currentPath, {
            status: "unavailable",
            transcript: "",
            provider: "none",
            error: AUDIO_ONLY_REASON,
          });
          if (ok) {
            this.state.processed[id].asrStatus = "unavailable";
            this.state.processed[id].path = currentPath;
            this.clearAsrRetry(id);
            summary.asrSkipped++;
          } else {
            // 笔记写入失败（复审 P2）：不能照常结清，否则该条目带着旧台账永离重试队列
            this.bumpAsrRetry(id, "音频类条目笔记写入失败");
          }
          this.markStateDirty();
          budget--;
          await sleep(300);
          continue;
        }
        // B3（第九轮）：转写结果暂存命中 → 不再调 provider 重新计费，直接复用上次已付费的转录
        const stashed = this.peekStashedTranscript(id);
        let provider: ReturnType<typeof createAsrProvider> = null;
        if (!stashed) {
          provider = createAsrProvider(this.settings, this.client, {
            resolveAudio: (url, videoId, durationSec) =>
              this.videoMedia.getAudio(videoId ?? "", url, durationSec ?? item.durationSec),
          });
          if (!provider) {
            // 配置不全不再静默空转（第六轮，复审遗留）：原实现每次同步选中该条目却什么都不做，
            // 条目永久占据队列且用户无感知。记一次退避并写明原因，到上限转 dead-letter 有据可查。
            this.bumpAsrRetry(id, `ASR 配置不全（provider=${this.settings.asrProvider}，请检查设置页密钥）`);
            this.markStateDirty();
            continue;
          }
        }
        const asr = stashed ?? (await provider!.transcribe(item.playUrl, item.id, { durationSec: item.durationSec }));
        if (asr.status === "success") {
          if (!stashed) {
            summary.transcribed++;
            this.stashTranscript(id, asr);
          }
          // 重新生成笔记（按定位到的当前路径；复用已得转写，不再二次转写）
          const ok = await this.processItem(item, entry.folder, summary, notice, currentPath, asr);
          if (ok) {
            this.state.processed[id].asrStatus = "success";
            this.state.processed[id].path = currentPath;
            this.clearAsrRetry(id);
          } else {
            // 笔记写入失败（复审 P2）：已付费的转写结果没落进笔记时不能谎报成功并结清台账，
            // 否则该条目永离重试队列（笔记停留旧状态、转写费白花）；保住条目下轮再试
            this.bumpAsrRetry(id, "转写成功但笔记写入失败");
          }
          this.markStateDirty();
        } else if (asr.status === "unavailable") {
          // 无可转写内容（纯音乐/无对白等）——重写笔记说明并移出队列，不再反复重试
          const ok = await this.processItem(item, entry.folder, summary, notice, currentPath, asr);
          if (ok) {
            this.state.processed[id].asrStatus = "unavailable";
            this.state.processed[id].path = currentPath;
            this.clearAsrRetry(id);
          } else {
            this.bumpAsrRetry(id, "确认无可转写内容但笔记写入失败");
          }
          this.markStateDirty();
          summary.asrFailed++;
        } else {
          summary.asrFailed++;
          // 记一次失败：次数 +1 并按阶梯退避；达上限自动转 dead-letter
          this.bumpAsrRetry(id, asr.error ?? "未知错误");
          // 把真实失败原因回写进笔记的逐字稿区块，便于排查（成功路径由 processItem 全量重写）
          await this.writeAsrErrorNote(currentPath, asr.error ?? "未知错误");
          // 清掉本次尝试的素材缓存（复审 P2）：失败路径不走 processItem 的无条件 cleanup，
          // 毒化缓存会让下一次重试的 getAudio 秒失败，重试命令对该条目形同空转
          this.videoMedia.cleanup(id);
          this.markStateDirty();
        }
        budget--;
        await sleep(300);
      } catch (e: any) {
        summary.errors.push(`重试转写 ${id}：${String(e?.message ?? e).slice(0, 80)}`);
        this.bumpAsrRetry(id, String(e?.message ?? e));
        this.videoMedia.cleanup(id);
        this.markStateDirty();
      }
    }
    return budget;
  }

  // ---------- 批量补跑旧视频笔记 ----------

  /**
   * 对已同步的旧视频笔记批量补跑新流程（转录 + 抽帧 + 多模态摘要）。
   * 范围：frontmatter type 为「视频」且满足任一条件的笔记——缺逐字稿、缺摘要块、
   * 关键帧数少于当前设置（补帧）。已有成功转录的直接复用，不重复调用 ASR。
   * 预算复用 maxTranscribePerSync。
   */
  async backfillVideos(
    onProgress?: (text: string) => void,
    opts?: { zeroAsrBudget?: boolean },
    out?: BackfillTally, // 批次二 G 可选出参：本轮 done / failed（返回字符串形态不变，见 backfillVision 注释）
  ): Promise<string> {
    if (this.running) throw new Error("同步正在进行中");
    this.running = true;
    if (out) {
      out.done = 0;
      out.failed = 0;
    }
    const summary = newSyncSummary();
    try {
      this.refreshClients(); // 同 syncAll：按最新设置重建 AI 客户端
      // 配额熔断复位（每轮重新探测，见字段注释）
      this.videoSummaryQuotaFails = 0;
      this.videoSummaryQuotaDead = false;
      // 转写预算语义与同步路径对齐（第九轮 A11）：0 = 不再转写（原 Math.max(1,…) 会让
      // 「用户设 0 禁用转写」的意图在补跑里照样白转 1 条）。预算 0 时只补「可复用已有转录」
      // 的候选（摘要/帧工作，零 ASR 计费），上限 50 条防一次点击跑完全库。
      // zeroAsrBudget（2026-10-16 自动重试链）：同步收尾自动补摘要缺口时强制走预算 0 语义
      // ——只重出「已有转录」的摘要，零转写计费；处理 0 且失败 0 时返回空串（不弹 Notice）。
      const budget = opts?.zeroAsrBudget ? 0 : Math.max(0, this.settings.maxTranscribePerSync);
      const REUSE_ONLY_CAP = 50;
    // 强制重抽一次性标志（keyframeIntervalSec 不追溯的逃生门）：本轮候选筛选忽略已存间隔，
    // 全部视频强制重抽；本轮完成后自动清除（异常中断不清，留给下轮继续）。
    const forceResync = this.state.forceFrameResync === true;
    let done = 0;
    let skipped = 0;
    let failed = 0;

    // ---- 阶段一：串行筛选候选 ----
    // 读笔记 + 正则判定单条约 1ms，串行足够且能保持 budget / skipped 语义简单；
    // 真正耗时的是阶段二（下载 + 抽帧 + 转写 + 摘要），那部分才需要并发。
    interface BackfillJob {
      id: string;
      currentPath: string;
      folder: string;
      source?: ItemSource;
      asrOverride?: AsrResult;
      frameHint?: string[];
      /** 帧网格未达标（间隔改过 / 从未抽出）→ 明确重抽意图，禁止 reused 帧劫持（第九轮 A1） */
      reextract?: boolean;
    }
    const jobs: BackfillJob[] = [];
    for (const id of Object.keys(this.state.processed)) {
      if (budget > 0 && jobs.length >= budget) break;
      const entry = this.state.processed[id];
      // 补跑连续失败 ≥3 次的条目本轮直接跳过（第四轮声明、第六轮接线）：候选按台账插入序取前
      // budget 个，队首固定是最早一批——CDN 已失效的条目每次补跑都占据名额（每次 = 一次全片下载），
      // 尾部健康笔记永远轮不到；成功即清除计数，给过去失败过的条目留恢复通道
      if ((this.state.backfillFails?.[id] ?? 0) >= 3) continue;
      const currentPath = this.findNotePath(id) ?? entry?.path;
      if (!currentPath) continue;
      const file = this.app.vault.getAbstractFileByPath(normalizePath(currentPath));
      if (!(file instanceof TFile)) continue;
      let content: string;
      try {
        content = await this.app.vault.read(file);
      } catch {
        continue;
      }
      // type 判断必须引号无关：processFrontMatter 写回 summary 后会把 YAML 里的引号去掉（type: 视频）。
      // 判定一律先切 frontmatter 区间（2026-09-27 修）：整篇 /m 匹配时正文同名行（逐字稿/OCR 文本）会劫持分支
      const fm = frontmatterBlock(content);
      if (!/^type:\s*"?(视频)"?\s*$/m.test(fm)) continue; // 只补跑视频类；图文类维持原逻辑
      const transcriptOk = /^transcript_status:\s*"?success"?/m.test(fm);
      // 终态（success / unavailable / not_requested）都不该再补跑：unavailable 是「已确认无可转写内容」，
      // 不纳入终态会让这些笔记每次补跑都被重写一遍（2026-09-21 修）。
      const transcriptTerminal = /^transcript_status:\s*"?(success|unavailable|not_requested)"?/m.test(fm);
      // 所有权判定与 statusCore 整行全等口径一致（第六轮）：裸 includes 会被用户自建的
      // 同名 callout 或正文引用行误命中，让缺摘要的笔记被判定「已有摘要」跳过补跑
      const hasSummary = /^> \[!abstract\]- 摘要\s*$/m.test(content);
      // 抽帧不追溯（keyframeIntervalSec 行为变更，用户已批准）：存的 frame_interval 与当前
      // 设置不一致不再触发自动重抽——帧网格存在、或已按某个间隔尝试过（storedInterval>0）
      // 即视为完成，复用时回写保持原值。只有从未抽过帧（无帧文件且无 frame_interval 记录）
      // 才按当前设置补抽；全量强制重抽走命令面板的 forceFrameResync 一次性标志。
      const framePaths = listVideoFramePaths(this.app.vault, this.settings.mediaFolder, id);
      const storedInterval = parseInt((fm.match(/^frame_interval:\s*(\d+)\s*$/m) ?? [])[1] ?? "0", 10) || 0;
      const framesOk = framePaths.length > 0 || storedInterval > 0;
      // 摘要格式健康判定（批次二 v4 升版，2026-10-16 拍板）：summary_v >= 3 即健康——
      // 升 v4 只改「写法」（一行式哨兵 / 单总结层 / ≤600 字）不改「判定」，v3 存量摘要
      // 不因升版被批量重出（584 篇存量内容不动），只有无摘要块的笔记进补跑候选。
      const summaryVStored = parseInt((fm.match(/^summary_v:\s*(\d+)\s*$/m) ?? [])[1] ?? "0", 10) || 0;
      const summaryFormatOk = summaryVStored >= 3;
      // 强制重抽轮（forceFrameResync）：跳过判定整体失效，所有视频笔记都进候选集
      if (!forceResync && transcriptTerminal && hasSummary && framesOk && summaryFormatOk) {
        skipped++;
        continue;
      }
      // 转录已成功时复用笔记里的逐字稿（不重复计费 ASR）；帧网格已达标时复用已入库帧，跳过视频重新拉取
      let asrOverride: AsrResult | undefined;
      if (transcriptOk) {
        const providerName = (fm.match(/^transcript_provider:\s*"?([^"\n]*)"?\s*$/m) ?? [])[1] ?? "";
        const transcript = extractSummarySources(content).transcript;
        // 逐字稿为空时不再盖章 success（第九轮 A8）：frontmatter success + 正文空块的自相矛盾
        // 会让补跑终态判定恒真、矛盾永久化——回退 undefined 走正常转写流程自愈
        if (transcript.trim()) {
          asrOverride = { status: "success", transcript, provider: providerName || "reused" };
        }
      }
      // 强制重抽轮不传 frameHint：必须走全片重新拉取 + 按当前设置重抽
      const frameHint = !forceResync && framesOk && this.settings.videoSummaryEnabled ? framePaths : undefined;
      // 预算 0（禁用转写）时只保留「可复用已有转录」的免费候选（第九轮 A11）
      if (budget <= 0) {
        if (!asrOverride) continue;
        if (jobs.length >= REUSE_ONLY_CAP) break;
      }
      jobs.push({
        id,
        currentPath,
        folder: entry.folder || "",
        source: entry.source,
        asrOverride,
        frameHint,
        reextract: forceResync || !framesOk,
      });
    }

    // ---- 阶段二：限并发补跑（性能治理 P0-3）----
    // 单条含「下载全片 + 抽帧 + 转写 + 多模态摘要」，串行跑 300 条要数小时；并发后由各条等待重叠。
    const limit = clampConcurrency(this.settings.syncConcurrency, 3);
    let started = 0;
    const results = await mapLimit(jobs, limit, async (job) => {
      started++;
      onProgress?.(`补跑视频 ${job.id}（已启动 ${started}/${jobs.length}）`);
      try {
        // 详情请求过串行闸门（第四轮声明、第六轮接线）：直连模式下并发条目各自 getAwemeDetail
        // 会绕开「抖音 API 串行」的风控口径；桥接模式桥内本已串行，闸门只是无害复述
        const raw = await this.detailGate.run(() => this.client.getAwemeDetail(job.id));
        // 来源还原（第四轮声明、第六轮接线）：按台账来源重建，不再硬编码 collection
        const item = raw ? DouyinClient.normalize(raw, job.source ?? "collection") : null;
        if (!item) {
          summary.errors.push(`补跑 ${job.id}：无法获取详情`);
          return false;
        }
        const ok = await this.processItem(
          item,
          job.folder,
          summary,
          undefined,
          job.currentPath,
          job.asrOverride,
          job.frameHint,
          job.reextract,
        );
        if (ok) this.state.processed[job.id].path = job.currentPath;
        this.markStateDirty();
        return ok;
      } catch (e: any) {
        summary.errors.push(`补跑 ${job.id}：${String(e?.message ?? e).slice(0, 80)}`);
        return false;
      }
    });
    for (let i = 0; i < results.length; i++) {
      const ok = results[i];
      const id = jobs[i]?.id;
      if (ok) {
        done++;
        // 成功即清除连续失败计数（第四轮声明、第六轮接线）
        if (id && this.state.backfillFails) delete this.state.backfillFails[id];
      } else {
        failed++;
        if (id) {
          this.state.backfillFails ??= {};
          this.state.backfillFails[id] = (this.state.backfillFails[id] ?? 0) + 1;
        }
      }
    }
    // 强制重抽轮收尾：本轮（候选集确定、任务全部派发）即视为完成 → 自动清除标志并报数。
    // 候选集受 maxTranscribePerSync 预算与 REUSE_ONLY_CAP 约束时，报数=实际派发的强制条数，
    // 未跑完的条目下轮补跑仍按新语义处理（帧间隔已不追溯，不会自动重抽）。
    if (forceResync) {
      summary.forcedFrameResync = jobs.length;
      this.state.forceFrameResync = false;
    }
    await this.saveState();
    if (out) {
      out.done = done;
      out.failed = failed;
    }
    // zeroAsrBudget 自动链静默语义：本轮没有任何实际工作（全健康/无候选）→ 空串不弹 Notice
    if (opts?.zeroAsrBudget && done === 0 && failed === 0) return "";
    const parts = [`补跑完成：处理 ${done}，跳过 ${skipped}，失败 ${failed}`];
    if (forceResync) parts.push(`强制重抽 ${summary.forcedFrameResync} 条`);
    if (summary.errors.length) parts.push(`注意：${summary.errors[0]}`);
    return parts.join("。");
    } finally {
      this.running = false;
    }
  }

  /**
   * 图文 OCR 补录（2026-10-16 批次一/批次二共用基建）：
   * 扫描已落账的图文笔记，找出「无图片文字块」（历史遗留，首次同步无 Key 的 168 条 +）
   * 或「块内含识别失败 / 空文本段」的条目，重新识别后按图序号原位回写
   * （upsertOcrRowsToCallout：成功段不重打 → 零重复计费）。
   * 候选上限 VISION_BACKFILL_CAP 条/轮；失败计数复用 backfillFails（连续 ≥3 跳过，防死循环）。
   * 消费方：同步收尾自动补录（main.runSync）、命令/面板「补录图文 OCR」、批次二全量存量补录。
   * 返回给用户看的一句话；空串 = 无事发生（未启用 / 未配置 / 无缺口），调用方静默。
   * out（批次二 G 可选出参）：本轮 done / failed 计数——backfillAll 循环终止与累计统计用，
   * 返回字符串形态不变，既有调用方（runSync 自动链 / 命令）零改动。
   */
  async backfillVision(onProgress?: (text: string) => void, out?: BackfillTally): Promise<string> {
    if (this.running) throw new Error("同步正在进行中");
    // out 归零放在所有 return 之前：门未通（未启用）的早退路径也要把计数复位为 0/0
    if (out) {
      out.done = 0;
      out.failed = 0;
    }
    if (!this.settings.enableVision) return "";
    this.running = true;
    try {
      this.refreshClients();
      const ai = this.visionAi || this.ai;
      if (!ai) return ""; // OCR 通道未配置（视觉 Base URL / Key）
      const gate = this.ocrGate;
      const CAP = 30;
      let processed = 0; // 已发起详情请求的条数（含成功/失败）
      let done = 0;
      let failed = 0;
      let healthy = 0;
      const errors: string[] = [];
      const bumpFail = (id: string) => {
        this.state.backfillFails ??= {};
        this.state.backfillFails[id] = (this.state.backfillFails[id] ?? 0) + 1;
      };
      for (const [id, entry] of Object.entries(this.state.processed)) {
        if (processed >= CAP) break;
        // 连续失败 ≥3 的条目本轮跳过（与 backfillVideos 同款防死循环，成功即清除）
        if ((this.state.backfillFails?.[id] ?? 0) >= 3) continue;
        const currentPath = this.findNotePath(id) ?? entry?.path;
        if (!currentPath) continue;
        const file = this.app.vault.getAbstractFileByPath(normalizePath(currentPath));
        if (!(file instanceof TFile)) continue;
        let content: string;
        try {
          content = await this.app.vault.read(file);
        } catch {
          continue;
        }
        // 只补图文类（typeLabel 与 noteBuilder 一致：note →「图文」）
        const fm = frontmatterBlock(content);
        if (!/^type:\s*"?(图文)"?\s*$/m.test(fm)) continue;
        // 缺口判定：无图片文字块（历史遗留）或存在失败/空文本段
        const reused = collectExistingAssets(content);
        const needRows =
          reused.visionTexts.length === 0
            ? null // 无块：详情拉取后按全部图片序号识别
            : reused.visionTexts.filter(
                (r) => !r.text.trim() || r.text.trim() === "（无文字）" || /识别失败/.test(r.status),
              );
        if (reused.visionTexts.length > 0 && needRows!.length === 0) {
          healthy++;
          continue;
        }
        processed++;
        onProgress?.(`补录图文 OCR：已处理 ${done + failed}/${CAP}`);
        // 详情过串行闸门（与补跑同款口径：直连并发会绕开抖音 API 串行风控）
        let item: SyncItem | null = null;
        try {
          const raw = await this.detailGate.run(() => this.client.getAwemeDetail(id));
          item = raw ? DouyinClient.normalize(raw, entry.source ?? "collection") : null;
        } catch (e: any) {
          errors.push(`${id}：详情获取失败（${String(e?.message ?? e).slice(0, 60)}）`);
          failed++;
          bumpFail(id);
          continue;
        }
        // 无详情 / 非图文 / 无图：无可补对象，跳过不记失败（避免把「作品无图」当故障反复重试）
        if (!item || item.type !== "note" || item.imageUrls.length === 0) {
          healthy++;
          continue;
        }
        // 图片下载入库（downloadImages 内部已存在即跳过，零重复下载）→ OCR 输入优先本地字节
        let localByIndex: Map<number, string>;
        try {
          localByIndex = (await this.downloadImages(item, null)).localImageByIndex;
        } catch (e: any) {
          errors.push(`${id}：图片下载失败（${String(e?.message ?? e).slice(0, 60)}）`);
          failed++;
          bumpFail(id);
          continue;
        }
        // 只识别缺口图；needRows 里的 index 可能超出本次详情的图片范围（抖音侧改图/删图）→ 丢弃
        const maxN = Math.min(item.imageUrls.length, this.settings.maxImages);
        const targets = (
          needRows ? needRows.map((r) => r.index - 1) : Array.from({ length: maxN }, (_, i) => i)
        ).filter((i) => i >= 0 && i < maxN);
        const rows = await mapLimit(targets, 2, async (i) => {
          const url = item!.imageUrls[i];
          try {
            const localPath = localByIndex.get(i);
            const dataUrl =
              (localPath ? await this.media.dataUrlFromFile(localPath) : "") ||
              (await this.media.toDataUrl(url)) ||
              url;
            const text = await (gate
              ? gate.run(() => ai!.ocrImage(dataUrl, item!.title))
              : ai!.ocrImage(dataUrl, item!.title));
            return { index: i + 1, text, status: text ? "识别成功" : "未识别" };
          } catch (e: any) {
            return { index: i + 1, text: "", status: `识别失败：${String(e?.message ?? e).slice(0, 60)}` };
          }
        });
        if (!rows.some((r) => r.text.trim() !== "")) {
          errors.push(`${id}：本轮 0 张识别成功`);
          failed++;
          bumpFail(id);
          continue;
        }
        await this.app.vault.process(file, (data) => upsertOcrRowsToCallout(data, rows));
        done++;
        if (this.state.backfillFails) delete this.state.backfillFails[id];
      }
      await this.saveState();
      if (out) {
        out.done = done;
        out.failed = failed;
      }
      if (done === 0 && failed === 0) return ""; // 无缺口 / 全健康 → 静默
      const parts = [`图文 OCR 补录：处理 ${done}，失败 ${failed}，健康 ${healthy}`];
      if (errors.length) parts.push(`注意：${errors[0]}`);
      return parts.join("。");
    } finally {
      this.running = false;
    }
  }

  // ---------- 批次二维护命令（2026-10-16）：未分类补跑 AI 分类 / folder 错位修复 ----------

  /** 分类补跑上限（条/轮）：一次点击跑完 500+ 篇未分类既打爆 AI 通道也让 Notice 失去意义。 */
  private static readonly RECATEGORIZE_CAP = 50;

  /**
   * 未分类笔记补跑 AI 分类（批次二 C）：
   * 遍历 processed 台账 → frontmatter category 为空 / 「未分类」的笔记 → 用「fm title +
   * 正文 OCR 文本 / 逐字稿」作分类输入调 AI → ①fm category 回填 ②移动文件到
   * <rootFolder>/<新分类>/<原文件名> ③台账 processed[id].path 同步 + 反向索引失效。
   * 「其他（不好分类）」或 AI 失败：frontmatter 保持未分类不动，不计失败（下轮命令再跑）；
   * 失败计数复用 backfillFails（连续 ≥3 跳过，与 backfillVideos / backfillVision 同口径）。
   * 返回给用户看的一句话汇总；门未通（未启用分类 / 通道未配置）返回说明文案。
   */
  async recategorizeUncategorized(onProgress?: (text: string) => void): Promise<string> {
    if (this.running) throw new Error("同步正在进行中");
    this.running = true;
    try {
      this.refreshClients(); // 与 syncAll / 补跑同口径：按最新设置重建 AI 客户端
      if (!this.settings.enableCategory || !this.ai) {
        return "AI 分类未启用或通道未配置（请开启「AI 分类」并配置通用 AI Key）";
      }
      const cats = parseList(this.settings.aiCategories);
      if (cats.length === 0) {
        return "AI 分类未启用或通道未配置（分类列表为空，请在设置中填写）";
      }
      const CAP = SyncEngine.RECATEGORIZE_CAP;
      let candidates = 0;
      let done = 0;
      let failed = 0;
      let skipped = 0;
      const bumpFail = (id: string) => {
        this.state.backfillFails ??= {};
        this.state.backfillFails[id] = (this.state.backfillFails[id] ?? 0) + 1;
      };
      for (const [id, entry] of Object.entries(this.state.processed)) {
        if (candidates >= CAP) break;
        // 连续失败 ≥3 的条目本轮跳过（防死循环，与补跑/OCR 补录同口径）
        if ((this.state.backfillFails?.[id] ?? 0) >= 3) {
          skipped++;
          continue;
        }
        const currentPath = this.findNotePath(id) ?? entry?.path;
        if (!currentPath) continue;
        const file = this.app.vault.getAbstractFileByPath(normalizePath(currentPath));
        if (!(file instanceof TFile)) continue;
        let content: string;
        try {
          content = await this.app.vault.read(file);
        } catch {
          continue;
        }
        // 候选判定：frontmatter category 为空或「未分类」（引号无关，与 buildNote 的 yamlStr 写回口径一致）
        const fm = frontmatterBlock(content);
        const curCategory = (fm.match(/^category:\s*"?([^"\n]*)"?\s*$/m) ?? [])[1]?.trim() ?? "";
        if (curCategory && curCategory !== "未分类") continue;
        candidates++;
        onProgress?.(`分类补跑：已处理 ${done + failed}/${CAP}`);
        // 分类输入与同步路径 categorizeItem 同构：标题 + 描述（OCR 文本代） + 逐字稿摘录
        //（categorize 内部自带 desc 300 / transcript 800 的码点截断，这里只做去空行整形）
        const title = (fm.match(/^title:\s*"?([^"\n]*)"?\s*$/m) ?? [])[1]?.trim() || file.basename;
        const { transcript, ocrText } = extractSummarySources(content);
        const desc = ocrText.replace(/\s+/g, " ").trim();
        let newCategory: string;
        try {
          newCategory = await this.ai.categorize(cats, title, desc, transcript);
        } catch (e: any) {
          failed++;
          bumpFail(id);
          continue;
        }
        // 「其他（不好分类）」/ 空 / 未分类：保持现状不动，不计失败（下轮命令再跑）
        if (!newCategory || newCategory === "未分类" || newCategory === "其他（不好分类）") continue;
        try {
          // ① fm category 回填（先改内容后移动：vault.process 需要 TFile 引用，移动后旧引用失效）
          await this.app.vault.process(file, (data) => upsertFmScalar(data, "category", newCategory));
          // ② 移动文件到 <rootFolder>/<新分类>/<原文件名>（目录不存在则逐级创建；
          //    fileManager.renameFile 是 Obsidian 的移动原语，链接与索引随动）
          const target = normalizePath(`${this.settings.rootFolder}/${newCategory}/${file.name}`);
          const parentIdx = target.lastIndexOf("/");
          await ensureFolder(this.app.vault, parentIdx > 0 ? target.slice(0, parentIdx) : "/");
          await this.app.fileManager.renameFile(file, target);
          // ③ 台账与反向索引同步（findNotePath 三层兜底之一就是索引，不更新会在旧路径重建出重复笔记）
          this.state.processed[id].path = target;
          this.noteIndexGet().set(id, target);
          done++;
          if (this.state.backfillFails) delete this.state.backfillFails[id];
        } catch (e: any) {
          // 批次三加固（QA 观察项②，best-effort 补偿）：移动失败时 fm 已改——回滚 category，
          // 避免「fm 说新分类、文件还在旧目录」的中间态留到下一轮。回滚失败（同一文件刚写失败，
          // 再写大概率也失败）只留 console，失败计数照走，下轮命令可自愈。
          try {
            await this.app.vault.process(file, (data) => upsertFmScalar(data, "category", curCategory || "未分类"));
          } catch {
            console.warn(`[douyin-sync] 分类补跑回滚 category 失败（id=${id}），留下中间态待下轮修复`);
          }
          failed++;
          bumpFail(id);
        }
      }
      await this.saveState();
      if (candidates === 0) {
        return skipped > 0 ? `无未分类笔记（另有 ${skipped} 条连续失败被跳过）` : "无未分类笔记";
      }
      return `分类补跑：处理 ${done}，失败 ${failed}，跳过 ${skipped}`;
    } finally {
      this.running = false;
    }
  }

  /**
   * folder 字段错位修复（批次二 D）：
   * 候选 = processed 台账中「笔记实际所在目录（路径父段，且路径含 rootFolder/）≠ frontmatter
   * folder」的收藏类笔记——实际目录非「未分类」而 fm folder 为「未分类」/ 空是典型错位
   * （分类回填移动过文件）；台账 entry.folder 与实际目录不符的同样以实际目录为准统一修正。
   * 修复动作：①fm folder 回填为实际目录名 ②正文「来源」行内的（未分类）原位替换为
   * （实际目录名），其余文案逐字保留 ③台账 processed[id].folder 同步（防补跑再写错）。
   * ⚠️ 只修 folder 语义字段与来源行，绝不移动文件、绝不碰 category。无错位时返回明确文案。
   */
  async fixFolderMismatch(onProgress?: (text: string) => void): Promise<string> {
    if (this.running) throw new Error("同步正在进行中");
    this.running = true;
    try {
      let fixed = 0;
      let checked = 0;
      const rootPrefix = `${this.settings.rootFolder}/`;
      for (const [id, entry] of Object.entries(this.state.processed)) {
        const currentPath = this.findNotePath(id) ?? entry?.path;
        if (!currentPath) continue;
        // 只处理 rootFolder 之下的笔记（路径前缀含 rootFolder/），库外笔记不碰
        const relIdx = currentPath.indexOf(rootPrefix);
        if (relIdx < 0) continue;
        const rel = currentPath.slice(relIdx + rootPrefix.length);
        const slashIdx = rel.lastIndexOf("/");
        if (slashIdx <= 0) continue;
        const actualDir = rel.slice(0, slashIdx).split("/").pop() ?? "";
        if (!actualDir || actualDir === "未分类") continue; // 实际目录是「未分类」→ 不反向改写
        const file = this.app.vault.getAbstractFileByPath(normalizePath(currentPath));
        if (!(file instanceof TFile)) continue;
        let content: string;
        try {
          content = await this.app.vault.read(file);
        } catch {
          continue;
        }
        checked++;
        onProgress?.(`folder 错位修复：已修正 ${fixed}`);
        const fm = frontmatterBlock(content);
        // 引号无关读取 fm folder（processFrontMatter 写回后引号会被剥掉）
        const fmFolder = (fm.match(/^folder:\s*"?([^"\n]*)"?\s*$/m) ?? [])[1]?.trim() ?? "";
        // 错位 = 实际目录 ≠ fm folder（覆盖两种情形：fm=未分类/空，或 fm=别的收藏夹名但目录已变）
        if (fmFolder === actualDir) continue;
        // ① fm folder 回填为实际目录名
        await this.app.vault.process(file, (data) => upsertFmScalar(data, "folder", actualDir));
        // ② 正文「来源」行同步：noteBuilder 的元信息行是「作者：xx ｜ 来源：收藏（夹名） ｜ 链接」——
        //    来源不一定在行首，按「行内含 `来源：`」定位，只把该行内的（未分类）替换为（实际目录名），
        //    行内其余文案与所有其他行逐字保留；无（未分类）括注时替换零命中、内容零改动
        if (content.includes("来源：") && /（未分类）/.test(content.split("\n").filter((l) => l.includes("来源：")).join("\n"))) {
          await this.app.vault.process(file, (data) =>
            data.replace(/^.*来源：.*$/gm, (line) => line.replace(/（未分类）/g, `（${actualDir}）`)),
          );
        }
        // ③ 台账同步修正（processed[id].folder 不改的话，补跑重建路径会按旧 folder 再写错一次）
        if (entry) entry.folder = actualDir;
        fixed++;
      }
      await this.saveState();
      return fixed === 0 ? "无 folder 错位" : `folder 错位修复：修正 ${fixed}（检查 ${checked}）`;
    } finally {
      this.running = false;
    }
  }

  // ---------- 全量补录执行器（批次二 G，2026-10-16）----------

  /** 全量补录总轮数硬顶：60 轮 ≈ 60×(OCR 30 + 转写预算) 条，防「计数失灵 → 活锁」的最后保险。 */
  private static readonly BACKFILL_ALL_MAX_ROUNDS = 60;

  /**
   * 全量补录执行器（批次二 G）：循环执行「图文 OCR 补录 + 视频摘要补跑」两链直至无缺口。
   * 背景：存量缺口 526 篇无摘要 + 图文全库 OCR=0，两链单轮上限（30 条 / 转写预算）跑不完，
   * 手动点命令要几十次——本方法在整个循环期间持有 running 互斥，一次调用跑到底。
   * 预算语义：backfillVideos 走默认预算模式（不传 zeroAsrBudget）——全量补录允许为
   * 无转录的老视频付转写费，这正是「全量」的拍板语义。
   * 终止条件：
   * ① 正常收尾：一整轮两链都零工作量（done+failed 全为 0）= 无缺口可补；
   * ② 配额自愈：摘要链连续 3 轮配额熔断（quotaDead 每轮由 backfillVideos 复位后重新探测，
   *    连续置位 = 额度确实未恢复）→ 提前终止并注明疑似配额耗尽——继续循环只会白付
   *    「摘要永远写不出来」的重写成本；
   * ③ 硬顶 60 轮：计数逻辑万一失灵时的活锁保险。
   * 每轮结束 saveState（节流窗口崩溃也不丢已补条目）+ onProgress 汇报累计。
   */
  async backfillAll(onProgress?: (text: string) => void): Promise<string> {
    if (this.running) throw new Error("同步正在进行中");
    this.running = true;
    try {
      const MAX_ROUNDS = SyncEngine.BACKFILL_ALL_MAX_ROUNDS;
      const QUOTA_ZERO_ROUNDS = 3;
      let totalOcr = 0;
      let totalSummary = 0;
      let round = 0;
      let quotaStreak = 0;
      let stopReason = "";
      while (round < MAX_ROUNDS && !stopReason) {
        round++;
        const ocrOut: BackfillTally = { done: 0, failed: 0 };
        const sumOut: BackfillTally = { done: 0, failed: 0 };
        // 两链自带 running 互斥门；backfillAll 全程持有互斥，这里仅在同步前缀瞬间放行——
        // JS 单线程下从放行到链自身重新置位之间没有 await，其他命令插不进来；
        // 链的 finally 释放后由本方法的 finally 立即夺回，轮间 saveState 期间互斥仍在手
        this.running = false;
        try {
          await this.backfillVision(onProgress, ocrOut);
        } finally {
          this.running = true;
        }
        this.running = false;
        try {
          await this.backfillVideos(onProgress, undefined, sumOut); // 默认预算模式：全量语义允许付转写费
        } finally {
          this.running = true;
        }
        totalOcr += ocrOut.done;
        totalSummary += sumOut.done;
        await this.saveState();
        onProgress?.(`全量补录：已补 OCR ${totalOcr} / 摘要 ${totalSummary}，第 ${round} 轮`);
        // 终止①：正常收尾——一整轮两链零工作量
        if (ocrOut.done + ocrOut.failed === 0 && sumOut.done + sumOut.failed === 0) {
          stopReason = "";
          break;
        }
        // 终止②：配额熔断自愈——quotaDead 每轮由 backfillVideos 复位后重新探测，连续置位
        // = 额度确实未恢复。注意不看 sumOut.done：熔断轮内 processItem 仍会重写成功（done>0）
        // 但摘要一条也写不出来（runVideoSummary 对全条目 early-return），继续循环只是
        // 「摘要恒缺 → 候选恒在 → 反复重写」的活锁，按摘要链零产出提前终止
        if (this.videoSummaryQuotaDead) {
          quotaStreak++;
          if (quotaStreak >= QUOTA_ZERO_ROUNDS) {
            stopReason = `连续 ${quotaStreak} 轮摘要链配额熔断零产出，疑似配额耗尽，已提前终止（额度恢复后可再次执行）`;
          }
        } else {
          quotaStreak = 0;
        }
      }
      if (!stopReason && round >= MAX_ROUNDS) {
        stopReason = `已达总轮数上限 ${MAX_ROUNDS} 轮，如仍有缺口请再次执行`;
      }
      const head = `全量补录完成：OCR ${totalOcr} 条，摘要 ${totalSummary} 条，总轮数 ${round}`;
      return stopReason ? `${head}（${stopReason}）` : head;
    } finally {
      this.running = false;
    }
  }
}
