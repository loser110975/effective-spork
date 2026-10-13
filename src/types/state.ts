// types/state.ts —— 持久化状态域类型（自 types.ts 按域拆分，2026-10 类型域拆分轮）：
// 同步台账 SyncState、ASR 重试台账、耗时画像、OCR/摘要记录与进程管控状态。
import type { ItemType, ItemSource } from "./domain";
import type { AsrStatus } from "./asr";

export interface ProcessedEntry {
  path: string;
  syncedAt: string;
  folder: string;
  asrStatus?: AsrStatus;
  /** 条目来源（2026-09-27 第四轮）：重试/补跑重建笔记时还原 frontmatter source，
   *  不再硬编码 "collection" 把点赞/作品笔记改写成「收藏」。旧台账缺省回退 collection。 */
  source?: ItemSource;
}

/** 进程管控状态（M1/M4；新增，见 系统设计 §4.2.3）。停止成功后清空 PID，避免误用旧 PID。 */
export interface BridgeProcessManagerState {
  bridgePid: number; // 桥接 PID，-1 表示未知
  panelPid: number; // 插件进程 PID
  treePids: number[]; // 桥接整树 PID（onunload 终止用）
  lastStartAt: string | null;
  lastStopAt: string | null;
  lastCommandKey: string | null;
  lastErrorCode: string | null;
  updatedAt: string | null;
}

/** 单张图片的 OCR 结果（M2；新增，见 系统设计 §4.2.4）。 */
export interface VisionRecord {
  imagePath: string;
  channel: "primary" | "fallback";
  status: "success" | "failed" | "awaiting_confirm";
  text: string;
  errorCode?: string;
  elapsedMs: number;
  createdAt: string;
}

/** 单篇笔记的摘要结果（M3；新增，见 系统设计 §4.2.5）。 */
export interface SummaryRecord {
  notePath: string;
  sourceChars: number;
  /** 已停止写入（性能治理 P0-2）：摘要正文在笔记正文与 frontmatter 里已有一份，
   *  台账再存一遍会让 data.json 膨胀一倍（实测 200 条占 204KB）。保留可选字段仅为兼容旧数据。 */
  summaryText?: string;
  model: string;
  status: "success" | "failed";
  errorCode?: string;
  /** 失败原因全文（含 HTTP 状态与上游错误体），失败排查用；成功时不写 */
  errorMessage?: string;
  generatedAt: string;
  /** 摘要通道：video_multimodal = 视频多模态（转录+关键帧），缺省/text = 纯文本 */
  kind?: "video_multimodal" | "text";
  /**
   * 本次实际送给模型的帧数（性能埋点）。
   * 用于确认是否发生了「图片数超限降档重试」——若该值明显小于首档，说明降档链路在生效，
   * 耗时里含有多次完整请求的代价。
   */
  framesUsed?: number;
}

/**
 * ASR 重试台账（新增，性能治理 P1）。
 * 原实现只有 pendingAsr: string[]，失败条目会被每次同步无退避、无上限地重试，
 * 永久失败的（如 CDN 拒绝、地址失效）会长期占用转写预算。此结构补上次数、错误与下次可重试时间。
 */
export interface AsrRetryEntry {
  /** 已重试次数（首次失败入队时为 0，每次重试失败 +1） */
  attempts: number;
  lastError: string;
  /** ISO 时间：未到点不重试（指数退避，避免对反复失败的条目空转） */
  nextRetryAt: string;
  /** true = 已达重试上限，不再自动重试（dead-letter），仅保留记录供人工在面板处理 */
  dead?: boolean;
}

/**
 * 单条处理的分阶段耗时（性能埋点 P2-15），单位毫秒。
 * 目的：让优化收益可量化，而不是只能靠端到端时间反推。
 * 未走到的阶段保持 0（例如图文类不会有 ffmpegMs / summaryMs）。
 */
export interface StageTimings {
  id: string;
  type: ItemType;
  /** 本条端到端耗时（含各阶段之间的间隙） */
  totalMs: number;
  /** 重试路径从既有笔记回收资产 */
  reuseMs: number;
  coverMs: number;
  /** 视频素材：ffmpeg 拉流 + 抽帧 + 出音频（含帧入库 vault） */
  ffmpegMs: number;
  /** 图文图片逐张下载 */
  imagesMs: number;
  /** 图片文字识别（逐张） */
  ocrMs: number;
  /** ASR 逐字稿（含音频抽取与上传） */
  asrMs: number;
  categoryMs: number;
  /** 写笔记 + 摘要回填 */
  noteWriteMs: number;
  /** 视频多模态摘要 */
  summaryMs: number;
  recordedAt: string;
}

export interface SyncState {
  processed: Record<string, ProcessedEntry>;
  pendingAsr: string[]; // aweme_id 待重试转写
  /** ASR 重试台账（新增）：与 pendingAsr 并存，pendingAsr 仍是待重试 id 列表（向后兼容） */
  asrRetry?: Record<string, AsrRetryEntry>;
  /** 分阶段耗时样本（新增，保留最近 100 条；性能埋点 P2-15） */
  metrics?: StageTimings[];
  /** 最近一次同步的耗时画像摘要（新增，一行文本，便于状态栏/面板展示） */
  lastPerfSummary?: string;
  lastSyncAt?: string;
  lastSyncSummary?: string;
  processManager?: BridgeProcessManagerState; // 新增：进程管控
  vision?: VisionRecord[]; // 新增：OCR 结果，保留最近 200 条
  summary?: SummaryRecord[]; // 新增：摘要结果，保留最近 200 条
  /**
   * 补跑连续失败计数（2026-09-27 第四轮）：候选选取按台账插入顺序取前 budget 个，
   * 队首固定是最早一批——若其中 CDN 已失效的条目每次补跑都占据名额，尾部健康笔记永远轮不到。
   * 连续失败 ≥3 次的 id 本轮扫描直接跳过；补跑成功即清除。
   */
  backfillFails?: Record<string, number>;
  /**
   * 转写结果暂存（2026-09-27 第九轮）：ASR 成功但写笔记失败时条目不进台账，已付费的转录
   * 原实现只存在内存——下轮按全新条目重新计费。成功即暂存（FIFO ≤20 条），写笔记成功后清除。
   */
  transcriptCache?: Record<string, { transcript: string; provider: string; at: string }>;
  /**
   * 强制重抽帧一次性标志（keyframeIntervalSec 不追溯的配套逃生门）：命令面板置位后，
   * 下一次同步对所有视频忽略已存抽帧间隔、强制重抽，本轮完成后自动清除。
   */
  forceFrameResync?: boolean;
}
