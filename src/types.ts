// ---------- 抖音原始结构（宽松） ----------

export interface DouyinImageItem {
  url_list?: string[];
}

export interface DouyinAwemeRaw {
  aweme_id?: string | number;
  desc?: string;
  create_time?: number;
  author?: { nickname?: string; sec_uid?: string; unique_id?: string };
  video?: {
    play_addr?: DouyinImageItem;
    download_addr?: DouyinImageItem;
    cover?: DouyinImageItem;
    origin_cover?: DouyinImageItem;
    duration?: number;
  };
  images?: DouyinImageItem[];
  image_infos?: { images?: DouyinImageItem[] };
  music?: { play_url?: DouyinImageItem; is_original_sound?: boolean };
  statistics?: {
    digg_count?: number;
    comment_count?: number;
    collect_count?: number;
    share_count?: number;
  };
  is_note?: boolean;
  /** 抖音作品类型码：0/4 等为视频，2/68/71 等为图文（图片集合）——用于明确区分视频/图片类收藏 */
  aweme_type?: number;
  /** 抖音媒体类型码：4=视频，2=图片；43 为「无视频轨的音频类条目」伴随码（实测仅与 aweme_type=163 同现） */
  media_type?: number;
  [k: string]: unknown;
}

export interface DouyinPage {
  ok: boolean;
  hasMore: boolean;
  cursor?: number;
  items: DouyinAwemeRaw[];
}

// ---------- 归一化条目 ----------

export type ItemType = "video" | "note"; // video=视频, note=图文
export type ItemSource = "collection" | "like" | "post";

export interface SyncItem {
  id: string;
  type: ItemType;
  source: ItemSource;
  title: string;
  desc: string;
  author: string;
  authorId: string;
  createTime: number; // unix seconds, 0 = unknown
  playUrl: string;
  coverUrl: string;
  imageUrls: string[]; // 图文（≤10）
  durationSec: number;
  /** 抖音作品类型码（0/4 视频、2/68/71 图文、163 无视频轨的音频类条目） */
  awemeType?: number;
  /** 抖音媒体类型码（4 视频、2 图片、43 音频类条目） */
  mediaType?: number;
  stats: { likes: number; comments: number; collects: number; shares: number };
}

// ---------- ASR ----------

// 「skipped」成员已删除（2026-09-27 第四轮）：全仓库无生产点，留着会误导补跑终态判定
// （backfillVideos 的终态白名单是 success|unavailable|not_requested）。
export type AsrStatus = "success" | "failed" | "unavailable";

/** 结构化失败分类（P2-2 收敛）：deterministic = 重试必然复现（不入重试队列）；transient = 瞬时网络类（进重试队列）。 */
export type AsrFailureKind = "deterministic" | "transient";

export interface AsrResult {
  status: AsrStatus;
  transcript: string;
  segments?: { text: string; beginSec: number; endSec: number }[];
  provider?: string;
  error?: string;
  /** 失败结构化分类（P2-2）：provider 能明确判定时打标；不确定的留空——
   *  syncEngine 先读本字段，缺失时回退 DETERMINISTIC_ASR_FAILURE_RE 正则兜底（行为与打标前逐条一致）。 */
  failureKind?: AsrFailureKind;
}

export interface AsrProvider {
  readonly name: string;
  /** videoId：可选。供 URL 直传被 CDN 拒绝（FILE_403）时刷新播放地址用 */
  transcribe(url: string, videoId?: string, opts?: AsrTranscribeOpts): Promise<AsrResult>;
}

/** 转写可选参数：durationSec 供需要本地音频的通道（如 SenseVoice）计算抽帧/采样节奏 */
export interface AsrTranscribeOpts {
  durationSec?: number;
}

/** 本地音频解析回调：返回可上传的音频文件绝对路径；null = 无法取得（如 ffmpeg 缺失） */
export type AudioResolver = (url: string, videoId?: string, durationSec?: number) => Promise<string | null>;

/** ASR 工厂可选钩子：仅需要本地音频文件的 provider（siliconflow_sensevoice）消费 */
export interface AsrHooks {
  resolveAudio?: AudioResolver;
}

// ---------- 同步状态（持久化） ----------

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

// ---------- 设置 ----------

export type AsrProviderKind =
  | "none"
  | "siliconflow_sensevoice"
  | "dashscope_paraformer"
  | "dashscope_qwen3"
  | "volcengine"
  | "tencent";

/**
 * 视频摘要风格预设（2026-09-27 第八轮，借鉴 BiliNote 的多风格思路）：
 * hierarchy=层级笔记体（现行 v3 结构，默认）；outline=要点速览；qa=问答复习体。
 * 切换只影响之后新生成的摘要，不自动触发旧笔记批量重出（补跑判定仍只看 summary_v）。
 */
export type SummaryStyle = "hierarchy" | "outline" | "qa";

export const SUMMARY_STYLE_LABELS: Record<SummaryStyle, string> = {
  hierarchy: "层级笔记体（主题+引言+分节+总结）",
  outline: "要点速览（观点+要点列表+金句）",
  qa: "问答复习体（Q/A 问答对）",
};

export interface DouyinSyncSettings {
  // 连接
  cookie: string;
  // 同步范围
  syncCollection: boolean;
  syncLike: boolean;
  syncPost: boolean;
  folderWhitelist: string; // 逗号分隔的收藏夹名；空=全部
  useFolderMode: boolean;
  syncIntervalMinutes: number; // 0 = 关闭定时
  maxTranscribePerSync: number;
  scanStopAfterProcessed: number;
  /** 同步并发上限（性能治理 P0-3）：同时处理的条目数；1 = 完全串行，建议 3。列表分页仍恒为串行。 */
  syncConcurrency: number;
  // 路径
  rootFolder: string;
  mediaFolder: string; // 相对 vault 根，如 "抖音/Media"
  basesFolder: string;
  generateBases: boolean;
  downloadCover: boolean;
  downloadImages: boolean;
  // ASR
  asrProvider: AsrProviderKind;
  /** 百炼 DashScope 基址（ASR 异步任务 / qwen3 多模态直转）；一般无需修改，走中转代理时才改 */
  dashscopeBaseUrl: string;
  dashscopeKey: string;
  dashscopeModel: string; // paraformer-v2
  /** 硅基流动基址（ASR 音频上传端点 = 该基址 + /audio/transcriptions）；一般无需修改 */
  siliconflowBaseUrl: string;
  /** 硅基流动 API Key（ASR = FunAudioLLM/SenseVoiceSmall，需本机 ffmpeg 抽取音频） */
  siliconflowKey: string;
  /** 火山引擎 ASR 基址；一般无需修改 */
  volcBaseUrl: string;
  volcAppId: string;
  volcToken: string;
  volcCluster: string;
  /** 腾讯云 ASR 基址；一般无需修改 */
  tencentBaseUrl: string;
  tencentSecretId: string;
  tencentSecretKey: string;
  /** 视频多模态总结（视频类收藏专用）：转录文字 + 关键帧 → 百炼视觉模型生成结构化摘要（不含照片） */
  videoSummaryEnabled: boolean;
  videoSummaryModel: string;
  /** 摘要风格预设（写入 frontmatter summary_style；切换不自动重出旧摘要） */
  videoSummaryStyle: SummaryStyle;
  /** 多模态总结专用通道（留空复用 aiBaseUrl/aiKey）：便于独立接入智谱 GLM 等服务，隔离分类通道 */
  videoSummaryBaseUrl: string;
  videoSummaryApiKey: string;
  /** 抽帧间隔（秒）：每隔 N 秒抽一帧，按视频时长自适应（23 秒≈3 帧，10 分钟≈60 帧），上限 100 张 */
  keyframeIntervalSec: number;
  /** ffmpeg 可执行文件路径或 PATH 中的命令名；抽帧与 SenseVoice 音频抽取依赖 */
  ffmpegPath: string;
  // AI（OpenAI 兼容）
  aiBaseUrl: string;
  aiKey: string;
  aiModel: string;
  aiCategories: string; // 每行一个
  enableCategory: boolean;
  enableVision: boolean;
  visionModel: string;
  /** 相关笔记互链（第八轮）：同分类/同作者笔记在文末「相关笔记」块互链；0 候选时不留块 */
  relatedNotesEnabled: boolean;
  /** 每篇笔记最多互链条数（1~30） */
  relatedNotesMax: number;
  /** OCR 视觉通道独立基址（留空复用 aiBaseUrl）。用于把 OCR 从过载通道隔离出来 */
  visionBaseUrl: string;
  /** OCR 视觉通道独立 Key（留空复用 aiKey / dashscopeKey） */
  visionApiKey: string;
  /**
   * OCR 全局并发上限（跨条目统一限流）。
   * 实测（2026-09-19）：条目级并发 3 × 图片级并发 3 会把 OCR 请求放大到 9 路同时打向
   * 视觉模型服务端，导致对方过载排队（503 System is too busy），单张图反而更慢。
   * 故 OCR 请求统一由该闸门限流，与条目级并发解耦。
   */
  visionConcurrency: number;
  maxImages: number; // ≤10
  // 请求通道（本地桥接：抖音 Argus 风控会拦非浏览器指纹的直连请求，
  // 桥接通过真实 Chromium 页面上下文代发请求，本机 127.0.0.1 不出公网）
  bridgeEnabled: boolean;
  bridgeUrl: string;
  /** node.exe 绝对路径；留空则用 PATH 里的 node；文件不存在时自动回退 PATH node 并警告（每会话一次） */
  bridgeNodePath: string;
  /** 含 playwright-core 的 node_modules 目录，作为桥接进程的 NODE_PATH；留空则按常规解析 */
  bridgeNodeModules: string;
  // ---------- 四项新功能（M1 进程管控 / M2 图片 OCR / M3 AI 摘要 / M4 二维状态） ----------
  /** 桥接进程管控面板与启停重启（F1） */
  bridgeProcessEnabled: boolean;
  /** Obsidian 启动时自动拉起桥接（F1，默认关闭：用户已明确不要开机自启类行为） */
  processAutoStart: boolean;
  /** 二维状态刷新间隔（F4，≤ 5000ms） */
  processRefreshMs: number;
  /** 图片 OCR 独立入口（F2） */
  ocrPanelEnabled: boolean;
  /** OCR 主通道（Agnes）基址与 Key；Key 留空回退 aiKey */
  ocrBaseUrl: string;
  ocrApiKey: string;
  ocrModelPrimary: string;
  ocrModelFallback: string;
  /** 付费兜底开关（经中间确认）：true＝允许在主通道失败后弹确认、经用户同意才调用；false＝完全不使用付费通道 */
  ocrFallbackEnabled: boolean;
  /** AI 摘要（F3） */
  summaryEnabled: boolean;
  summaryMaxTokens: number;
}

export const DEFAULT_SETTINGS: DouyinSyncSettings = {
  cookie: "",
  syncCollection: true,
  syncLike: false,
  syncPost: false,
  folderWhitelist: "",
  useFolderMode: true,
  syncIntervalMinutes: 60,
  maxTranscribePerSync: 20,
  scanStopAfterProcessed: 100,
  syncConcurrency: 3,
  rootFolder: "抖音",
  mediaFolder: "抖音/Media",
  basesFolder: "抖音/Bases",
  generateBases: true,
  downloadCover: true,
  downloadImages: true,
  asrProvider: "siliconflow_sensevoice",
  dashscopeBaseUrl: "https://dashscope.aliyuncs.com/api/v1",
  dashscopeKey: "",
  dashscopeModel: "paraformer-v2",
  siliconflowBaseUrl: "https://api.siliconflow.cn/v1",
  siliconflowKey: "",
  volcBaseUrl: "https://openspeech.bytedance.com/api/v1",
  volcAppId: "",
  volcToken: "",
  volcCluster: "volcengine_auc_common",
  tencentBaseUrl: "https://asr.tencentcloudapi.com",
  tencentSecretId: "",
  tencentSecretKey: "",
  videoSummaryEnabled: true,
  // 注意：裸名 qwen3-vl-plus 已不在百炼有额度列表（FreeTierOnly 403），默认用带版本号的模型（2026-09-26 额度报告）
  videoSummaryModel: "qwen3-vl-plus-2025-12-19",
  videoSummaryStyle: "hierarchy",
  videoSummaryBaseUrl: "",
  videoSummaryApiKey: "",
  keyframeIntervalSec: 10,
  ffmpegPath: "ffmpeg",
  aiBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  aiKey: "",
  aiModel: "qwen-plus",
  aiCategories: "成长学习\n投资理财\nAI编程\n心理情感\n职场商业\n娱乐生活\n运动健康",
  enableCategory: true,
  enableVision: true,
  visionModel: "qwen-vl-plus",
  relatedNotesEnabled: true,
  relatedNotesMax: 8,
  visionBaseUrl: "",
  visionApiKey: "",
  visionConcurrency: 3,
  maxImages: 10,
  bridgeEnabled: true,
  bridgeUrl: "http://127.0.0.1:8765",
  // 留空即不写死任何机器路径：桥接进程回退到 PATH 里的 node，依赖按常规 node 解析规则查找。
  // 安装脚本（1-安装插件.bat）会按目标机器实际情况把这两项写进 data.json。
  bridgeNodePath: "",
  bridgeNodeModules: "",
  // 四项新功能默认值（见 系统设计 §4.2.1）
  bridgeProcessEnabled: true,
  processAutoStart: false,
  processRefreshMs: 5000,
  ocrPanelEnabled: true,
  ocrBaseUrl: "https://api.agnes-ai.cn/v1",
  ocrApiKey: "",
  ocrModelPrimary: "agnes-2.5-flash",
  // 注意：裸名 qwen3-vl-plus 已不在百炼有额度列表（FreeTierOnly 403），与 videoSummaryModel 同口径（复审 P2）
  ocrModelFallback: "qwen3-vl-plus-2025-12-19",
  ocrFallbackEnabled: true,
  summaryEnabled: true,
  summaryMaxTokens: 500,
};

export const SOURCE_LABEL: Record<ItemSource, string> = {
  collection: "收藏",
  like: "点赞",
  post: "作品",
};
