// asr/failureKind.ts — ASR 失败的结构化分类（P2-2 收敛）。
// 双轨收敛：原 syncEngine.DETERMINISTIC_ASR_FAILURE_RE（字符串正则）保留为兜底，
// 各 provider 返回失败结果时按本模块 classifyAsrFailureKind 打 failureKind 标；
// syncEngine.transcribeVideo 先读结构化字段，字段缺失时回退正则——任何 provider 漏标时
// 重试队列进出判定与改造前逐条一致。
import { AsrFailureKind } from "../types";

/**
 * 「确定性失败」特征（2026-09-21 P2）：素材侧 / 条目结构 / 通道配置问题，
 * 重试必然复现同一结果 → 不进重试队列，避免每条白跑一次 ffmpeg + 一次上传。
 * 原定义在 syncEngine.ts（P2-2 迁至本处供 provider 与引擎共用，正则文本逐字未动）。
 */
export const DETERMINISTIC_ASR_FAILURE_RE =
  /不含视频轨|无法取得音频文件|未接入音频解析通道|音频抽取异常|无播放地址|空壳|未产出有效音轨|缺少 SiliconFlow API Key/;

/** 瞬时网络异常特征（与 asr/siliconflow.ts 的 TRANSIENT_NET_RE 同款口径；该文件自己的重传逻辑不受影响）。 */
const TRANSIENT_NET_RE = /net::ERR_|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|socket hang up/i;

/**
 * 依错误文案打 failureKind 标。策略保守：能明确判定才标，不确定返回 undefined
 * （引擎侧回退正则兜底）。判定顺序保证与改造前逐条一致：
 * 命中确定性正则 → deterministic（引擎原判定即正则命中 → 不入队）；
 * 未命中确定性正则且命中瞬时网络特征 → transient（引擎原判定即正则未命中 → 入队）；
 * 其余 → undefined（引擎回退正则，结果与未打标时代一致）。
 */
export function classifyAsrFailureKind(msg: string): AsrFailureKind | undefined {
  if (DETERMINISTIC_ASR_FAILURE_RE.test(msg)) return "deterministic";
  if (TRANSIENT_NET_RE.test(msg)) return "transient";
  return undefined;
}
