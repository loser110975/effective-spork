// types/settings.ts —— 设置域类型（自 types.ts 按域拆分，2026-10 类型域拆分轮）：
// DouyinSyncSettings 全量键位、DEFAULT_SETTINGS 默认值与摘要风格预设。

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
