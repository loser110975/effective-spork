// aiConfig.ts — AI 接入统一配置层。
// 所有 AI 调用（OpenAI 兼容 Chat Completions / 各 ASR 服务）的 Base URL 与 API Key
// 一律从插件设置（settings → data.json）解析，代码里不写死任何接入点。
// 任一通道配置缺失或无效时，由本模块生成指向设置页的明确错误信息。
//
// 2026-10 表驱动重构：四个 resolver 的「键名回退链 + 默认值 + 标签」收敛为一张通道描述表，
// 由 createChannelResolver 工厂统一实现解析逻辑；四个导出函数逐位保持原有签名、返回
// 结构与行为（含 Key 回退顺序、百炼基址约束、标签文案），仅实现方式从手写展开变为查表。
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

/**
 * 是否百炼系基址（第六轮）：dashscopeKey 兜底只在基址确属百炼时注入——
 * 基址被改到第三方（智谱/硅基流动等）且 Key 留空时，把百炼 Key 打过去是必现 401；
 * 禁用兜底后走「API Key 未配置」的设置页指引，比 401 可排查得多。
 */
function isBailianBase(baseUrl: string): boolean {
  return /dashscope\.aliyuncs\.com|compatible-mode/i.test(baseUrl || "");
}

// ---------- 表驱动通道描述（2026-10 重构核心） ----------

/** settings 里值为 string 的键（通道基址/Key/模型全是字符串键，排除 number/boolean 键防误配）。 */
type StringSettingKey = {
  [K in keyof DouyinSyncSettings]: DouyinSyncSettings[K] extends string ? K : never;
}[keyof DouyinSyncSettings];

/** DEFAULT_SETTINGS 里值为 string 的键（baseUrl 默认值键约束）。 */
type StringDefaultKey = {
  [K in keyof typeof DEFAULT_SETTINGS]: (typeof DEFAULT_SETTINGS)[K] extends string ? K : never;
}[keyof typeof DEFAULT_SETTINGS];

/** API Key 回退链的一项：直接取 settings 键，或带条件注入（百炼基址限定 / 自有基址限定）。 */
export interface ApiKeyCandidate {
  /** settings 里的键名（取值候选） */
  key: StringSettingKey;
  /** true = 仅当解析出的基址属百炼系时才注入该键（防跨源 401，见 isBailianBase） */
  bailianOnly?: boolean;
  /** true = 仅当通道配置了「自有基址」（baseUrlKeys 首键非空）时才注入该键（resolveVisionChannel 的 hasOwnVisionBase 语义） */
  ownBaseOnly?: boolean;
}

/** 通道描述表的一行：一个可解析通道的完整声明。 */
export interface ChannelSpec {
  /** 通道标识（诊断/留档用） */
  id: string;
  /** 校验错误信息里的中文标签（逐位保持原实现文案） */
  label: string;
  /** baseUrl 候选键（settings 键名，按序取第一个真值）；全部为空时落 baseUrlDefaultKey */
  baseUrlKeys: StringSettingKey[];
  /** baseUrl 兜底默认值在 DEFAULT_SETTINGS 里的键名；缺省 = 无默认（全部候选为空时 baseUrl 为空串，OCR 主通道语义） */
  baseUrlDefaultKey?: StringDefaultKey;
  /** 配套模型键（表完整性元数据；当前 ResolvedChannel 不承载 model，供后续扩展与文档对照） */
  modelKey?: StringSettingKey;
  /** apiKey 候选链：按序取第一个通过条件且真值非空的键，末尾 .trim() */
  apiKeyChain: ApiKeyCandidate[];
}

/**
 * 通道解析工厂：把一行 ChannelSpec 变成一个 resolver。
 * 行为契约（与被替换的手写实现逐位一致）：
 * - baseUrl：按 baseUrlKeys 取第一个真值（|| 语义，空串/undefined 都跳过），否则取
 *   DEFAULT_SETTINGS[baseUrlDefaultKey]；最终 .trim()。
 * - apiKey：按 apiKeyChain 顺序取第一个「条件通过且值为真值」的键（条件不通过或值为空串
 *   都视为未命中，等价原实现的 `|| ""` 短路），命中值最终 .trim()；全部未命中得 ""。
 * - problem：endpointProblem（先基址后密钥）。
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
    // ownBaseOnly 条件依据：通道自有基址键（baseUrlKeys 首键）是否被显式配置（非空真值）
    const ownBaseSet = !!s[spec.baseUrlKeys[0]];
    // apiKey：候选链逐项判定
    let rawKey = "";
    for (const cand of spec.apiKeyChain) {
      const v = s[cand.key];
      if (!v) continue; // 原实现 `||` 的真值语义：空串/undefined 都落到下一候选
      if (cand.bailianOnly && !isBailianBase(baseUrl)) continue;
      if (cand.ownBaseOnly && !ownBaseSet) continue;
      rawKey = v;
      break;
    }
    const apiKey = rawKey.trim();
    return { baseUrl, apiKey, problem: endpointProblem(baseUrl, apiKey, spec.label) };
  };
}

// ---------- 通道描述表 ----------

/** 通用 AI 通道（自动分类 / 图文摘要）：aiKey 留空时百炼基址下复用 dashscopeKey（兼容旧配置）。 */
const AI_CHANNEL: ChannelSpec = {
  id: "ai",
  label: "AI",
  baseUrlKeys: ["aiBaseUrl"],
  baseUrlDefaultKey: "aiBaseUrl",
  modelKey: "aiModel",
  apiKeyChain: [{ key: "aiKey" }, { key: "dashscopeKey", bailianOnly: true }],
};

/** OCR 视觉通道（同步流水线图片文字识别）：独立基址/Key 留空逐级回退（自有基址限定见 ownBaseOnly）。 */
const VISION_CHANNEL: ChannelSpec = {
  id: "vision",
  label: "OCR 视觉",
  baseUrlKeys: ["visionBaseUrl", "aiBaseUrl"],
  baseUrlDefaultKey: "aiBaseUrl",
  modelKey: "visionModel",
  apiKeyChain: [
    { key: "visionApiKey" },
    { key: "dashscopeKey", bailianOnly: true, ownBaseOnly: true },
    { key: "aiKey" },
    { key: "dashscopeKey", bailianOnly: true },
  ],
};

/** OCR 面板付费兜底通道（confirmFallback 之后才会用到）。 */
const OCR_FALLBACK_CHANNEL: ChannelSpec = {
  id: "ocr-fallback",
  label: "OCR 兜底通道",
  baseUrlKeys: ["aiBaseUrl"],
  baseUrlDefaultKey: "aiBaseUrl",
  modelKey: "ocrModelFallback",
  apiKeyChain: [{ key: "aiKey" }, { key: "dashscopeKey", bailianOnly: true }],
};

/** OCR 面板主通道（Agnes）：Key 留空回退 AI Key，再百炼兜底。注意基址无默认兜底（原实现如此）：两者皆空 → 未配置报错。 */
const OCR_PRIMARY_CHANNEL: ChannelSpec = {
  id: "ocr-primary",
  label: "OCR 主通道",
  baseUrlKeys: ["ocrBaseUrl", "aiBaseUrl"],
  modelKey: "ocrModelPrimary",
  apiKeyChain: [{ key: "ocrApiKey" }, { key: "aiKey" }, { key: "dashscopeKey", bailianOnly: true }],
};

/** 视频多模态总结通道：专用基址/Key 留空时复用通用 AI 通道。 */
const VIDEO_SUMMARY_CHANNEL: ChannelSpec = {
  id: "video-summary",
  label: "视频多模态总结",
  baseUrlKeys: ["videoSummaryBaseUrl", "aiBaseUrl"],
  baseUrlDefaultKey: "aiBaseUrl",
  modelKey: "videoSummaryModel",
  apiKeyChain: [{ key: "videoSummaryApiKey" }, { key: "aiKey" }, { key: "dashscopeKey", bailianOnly: true }],
};

// ---------- 四个 resolver（工厂调用；导出名/签名/返回结构/行为逐位不变） ----------

/** 通用 AI 通道（自动分类 / 图文摘要）。Key 兼容旧配置：aiKey 留空时复用百炼 dashscopeKey。 */
export const resolveAiChannel = createChannelResolver(AI_CHANNEL);

/**
 * OCR 视觉通道（同步流水线里的图片文字识别）。
 * 兼容旧逻辑：配了独立基址却没配独立 Key 时优先百炼 Key（基址与 Key 必须同源，否则 401）——
 * 但仅当基址确属百炼系（第六轮）：自定义基址若非百炼，同源候选 aiKey 优先于跨源 dashscopeKey。
 */
export const resolveVisionChannel = createChannelResolver(VISION_CHANNEL);

/**
 * OCR 面板通道：primary = Agnes 主通道（Key 留空回退 AI Key），fallback = 通用 AI 通道。
 * 兜底属付费调用，必须经用户确认后才会走到这里（ocrService.confirmFallback）。
 */
export function resolveOcrPanelChannel(s: DouyinSyncSettings, channel: "primary" | "fallback"): ResolvedChannel {
  const resolver = channel === "primary" ? primaryPanelResolver : fallbackPanelResolver;
  return resolver(s);
}

const primaryPanelResolver = createChannelResolver(OCR_PRIMARY_CHANNEL);
const fallbackPanelResolver = createChannelResolver(OCR_FALLBACK_CHANNEL);

/** 视频多模态总结通道（专用 Base URL / Key 留空时复用通用 AI 通道）。 */
export const resolveVideoSummaryChannel = createChannelResolver(VIDEO_SUMMARY_CHANNEL);

/**
 * 配额耗尽类错误识别（2026-10-01 第十三轮，真实样本驱动）：
 * 百炼「AllocationQuota.FreeTierOnly」、compatible-mode「Free quota exhausted」403、欠费。
 * 配额类失败是确定性的——重试必然复现，摘要熔断（syncEngine）据此连续 3 次后跳过
 * 本次运行的摘要与抽帧，避免每条视频白打一次调用 + 白付一次全片下载（09-21 实测 50 连发）。
 */
export function isQuotaExhaustedError(msg: string): boolean {
  return /free quota|quota exhausted|allocationquota|freetieronly|欠费|arrears/i.test(String(msg ?? ""));
}
