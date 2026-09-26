import { App, Notice, TFile, normalizePath } from "obsidian";
import { DouyinClient } from "./douyinClient";
import { createAsrProvider } from "./asr";
import { AiClient } from "./ai";
import { MediaStore } from "./media";
import { VideoMediaStore, VideoAssets } from "./videoMedia";
import { generateBases } from "./bases";
import { buildNote, planNotePath } from "./noteBuilder";
import { generateAndWriteVideoSummary, listVideoFramePaths } from "./videoSummaryService";
import { pushSummaryRecord } from "./summaryService";
import { extractSummarySources, collectExistingAssets, upsertAbstractBlock, type ReusedNoteAssets } from "./statusCore";
import {
  DouyinSyncSettings,
  SyncState,
  SyncItem,
  DouyinAwemeRaw,
  AsrResult,
  AsrRetryEntry,
  StageTimings,
  SOURCE_LABEL,
} from "./types";
import { nowIso, parseList, noteTitleFor, sleep } from "./util";
import { isAudioOnlyItem, AUDIO_ONLY_REASON } from "./itemType";
import { clampConcurrency, mapLimit, Semaphore } from "./concurrency";
import { detailStageTimings, summarizeStageTimings } from "./perf";

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
  errors: string[];
  startedAt: string;
  finishedAt: string;
}

/**
 * 「确定性失败」特征（2026-09-21 P2）：素材侧 / 条目结构 / 通道配置问题，
 * 重试必然复现同一结果 → 不进重试队列，避免每条白跑一次 ffmpeg + 一次上传。
 */
const DETERMINISTIC_ASR_FAILURE_RE =
  /不含视频轨|无法取得音频文件|未接入音频解析通道|音频抽取异常|无播放地址|空壳|未产出有效音轨|缺少 SiliconFlow API Key/;

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
const ASR_RETRY_MAX = ASR_RETRY_BACKOFF_MS.length;

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
    errors: [],
    startedAt: "",
    finishedAt: "",
  };
}

export class SyncEngine {
  state: SyncState = { processed: {}, pendingAsr: [] };
  running = false;
  /** id → 笔记路径反向索引（问题 8：替代每次重试的全 vault O(n) 扫描），懒建 + 存在性校验。 */
  private noteIndex: Map<string, string> | null = null;
  // ---------- 落盘节流（性能治理 P0-2）----------
  // 现状问题：processItem 每条都 await saveState()，而 data.json 全量约 689KB（含 Cookie 与全部台账），
  // 681 条 ≈ 458MB 累计写盘，且随台账增长呈 O(n²) 恶化。
  // 策略：普通进度点只标脏，累计 FLUSH_EVERY_OPS 条或距上次落盘超过 FLUSH_EVERY_MS 才真正写盘；
  // 同步结束 / 异常 / resetState 等关键节点仍强制落盘，保证状态不丢。
  private dirty = false;
  private opsSinceFlush = 0;
  private lastFlushAt = Date.now();
  private flushInFlight: Promise<void> | null = null;
  private client: DouyinClient;
  private media: MediaStore;
  private videoMedia: VideoMediaStore;
  private ai: AiClient | null = null;
  /** OCR 专用视觉通道：配了独立基址/Key 时与分类通道分离（实测硅基流动视觉模型会 503 过载） */
  private visionAi: AiClient | null = null;
  /** OCR 全局并发闸门：跨条目统一限流，避免条目级 × 图片级并发把请求放大 9 倍（见 visionConcurrency 说明） */
  private ocrGate: Semaphore | null = null;

  constructor(
    private app: App,
    private settings: DouyinSyncSettings,
    private onStateChange: () => Promise<void>,
    private onStatus: (text: string) => void,
    spawnBridge?: () => Promise<void>,
  ) {
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
    this.ai = null;
    this.visionAi = null;
    this.ocrGate = null;
    if (s.aiKey || s.dashscopeKey) {
      this.ai = new AiClient(s.aiBaseUrl, s.aiKey || s.dashscopeKey, s.aiModel);
      this.ai.setVisionModel(s.visionModel);
      // 超时下调（性能实测）：分类实测 0.2s、单图 base64 OCR 正常 <20s，
      // 默认 120s 只会让失败路径白等两分钟（原 OCR 的 240s 里就有这一项）。
      this.ai.setTimeoutMs(60_000);
    }
    // OCR 视觉通道：独立基址/Key 留空时复用通用 AI 通道。
    // 注意：若配了独立基址却复用主通道 Key，会出现「基址与 Key 不匹配」
    // （例如百炼基址 + 硅基流动 Key → 全部 401）。因此配了 visionBaseUrl 时，Key 优先取 visionApiKey，其次百炼 Key。
    const hasOwnVisionBase = !!s.visionBaseUrl.trim();
    const vKey = (
      s.visionApiKey ||
      (hasOwnVisionBase ? s.dashscopeKey : "") ||
      s.aiKey ||
      s.dashscopeKey
    ).trim();
    const vBase = (s.visionBaseUrl || s.aiBaseUrl).trim();
    if (vKey) {
      this.visionAi = new AiClient(vBase, vKey, s.aiModel, s.visionModel);
      this.visionAi.setTimeoutMs(60_000);
      this.ocrGate = new Semaphore(clampConcurrency(s.visionConcurrency, 3));
    }
  }

  /** ffmpeg 可用性检测（设置页按钮用）：返回版本首行或 null；force=true 绕过结果缓存重新探测。 */
  checkFfmpeg(force = false): Promise<string | null> {
    return this.videoMedia.checkFfmpeg(force);
  }

  async loadState(raw: unknown) {
    if (raw && typeof raw === "object") {
      const s = raw as Partial<SyncState>;
      this.state = {
        processed: s.processed ?? {},
        pendingAsr: s.pendingAsr ?? [],
        asrRetry: s.asrRetry ?? {},
        // 性能埋点（P2-15）：兼容旧 data.json，缺省给空数组
        metrics: s.metrics ?? [],
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
        vision: s.vision ?? [],
        summary: s.summary ?? [],
      };
      this.noteIndex = null; // 台账整体替换 → 反向索引失效，待懒建
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
    };
    this.noteIndex = null;
    void this.onStateChange();
  }

  /**
   * 标记进度已变更（节流路径）。绝大多数「处理完一条」的场景用这个，不要直接 await saveState()。
   * 达到条数阈值或时间阈值时异步触发落盘（fire-and-forget，不阻塞处理流水线）。
   */
  private markStateDirty() {
    this.dirty = true;
    this.opsSinceFlush++;
    if (this.opsSinceFlush >= FLUSH_EVERY_OPS || Date.now() - this.lastFlushAt >= FLUSH_EVERY_MS) {
      void this.flushState();
    }
  }

  /**
   * 立即落盘（关键节点：同步结束、异常退出、重置台账、插件卸载）。
   * 并发调用串行排队，落盘失败时重新标脏，由下一次落盘补写，避免状态丢失。
   */
  private async flushState(): Promise<void> {
    while (this.flushInFlight) await this.flushInFlight;
    if (!this.dirty) return;
    this.dirty = false;
    this.opsSinceFlush = 0;
    this.lastFlushAt = Date.now();
    const p = this.onStateChange().catch(() => {
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
  private async saveState() {
    this.dirty = true;
    await this.flushState();
  }

  /** 插件卸载前落盘（onunload 调用）：避免节流窗口内的进度丢失。 */
  flushNow(): Promise<void> {
    this.dirty = true;
    return this.flushState();
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
      return !Number.isFinite(t) || t >= from;
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

  /** 反向索引懒建（问题 8）：从 processed 台账一次性装载 id → path。 */
  private noteIndexGet(): Map<string, string> {
    if (!this.noteIndex) {
      const m = new Map<string, string>();
      for (const [id, entry] of Object.entries(this.state.processed)) {
        if (entry?.path) m.set(id, entry.path);
      }
      this.noteIndex = m;
    }
    return this.noteIndex;
  }

  // ---------- 主入口 ----------

  async syncAll(): Promise<SyncSummary> {
    if (this.running) throw new Error("同步正在进行中");
    this.running = true;
    const summary = newSyncSummary();
    summary.startedAt = nowIso();
    const notice = new Notice("抖音同步：开始…", 0);
    try {
      // 设置可能在本会话内被改过（Obsidian 改设置不会重载插件）→ 按最新设置重建 AI 客户端，
      // 否则「在设置页换了 OCR 通道/模型」不会生效（实测踩坑：换了通道仍打旧服务端并持续 503）。
      this.refreshClients();
      let asrBudget = this.settings.maxTranscribePerSync;

      // 1) 重试上次失败的转写
      asrBudget = await this.retryPendingAsr(asrBudget, summary, notice);

      const whitelist = parseList(this.settings.folderWhitelist);

      // 2) 收藏（收藏夹模式）
      if (this.settings.syncCollection) {
        let folderOk = false;
        if (this.settings.useFolderMode) {
          try {
            const folders = await this.client.listFolders(0, 100);
            const targets = whitelist.length ? folders.filter((f) => whitelist.includes(f.name)) : folders;
            if (folders.length === 0) {
              summary.errors.push("收藏夹列表为空（可能无收藏夹或接口变更）");
            }
            for (const f of targets) {
              this.onStatus(`同步收藏夹：${f.name}`);
              const n = await this.syncCollectionFolder(f.id, f.name, summary, notice);
              notice.setMessage(`抖音同步：收藏夹「${f.name}」新增 ${n}`);
            }
            folderOk = targets.length > 0 || whitelist.length > 0;
          } catch (e: any) {
            summary.errors.push(`收藏夹模式失败：${e?.message ?? e}`);
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
          if (n > 0) summary.errors.push(`已生成 ${n} 个 Bases 文件`);
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
        (summary.errors.length ? `。注意：${summary.errors[0]}` : "");
      notice.setMessage(msg);
      setTimeout(() => notice.hide(), 6000);
      this.onStatus(`上次同步 ${new Date().toLocaleTimeString("zh-CN")}`);
      return summary;
    } catch (e: any) {
      notice.setMessage(`抖音同步失败：${e?.message ?? e}`);
      setTimeout(() => notice.hide(), 8000);
      summary.errors.push(String(e?.message ?? e));
      summary.finishedAt = nowIso();
      return summary;
    } finally {
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
    const results = await mapLimit(fresh, limit, (it) => this.processItem(it, folder, summary, notice));
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
      processedStreak = r.streak;
      if (processedStreak >= this.settings.scanStopAfterProcessed) break;
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
      processedStreak = r.streak;
      if (processedStreak >= this.settings.scanStopAfterProcessed) break;
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
      processedStreak = r.streak;
      if (processedStreak >= this.settings.scanStopAfterProcessed) break;
      if (!res.hasMore || res.items.length === 0) break;
      cursor = res.cursor ?? cursor + 20;
      await sleep(600);
    }
  }

  // ---------- 单条处理 ----------

  private async processItem(
    item: SyncItem,
    folder: string,
    summary: SyncSummary,
    notice: Notice | undefined,
    overwritePath?: string,
    asrOverride?: AsrResult | null,
    frameHint?: string[],
  ): Promise<boolean> {
    try {
      // ---- 阶段耗时埋点（P2-15）----
      // 只做时间戳加减，不触碰任何控制流；结果进 state.metrics（保留最近 RECENT_METRICS 条）。
      // 目的：让 §8.6 的优化收益可被量化验证，而不是只能靠端到端时间反推。
      const perfT0 = Date.now();
      const perf: Record<string, number> = {};
      let ptStage = perfT0;
      const cut = (key: string) => {
        const now = Date.now();
        perf[key] = (perf[key] ?? 0) + (now - ptStage);
        ptStage = now;
      };

      notice?.setMessage(`抖音同步：处理 ${noteTitleFor(item.title, item.id).slice(0, 24)}`);
      // 素材错误类别按「条目」作用域清零：本次条目内 pullAssets 会重新写入，
      // 避免上一条的 no_video_track 残留污染本条的失败分类。
      this.videoMedia.lastErrorKind = "none";

      // 问题 6（重试路径）：只重跑 transcribe + writeNote；封面/图片/OCR/分类从既有笔记回收，
      // 不再触发二次下载、重复 OCR 与重复分类等全套副作用。回收失败则回退原联网路径。
      let reused: ReusedNoteAssets | null = null;
      if (overwritePath && asrOverride !== undefined) {
        try {
          const existingFile = this.app.vault.getAbstractFileByPath(normalizePath(overwritePath));
          if (existingFile instanceof TFile) {
            reused = collectExistingAssets(await this.app.vault.read(existingFile));
          }
        } catch {
          reused = null;
        }
      }
      cut("reuseMs");

      // 封面
      let coverPath = "";
      if (reused?.coverPath) {
        coverPath = reused.coverPath;
      } else if (this.settings.downloadCover && item.coverUrl) {
        coverPath = await this.media.saveImage(item.coverUrl, `cover/${item.id}`);
      }
      cut("coverMs");

      // 视频素材（转录用音频 + 关键帧）：视频类专用分支；图文类不转录不抽帧。
      // 重试路径（asrOverride 已带转写结果）不再为音频拉取，仅按需为摘要抽帧；
      // 关键帧优先复用既有笔记里已入库的帧网格（问题 6），避免重试时重新拉视频跑 ffmpeg。
      let assets: VideoAssets | null = null;
      if (item.type === "video") {
        const needAudio =
          asrOverride === undefined &&
          this.settings.asrProvider === "siliconflow_sensevoice" &&
          !!this.settings.siliconflowKey;
        const needFrames =
          this.settings.videoSummaryEnabled && !!(this.settings.aiKey || this.settings.dashscopeKey);
        const hint =
          frameHint && frameHint.length > 0 ? frameHint : reused?.framePaths.length ? reused.framePaths : undefined;
        if (needFrames && hint && hint.length > 0 && !needAudio) {
          // 补跑且关键帧网格已符合当前设置：直接复用已入库帧，跳过 ffmpeg 重新拉取
          assets = { audioPath: "", framePaths: hint };
        } else if (needAudio || needFrames) {
          assets = await this.videoMedia.pullAssets(item);
          if (!assets) {
            summary.errors.push(`[${item.id}] 视频素材拉取失败：${this.videoMedia.lastError.slice(0, 100)}`);
          }
        }
      }
      cut("ffmpegMs");

      // 图文图片（重试路径复用既有笔记中已入库的图片，不重复下载）
      const imagesDownloaded: string[] = [];
      if (reused?.images.length) {
        imagesDownloaded.push(...reused.images);
      } else if (item.type === "note" && this.settings.downloadImages) {
        const n = Math.min(item.imageUrls.length, this.settings.maxImages);
        for (let i = 0; i < n; i++) {
          const p = await this.media.saveImage(item.imageUrls[i], `images/${item.id}/${i + 1}`);
          if (p) imagesDownloaded.push(p);
          await sleep(200);
        }
      }
      cut("imagesMs");

      // 图片文字识别（重试路径复用既有笔记的识别文本，不重复调用视觉模型）
      const visionTexts: { index: number; text: string; status: string }[] = [];
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
        // 性能实测与根因（2026-09-19）：
        // ① 原实现把抖音 CDN 的图片 URL 直接交给视觉模型服务端拉取 → 拉取慢/被拒时撞满 120s 超时再走 base64 重试；
        //    而本地下载 10 张仅需 1.6s，故改为「先本地取字节转 base64」。
        // ② 改完仍慢（实测 42~1092s）。笔记里的失败原因揭示真凶：
        //    HTTP 503 {"code":50508,"message":"System is too busy now"} —— 视觉模型服务端过载。
        //    而条目级并发 3 × 图片级并发 3 = 9 路同时打过去，只会让它更过载、单张更慢。
        //    故 OCR 请求统一交给全局闸门（visionConcurrency）限流，与条目级并发解耦。
        const rows = await mapLimit(
          Array.from({ length: n }, (_, i) => i),
          2,
          async (i) => {
            const url = item.imageUrls[i];
            try {
              const dataUrl = (await this.media.toDataUrl(url)) || url; // 下载失败时退回 URL 直传
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
      cut("ocrMs");

      // ASR 逐字稿（asrOverride 非 undefined 时直接复用调用方结果，避免重试路径二次转写）
      let asr: AsrResult | null = null;
      if (asrOverride !== undefined) {
        asr = asrOverride;
      } else if (item.type === "video" && this.settings.asrProvider !== "none") {
        if (isAudioOnlyItem(item)) {
          // 策略 B（2026-09-21 实测定位）：aweme_type=163 / media_type=43 的条目在抖音侧
          // **不提供视频轨**——video.duration=0、bit_rate=[]、download_addr=[]，
          // play_addr.url_list[0] 直接指向背景音乐。本地 ffmpeg 拿不到视频轨（-map 0:v:0 必失败），
          // 而走 URL 直传通道转出来的只是 BGM 歌词。
          // 因此既不抽帧也不转写，直接记 unavailable 并移出重试队列，避免把配乐当逐字稿污染知识库。
          asr = { status: "unavailable", transcript: "", provider: "none", error: AUDIO_ONLY_REASON };
          summary.asrSkipped++;
          this.clearAsrRetry(item.id);
        } else {
          const provider = createAsrProvider(this.settings, this.client, {
            resolveAudio: (url, videoId, durationSec) =>
              this.videoMedia.getAudio(videoId ?? "", url, durationSec ?? item.durationSec),
          });
          if (provider && item.playUrl) {
            asr = await provider.transcribe(item.playUrl, item.id, { durationSec: item.durationSec });
            if (asr.status === "success") {
              summary.transcribed++;
            } else if (asr.status === "unavailable") {
              // 已调通接口、确认无可转写内容（纯音乐/无对白）→ 移出队列，不反复重试
              summary.asrFailed++;
              this.clearAsrRetry(item.id);
            } else {
              summary.asrFailed++;
              if (this.videoMedia.lastFailureDeterministic || DETERMINISTIC_ASR_FAILURE_RE.test(asr.error ?? "")) {
                // 素材侧失败是确定性的：重试必然复现同一结果，不入队（P2）
                this.clearAsrRetry(item.id);
                summary.errors.push(`转写失败（素材侧，不重试）：${(asr.error ?? "").slice(0, 70)}`);
              } else {
                this.enqueueAsrRetry(item.id, asr.error ?? asr.status);
              }
            }
          } else if (!item.playUrl) {
            asr = { status: "unavailable", transcript: "", error: "无播放地址" };
          }
        }
      }
      // 音频临时文件清理（帧图已入库 vault；缓存清除后下次需要时重新拉取）
      if (assets) this.videoMedia.cleanup(item.id);
      cut("asrMs");

      // AI 分类（重试路径复用既有分类，不重复调用文本模型）
      let category = "未分类";
      if (reused?.category) {
        category = reused.category;
      } else if (this.settings.enableCategory && this.ai) {
        const cats = parseList(this.settings.aiCategories);
        if (cats.length > 0) {
          try {
            category = await this.ai.categorize(cats, item.title, item.desc, asr?.transcript ?? "");
          } catch (e: any) {
            summary.errors.push(`分类失败：${String(e?.message ?? e).slice(0, 80)}`);
          }
        }
      }
      cut("categoryMs");

      // 写笔记
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
        keyframeIntervalSec: assets ? Math.max(1, Math.min(60, this.settings.keyframeIntervalSec || 10)) : 0,
        syncedAt: nowIso(),
      });
      const noteFile = await this.writeNoteFile(path, content, overwritePath);

      // 关键修复：重建笔记会清掉既有摘要（buildNote 不含摘要块/frontmatter summary）。
      // 先按既有摘要回填，保证「摘要重生成失败」不会把已有摘要永久抹掉；生成成功时再被覆盖。
      if (noteFile && reused?.summaryText) {
        try {
          await this.app.fileManager.processFrontMatter(noteFile, (fm: Record<string, unknown>) => {
            fm.summary = reused.summaryText;
            const v = parseInt(reused.summaryV, 10);
            fm.summary_v = Number.isFinite(v) && v > 0 ? v : 3;
          });
          const cur = await this.app.vault.read(noteFile);
          await this.app.vault.modify(noteFile, upsertAbstractBlock(cur, reused.summaryText));
        } catch {
          /* 回填失败不影响主流程 */
        }
      }
      cut("noteWriteMs");

      // 视频多模态综合总结（自动；图文类不走此分支）：转录文字 + 关键帧 → 百炼视觉模型
      if (
        item.type === "video" &&
        this.settings.videoSummaryEnabled &&
        (this.settings.aiKey || this.settings.dashscopeKey) &&
        noteFile
      ) {
        try {
          const r = await generateAndWriteVideoSummary(this.app, noteFile, this.settings, {
            title: item.title,
            desc: item.desc,
            transcript: asr?.transcript ?? "",
            framePaths: assets?.framePaths ?? [],
          });
          if (r.record) this.state.summary = pushSummaryRecord(this.state.summary, r.record);
          if (r.ok) {
            summary.videoSummaries++;
          } else {
            summary.errors.push(`[${item.id}] 视频摘要：${r.msg.slice(0, 100)}`);
          }
        } catch (e: any) {
          summary.errors.push(`[${item.id}] 视频摘要异常：${String(e?.message ?? e).slice(0, 80)}`);
        }
      }
      cut("summaryMs");

      this.state.processed[item.id] = {
        path,
        syncedAt: nowIso(),
        folder: folder || SOURCE_LABEL[item.source],
        asrStatus: asr?.status,
      };
      this.noteIndexGet().set(item.id, path); // 反向索引同步更新（问题 8）
      // 转写成功 / 确认无语音：结清重试台账
      if (asr?.status === "success" || asr?.status === "unavailable") {
        this.clearAsrRetry(item.id);
      }
      this.recordStageTimings(item, perf, Date.now() - perfT0);
      this.markStateDirty(); // 节流落盘（原 await saveState()：每条全量写 689KB）
      summary.created++;
      return true;
    } catch (e: any) {
      summary.errors.push(`[${item.id}] ${String(e?.message ?? e).slice(0, 100)}`);
      return false;
    }
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
   *  问题 8：先查反向索引（O(1)，含存在性校验），未命中才回退全量扫描并回填索引。 */
  private findNotePath(id: string): string | null {
    const suffix = `[${id}].md`;
    const root = this.settings.rootFolder + "/";
    // ① 索引命中且文件仍在原位 → 直接返回
    const cached = this.noteIndexGet().get(id);
    if (cached) {
      const f = this.app.vault.getAbstractFileByPath(normalizePath(cached));
      if (f instanceof TFile && f.name.endsWith(suffix)) return cached;
      this.noteIndexGet().delete(id); // 索引过期（外部移动 /删除），回退扫描
    }
    // ② 全量扫描兜底；多份时优先取非「未分类」目录的副本
    let found: string | null = null;
    for (const f of this.app.vault.getFiles()) {
      if (f.name.endsWith(suffix) && f.path.startsWith(root)) {
        if (!found || (found.includes("未分类") && !f.path.includes("未分类"))) found = f.path;
      }
    }
    if (found) this.noteIndexGet().set(id, found);
    return found;
  }

  /** 仅更新笔记逐字稿 warning 区块的错误文本（不动笔记其他内容） */
  private async writeAsrErrorNote(path: string, error: string) {
    try {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) return;
      const s = await this.app.vault.read(file);
      const idx = s.indexOf("> [!warning]- 逐字稿");
      if (idx < 0) return; // 已是成功/其他状态，不动
      const ends = [s.indexOf("\n\n", idx), s.indexOf("\n---", idx)].filter((x) => x > 0);
      const end = ends.length ? Math.min(...ends) : s.length;
      const block = [
        "> [!warning]- 逐字稿",
        `> 转写未成功：${error.replace(/^>+\s*/g, "").slice(0, 300)}`,
        "> 可用命令「重试失败转写」重试。",
      ].join("\n");
      await this.app.vault.modify(file, s.slice(0, idx) + block + s.slice(end));
    } catch {
      // 回写失败不影响主流程
    }
  }

  // ---------- ASR 重试台账（性能治理 P1）----------

  /** 失败入队：登记待重试 id 与重试台账（首次 attempts=0，立即可试）。 */
  private enqueueAsrRetry(id: string, error: string): void {
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
  private bumpAsrRetry(id: string, error: string): void {
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
  private clearAsrRetry(id: string): void {
    this.state.pendingAsr = this.state.pendingAsr.filter((x) => x !== id);
    if (this.state.asrRetry) delete this.state.asrRetry[id];
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
    if (deferred > 0) summary.errors.push(`转写重试：${deferred} 条未到退避时间，本次跳过`);
    for (const id of ids) {
      const entry = this.state.processed[id];
      if (!entry || !entry.path) {
        this.clearAsrRetry(id); // 无可用笔记路径 → 无从重试，结清避免长期占位
        continue;
      }
      // entry.path 可能因外部移动（如分类回填）过期，按 ID 现场定位，避免在旧路径重建出重复笔记
      const currentPath = this.findNotePath(id) ?? entry.path;
      notice.setMessage(`抖音同步：重试转写 ${id}`);
      try {
        const raw = await this.client.getAwemeDetail(id);
        if (!raw) {
          summary.errors.push(`重试转写：无法获取详情 ${id}`);
          this.bumpAsrRetry(id, "无法获取作品详情");
          this.markStateDirty();
          continue;
        }
        const item = DouyinClient.normalize(raw, "collection");
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
          await this.processItem(item, entry.folder, summary, notice, currentPath, {
            status: "unavailable",
            transcript: "",
            provider: "none",
            error: AUDIO_ONLY_REASON,
          });
          this.state.processed[id].asrStatus = "unavailable";
          this.state.processed[id].path = currentPath;
          this.clearAsrRetry(id);
          summary.asrSkipped++;
          this.markStateDirty();
          budget--;
          await sleep(300);
          continue;
        }
        const provider = createAsrProvider(this.settings, this.client, {
          resolveAudio: (url, videoId, durationSec) =>
            this.videoMedia.getAudio(videoId ?? "", url, durationSec ?? item.durationSec),
        });
        if (!provider) continue;
        const asr = await provider.transcribe(item.playUrl, item.id, { durationSec: item.durationSec });
        if (asr.status === "success") {
          summary.transcribed++;
          // 重新生成笔记（按定位到的当前路径；复用已得转写，不再二次转写）
          await this.processItem(item, entry.folder, summary, notice, currentPath, asr);
          this.state.processed[id].asrStatus = "success";
          this.state.processed[id].path = currentPath;
          this.clearAsrRetry(id);
          this.markStateDirty();
        } else if (asr.status === "unavailable") {
          // 无可转写内容（纯音乐/无对白等）——重写笔记说明并移出队列，不再反复重试
          await this.processItem(item, entry.folder, summary, notice, currentPath, asr);
          this.state.processed[id].asrStatus = "unavailable";
          this.state.processed[id].path = currentPath;
          this.clearAsrRetry(id);
          this.markStateDirty();
          summary.asrFailed++;
        } else {
          summary.asrFailed++;
          // 记一次失败：次数 +1 并按阶梯退避；达上限自动转 dead-letter
          this.bumpAsrRetry(id, asr.error ?? "未知错误");
          // 把真实失败原因回写进笔记的逐字稿区块，便于排查（成功路径由 processItem 全量重写）
          await this.writeAsrErrorNote(currentPath, asr.error ?? "未知错误");
          this.markStateDirty();
        }
        budget--;
        await sleep(300);
      } catch (e: any) {
        summary.errors.push(`重试转写 ${id}：${String(e?.message ?? e).slice(0, 80)}`);
        this.bumpAsrRetry(id, String(e?.message ?? e));
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
  async backfillVideos(onProgress?: (text: string) => void): Promise<string> {
    if (this.running) throw new Error("同步正在进行中");
    this.running = true;
    const summary = newSyncSummary();
    try {
      this.refreshClients(); // 同 syncAll：按最新设置重建 AI 客户端
      const budget = Math.max(1, this.settings.maxTranscribePerSync);
    const wantInterval = Math.max(1, Math.min(60, this.settings.keyframeIntervalSec || 10));
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
      asrOverride?: AsrResult;
      frameHint?: string[];
    }
    const jobs: BackfillJob[] = [];
    for (const id of Object.keys(this.state.processed)) {
      if (jobs.length >= budget) break;
      const entry = this.state.processed[id];
      // entry.path 可能因外部移动（如分类回填）过期，按 ID 现场定位
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
      // type 判断必须引号无关：processFrontMatter 写回 summary 后会把 YAML 里的引号去掉（type: 视频）
      if (!/^type:\s*"?(视频)"?\s*$/m.test(content)) continue; // 只补跑视频类；图文类维持原逻辑
      const transcriptOk = /^transcript_status:\s*"?success"?/m.test(content);
      // 终态（success / unavailable / not_requested）都不该再补跑：unavailable 是「已确认无可转写内容」，
      // 不纳入终态会让这些笔记每次补跑都被重写一遍（2026-09-21 修）。
      const transcriptTerminal = /^transcript_status:\s*"?(success|unavailable|not_requested)"?/m.test(content);
      const hasSummary = content.includes("> [!abstract]- 摘要");
      // 抽帧按间隔自适应：间隔设置变过、或从未抽出帧（纯音乐/拉取失败）→ 重抽；
      // ingestFrames 会清掉旧网格多余帧。摘要按 summary_v 版本号判断（v3 = 层级笔记体），格式升级会重出。
      // 无帧笔记：若已按当前间隔尝试过抽帧（storedInterval>0）仍无帧（纯音乐/音频流/直链失效），
      // 视为已完成，避免每次补跑都重复拉视频+重出摘要。
      const framePaths = listVideoFramePaths(this.app.vault, this.settings.mediaFolder, id);
      const storedInterval = parseInt((content.match(/^frame_interval:\s*(\d+)\s*$/m) ?? [])[1] ?? "0", 10) || 0;
      const framesOk =
        (framePaths.length > 0 || storedInterval > 0) && storedInterval === wantInterval;
      const summaryV3 = /^summary_v:\s*3\s*$/m.test(content);
      if (transcriptTerminal && hasSummary && framesOk && summaryV3) {
        skipped++;
        continue;
      }
      // 转录已成功时复用笔记里的逐字稿（不重复计费 ASR）；帧网格已达标时复用已入库帧，跳过视频重新拉取
      let asrOverride: AsrResult | undefined;
      if (transcriptOk) {
        const provider = (content.match(/^transcript_provider:\s*"?([^"\n]*)"?\s*$/m) ?? [])[1] ?? "";
        const transcript = extractSummarySources(content).transcript;
        asrOverride = { status: "success", transcript, provider: provider || "reused" };
      }
      const frameHint = framesOk && this.settings.videoSummaryEnabled ? framePaths : undefined;
      jobs.push({ id, currentPath, folder: entry.folder || "", asrOverride, frameHint });
    }

    // ---- 阶段二：限并发补跑（性能治理 P0-3）----
    // 单条含「下载全片 + 抽帧 + 转写 + 多模态摘要」，串行跑 300 条要数小时；并发后由各条等待重叠。
    const limit = clampConcurrency(this.settings.syncConcurrency, 3);
    let started = 0;
    const results = await mapLimit(jobs, limit, async (job) => {
      started++;
      onProgress?.(`补跑视频 ${job.id}（已启动 ${started}/${jobs.length}）`);
      try {
        const raw = await this.client.getAwemeDetail(job.id);
        const item = raw ? DouyinClient.normalize(raw, "collection") : null;
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
        );
        if (ok) this.state.processed[job.id].path = job.currentPath;
        this.markStateDirty();
        return ok;
      } catch (e: any) {
        summary.errors.push(`补跑 ${job.id}：${String(e?.message ?? e).slice(0, 80)}`);
        return false;
      }
    });
    for (const ok of results) {
      if (ok) done++;
      else failed++;
    }
    await this.saveState();
    const parts = [`补跑完成：处理 ${done}，跳过 ${skipped}，失败 ${failed}`];
    if (summary.errors.length) parts.push(`注意：${summary.errors[0]}`);
    return parts.join("。");
    } finally {
      this.running = false;
    }
  }
}
