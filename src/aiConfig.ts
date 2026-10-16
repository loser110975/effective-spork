// aiConfig.ts — AI 接入统一配置层。
// 所有 AI 调用（OpenAI 兼容 Chat Completions / 各 ASR 服务）的 Base URL 与 API Key
// 一律从插件设置（settings → data.json）解析，代码里不写死任何接入点。
// 任一通道配置缺失或无效时，由本模块生成指向设置页的明确错误信息。
//
// 2026-10 表驱动重构：四个 resolver 的「键名 + 默认值 + 标签」收敛为一张通道描述表，
// 由 createChannelResolver 工厂统一实现解析逻辑。
// 2026-10-15 通道独立化：四条通道全部只读自己的 Base URL / API Key 键，
// 「留空复用 AI 通道 / 百炼 Key」的跨键回退链整体移除——留空即报「未配置」，
// 不再悄悄借用其他通道的凭据（dashscopeKey 仍被 ASR 百炼转写直读，字段保留）。
import { DEFAULT_SETTINGS, DouyinSyncSettings } from "./types/settings";

export interface ResolvedChannel {
  baseUrl: string;
  apiKey: string;
  /** 配置问题的中文描述；空串 = 配置完整可用 */
  problem: string;
}

/** 校验 Base URL：空 / 非 http(s) 开头都算无效，返回错误信息；合法返回空串。 */
export function baseUrlProblem(baseUrl: string, label: string): string {
  const u = (baseUrl ?? "").trim();
  if (!u) return `${label} Base URL 未配置（Obsidian 设置 → 抖音同步）`;
  if (!/^https?:\/\//i.test(u)) return `${label} Base URL 无效：「${u}」必须以 http:// 或 https:// 开头`;
  return "";
}

/** 校验 API Key：空即无效，返回错误信息；合法返回空串。 */
export function apiKeyProblem(apiKey: string, label: string): string {
  if (!(apiKey ?? "").trim()) return `${label} API Key 未配置（Obsidian 设置 → 抖音同步）`;
  return "";
}

/** 组合校验：先基址后密钥，返回第一条问题（空串 = 全部通过）。 */
function endpointProblem(baseUrl: string, apiKey: string, label: string): string {
  return baseUrlProblem(baseUrl, label) || apiKeyProblem(apiKey, label);
}

// ---------- 表驱动通道描述（2026-10 重构核心；2026-10-15 回退链移除） ----------

/** settings 里值为 string 的键（通道基址/Key/模型全是字符串键，排除 number/boolean 键防误配）。 */
type StringSettingKey = {
  [K in keyof DouyinSyncSettings]: DouyinSyncSettings[K] extends string ? K : never;
}[keyof DouyinSyncSettings];

/** DEFAULT_SETTINGS 里值为 string 的键（baseUrl 默认值键约束）。 */
type StringDefaultKey = {
  [K in keyof typeof DEFAULT_SETTINGS]: (typeof DEFAULT_SETTINGS)[K] extends string ? K : never;
}[keyof typeof DEFAULT_SETTINGS];

/** 通道描述表的一行：一个可解析通道的完整声明。 */
export interface ChannelSpec {
  /** 通道标识（诊断/留档用） */
  id: string;
  /** 校验错误信息里的中文标签（逐位保持原实现文案） */
  label: string;
  /** baseUrl 的 settings 键；通道独立化后每通道只认自己的键（不再跨键回退） */
  baseUrlKeys: StringSettingKey[];
  /** baseUrl 兜底默认值在 DEFAULT_SETTINGS 里的键名；缺省 = 无默认（键为空时 baseUrl 为空串 → 报未配置） */
  baseUrlDefaultKey?: StringDefaultKey;
  /** 配套模型键（表完整性元数据；当前 ResolvedChannel 不承载 model，供后续扩展与文档对照） */
  modelKey?: StringSettingKey;
  /** apiKey 的 settings 键（2026-10-15 起为单键：通道只认自己的 Key，不再多级回退）；最终 .trim() */
  apiKeyChain: StringSettingKey[];
}

/**
 * 通道解析工厂：把一行 ChannelSpec 变成一个 resolver。
 * 行为契约（2026-10-15 通道独立化后）：
 * - baseUrl：按 baseUrlKeys 取第一个真值（|| 语义，空串/undefined 都跳过），否则取
 *   DEFAULT_SETTINGS[baseUrlDefaultKey]（若声明）；最终 .trim()。
 * - apiKey：按 apiKeyChain 顺序取第一个真值（通道独立化后通常只有一项），命中值最终 .trim()；
 *   全部未命中得 ""。
 * - problem：endpointProblem（先基址后密钥）——留空即报「未配置」，不再回退其他通道凭据。
 */
export function createChannelResolver(spec: ChannelSpec): (s: DouyinSyncSettings) => ResolvedChannel {
  return (s: DouyinSyncSettings): ResolvedChannel => {
    // baseUrl：键序回退 → 默认值（与原手写 `a || b || DEFAULT.x` 逐位等价）
    let rawBase = "";
    for (const k of spec.baseUrlKeys) {
      const v = s[k];
      if (v) {
        rawBase = v;
        break;
      }
    }
    if (!rawBase && spec.baseUrlDefaultKey) rawBase = DEFAULT_SETTINGS[spec.baseUrlDefaultKey];
    const baseUrl = rawBase.trim();
    // apiKey：候选键逐项判定（通道独立化后通常仅一项）
    let rawKey = "";
    for (const k of spec.apiKeyChain) {
      const v = s[k];
      if (!v) continue; // 真值语义：空串/undefined 都落到下一候选
      rawKey = v;
      break;
    }
    const apiKey = rawKey.trim();
    return { baseUrl, apiKey, problem: endpointProblem(baseUrl, apiKey, spec.label) };
  };
}

// ---------- 通道描述表 ----------

/** 通用 AI 通道（自动分类 / 图文摘要）：只认 aiBaseUrl / aiKey（2026-10-15 起不再借用 dashscopeKey）。 */
const AI_CHANNEL: ChannelSpec = {
  id: "ai",
  label: "AI",
  baseUrlKeys: ["aiBaseUrl"],
  baseUrlDefaultKey: "aiBaseUrl",
  modelKey: "aiModel",
  apiKeyChain: ["aiKey"],
};

/** OCR 视觉通道（同步流水线图片文字识别）：只认 visionBaseUrl / visionApiKey。 */
const VISION_CHANNEL: ChannelSpec = {
  id: "vision",
  label: "OCR 视觉",
  baseUrlKeys: ["visionBaseUrl"],
  modelKey: "visionModel",
  apiKeyChain: ["visionApiKey"],
};

/** OCR 面板主通道（Agnes）：只认 ocrBaseUrl / ocrApiKey。基址无默认兜底（原实现如此）：留空 → 未配置报错。 */
const OCR_PRIMARY_CHANNEL: ChannelSpec = {
  id: "ocr-primary",
  label: "OCR 主通道",
  baseUrlKeys: ["ocrBaseUrl"],
  modelKey: "ocrModelPrimary",
  apiKeyChain: ["ocrApiKey"],
};

/** 视频多模态总结通道：只认 videoSummaryBaseUrl / videoSummaryApiKey。 */
const VIDEO_SUMMARY_CHANNEL: ChannelSpec = {
  id: "video-summary",
  label: "视频多模态总结",
  baseUrlKeys: ["videoSummaryBaseUrl"],
  modelKey: "videoSummaryModel",
  apiKeyChain: ["videoSummaryApiKey"],
};

/**
 * embedding 通道（批次三语义检索/向量互链，2026-10-16）：只认 embeddingBaseUrl / embeddingApiKey。
 * Base URL 有静态默认（百炼 compatible-mode，DEFAULT_SETTINGS.embeddingBaseUrl）；
 * Key 留空即报「未配置」——与其他四通道同口径，不再引入跨键回退。
 */
const EMBEDDING_CHANNEL: ChannelSpec = {
  id: "embedding",
  label: "语义检索 embedding",
  baseUrlKeys: ["embeddingBaseUrl"],
  baseUrlDefaultKey: "embeddingBaseUrl",
  modelKey: "embeddingModel",
  apiKeyChain: ["embeddingApiKey"],
};

// ---------- 四个 resolver（工厂调用） ----------

/** 通用 AI 通道（自动分类 / 图文摘要）。 */
export const resolveAiChannel = createChannelResolver(AI_CHANNEL);

/** OCR 视觉通道（同步流水线里的图片文字识别）。 */
export const resolveVisionChannel = createChannelResolver(VISION_CHANNEL);

/** OCR 面板通道：Agnes 主通道。付费兜底通道已移除（2026-10-13）。 */
export function resolveOcrPanelChannel(s: DouyinSyncSettings): ResolvedChannel {
  return primaryPanelResolver(s);
}

const primaryPanelResolver = createChannelResolver(OCR_PRIMARY_CHANNEL);

/** 视频多模态总结通道。 */
export const resolveVideoSummaryChannel = createChannelResolver(VIDEO_SUMMARY_CHANNEL);

/** embedding 通道（批次三语义检索 / 向量互链共用）。 */
export const resolveEmbeddingChannel = createChannelResolver(EMBEDDING_CHANNEL);

/**
 * 配额耗尽类错误识别（2026-10-01 第十三轮，真实样本驱动）：
 * 百炼「AllocationQuota.FreeTierOnly」、compatible-mode「Free quota exhausted」403、欠费。
 * 配额类失败是确定性的——重试必然复现，摘要熔断（syncEngine）据此连续 3 次后跳过
 * 本次运行的摘要与抽帧，避免每条视频白打一次调用 + 白付一次全片下载（09-21 实测 50 连发）。
 */
export function isQuotaExhaustedError(msg: string): boolean {
  return /free quota|quota exhausted|allocationquota|freetieronly|欠费|arrears/i.test(String(msg ?? ""));
}
