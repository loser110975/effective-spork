// aiConfig.ts — AI 接入统一配置层。
// 所有 AI 调用（OpenAI 兼容 Chat Completions / 各 ASR 服务）的 Base URL 与 API Key
// 一律从插件设置（settings → data.json）解析，代码里不写死任何接入点。
// 任一通道配置缺失或无效时，由本模块生成指向设置页的明确错误信息。
import { DEFAULT_SETTINGS, DouyinSyncSettings } from "./types";

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

/**
 * 通用 AI 通道（自动分类 / 图文摘要）。
 * Key 兼容旧配置：aiKey 留空时复用百炼 dashscopeKey（与既有行为一致）。
 */
export function resolveAiChannel(s: DouyinSyncSettings): ResolvedChannel {
  const baseUrl = (s.aiBaseUrl || DEFAULT_SETTINGS.aiBaseUrl).trim();
  const apiKey = (s.aiKey || (isBailianBase(baseUrl) ? s.dashscopeKey : "")).trim();
  return { baseUrl, apiKey, problem: endpointProblem(baseUrl, apiKey, "AI") };
}

/**
 * OCR 视觉通道（同步流水线里的图片文字识别）。
 * 兼容旧逻辑：配了独立基址却没配独立 Key 时优先百炼 Key（基址与 Key 必须同源，否则 401）——
 * 但仅当基址确属百炼系（第六轮）：自定义基址若非百炼，同源候选 aiKey 优先于跨源 dashscopeKey。
 */
export function resolveVisionChannel(s: DouyinSyncSettings): ResolvedChannel {
  const baseUrl = (s.visionBaseUrl || s.aiBaseUrl || DEFAULT_SETTINGS.aiBaseUrl).trim();
  const hasOwnVisionBase = !!s.visionBaseUrl.trim();
  const apiKey = (
    s.visionApiKey ||
    (hasOwnVisionBase && isBailianBase(baseUrl) ? s.dashscopeKey : "") ||
    s.aiKey ||
    (isBailianBase(baseUrl) ? s.dashscopeKey : "")
  ).trim();
  return { baseUrl, apiKey, problem: endpointProblem(baseUrl, apiKey, "OCR 视觉") };
}

/**
 * OCR 面板通道：primary = Agnes 主通道（Key 留空回退 AI Key），fallback = 通用 AI 通道。
 * 兜底属付费调用，必须经用户确认后才会走到这里（ocrService.confirmFallback）。
 */
export function resolveOcrPanelChannel(s: DouyinSyncSettings, channel: "primary" | "fallback"): ResolvedChannel {
  const baseUrl = (channel === "primary" ? s.ocrBaseUrl || s.aiBaseUrl : s.aiBaseUrl || DEFAULT_SETTINGS.aiBaseUrl).trim();
  // 兜底通道同样回退 dashscopeKey（复审 P2）：与 resolveAiChannel/resolveVisionChannel 同链——
  // 按推荐配置只填百炼 Key 的用户，此前唯独面板付费兜底会报「API Key 未配置」。
  // dashscopeKey 兜底受 isBailianBase 约束（第六轮）：agnes 等第三方基址不再收到百炼 Key。
  const apiKey = (
    channel === "primary"
      ? s.ocrApiKey || s.aiKey || (isBailianBase(baseUrl) ? s.dashscopeKey : "")
      : s.aiKey || (isBailianBase(baseUrl) ? s.dashscopeKey : "")
  ).trim();
  const label = channel === "primary" ? "OCR 主通道" : "OCR 兜底通道";
  return { baseUrl, apiKey, problem: endpointProblem(baseUrl, apiKey, label) };
}

/** 视频多模态总结通道（专用 Base URL / Key 留空时复用通用 AI 通道）。 */
export function resolveVideoSummaryChannel(s: DouyinSyncSettings): ResolvedChannel {
  const baseUrl = (s.videoSummaryBaseUrl || s.aiBaseUrl || DEFAULT_SETTINGS.aiBaseUrl).trim();
  const apiKey = (s.videoSummaryApiKey || s.aiKey || (isBailianBase(baseUrl) ? s.dashscopeKey : "")).trim();
  return { baseUrl, apiKey, problem: endpointProblem(baseUrl, apiKey, "视频多模态总结") };
}

/**
 * 配额耗尽类错误识别（2026-10-01 第十三轮，真实样本驱动）：
 * 百炼「AllocationQuota.FreeTierOnly」、compatible-mode「Free quota exhausted」403、欠费。
 * 配额类失败是确定性的——重试必然复现，摘要熔断（syncEngine）据此连续 3 次后跳过
 * 本次运行的摘要与抽帧，避免每条视频白打一次调用 + 白付一次全片下载（09-21 实测 50 连发）。
 */
export function isQuotaExhaustedError(msg: string): boolean {
  return /free quota|quota exhausted|allocationquota|freetieronly|欠费|arrears/i.test(String(msg ?? ""));
}
