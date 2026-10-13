// types/asr.ts —— ASR（语音转写）域类型（自 types.ts 按域拆分，2026-10 类型域拆分轮）：
// 转写结果、失败分类、provider 接口与音频解析钩子。

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
