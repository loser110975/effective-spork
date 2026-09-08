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
  [k: string]: unknown;
}

export interface DouyinPage {
  ok: boolean;
  statusCode?: number;
  hasMore: boolean;
  cursor?: number;
  items: DouyinAwemeRaw[];
  raw?: unknown;
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
  stats: { likes: number; comments: number; collects: number; shares: number };
}

// ---------- ASR ----------

export type AsrStatus = "success" | "failed" | "unavailable" | "skipped";

export interface AsrResult {
  status: AsrStatus;
  transcript: string;
  segments?: { text: string; beginSec: number; endSec: number }[];
  provider?: string;
  error?: string;
}

export interface AsrProvider {
  readonly name: string;
  transcribe(url: string): Promise<AsrResult>;
}

// ---------- 同步状态（持久化） ----------

export interface ProcessedEntry {
  path: string;
  syncedAt: string;
  folder: string;
  asrStatus?: AsrStatus;
}

export interface SyncState {
  fullSyncedAt?: string;
  processed: Record<string, ProcessedEntry>;
  pendingAsr: string[]; // aweme_id 待重试转写
  pendingVision: string[]; // aweme_id 待重试图片识别
  lastSyncAt?: string;
  lastSyncSummary?: string;
}

// ---------- 设置 ----------

export type AsrProviderKind =
  | "none"
  | "dashscope_paraformer"
  | "dashscope_qwen3"
  | "volcengine"
  | "tencent";

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
  // 路径
  rootFolder: string;
  mediaFolder: string; // 相对 vault 根，如 "抖音/Media"
  basesFolder: string;
  generateBases: boolean;
  downloadCover: boolean;
  downloadImages: boolean;
  // ASR
  asrProvider: AsrProviderKind;
  dashscopeKey: string;
  dashscopeModel: string; // paraformer-v2
  volcAppId: string;
  volcToken: string;
  volcCluster: string;
  tencentSecretId: string;
  tencentSecretKey: string;
  // AI（OpenAI 兼容）
  aiBaseUrl: string;
  aiKey: string;
  aiModel: string;
  aiCategories: string; // 每行一个
  enableCategory: boolean;
  enableVision: boolean;
  visionModel: string;
  maxImages: number; // ≤10
  // 请求通道（本地桥接：抖音 Argus 风控会拦非浏览器指纹的直连请求，
  // 桥接通过真实 Chromium 页面上下文代发请求，本机 127.0.0.1 不出公网）
  bridgeEnabled: boolean;
  bridgeUrl: string;
  bridgeNodePath: string;
  bridgeNodeModules: string;
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
  rootFolder: "抖音",
  mediaFolder: "抖音/Media",
  basesFolder: "抖音/Bases",
  generateBases: true,
  downloadCover: true,
  downloadImages: true,
  asrProvider: "none",
  dashscopeKey: "",
  dashscopeModel: "paraformer-v2",
  volcAppId: "",
  volcToken: "",
  volcCluster: "volcengine_auc_common",
  tencentSecretId: "",
  tencentSecretKey: "",
  aiBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  aiKey: "",
  aiModel: "qwen-plus",
  aiCategories: "成长学习\n投资理财\nAI编程\n心理情感\n职场商业\n娱乐生活\n运动健康",
  enableCategory: true,
  enableVision: true,
  visionModel: "qwen-vl-plus",
  maxImages: 10,
  bridgeEnabled: true,
  bridgeUrl: "http://127.0.0.1:8765",
  bridgeNodePath: "C:\\Users\\23699\\.workbuddy\\binaries\\node\\versions\\22.22.2-2\\node.exe",
  bridgeNodeModules: "C:\\Users\\23699\\.workbuddy\\binaries\\node\\workspace\\node_modules",
};

export const SOURCE_LABEL: Record<ItemSource, string> = {
  collection: "收藏",
  like: "点赞",
  post: "作品",
};
