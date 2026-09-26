// itemType.ts — 收藏条目「视频 / 图片（图文）」类型判定的纯函数层。
// 不依赖 obsidian，可在 Node 中独立单元验证（见 .workbuddy/tests/）。
// 判定依据三重信号：is_note 标志、aweme_type 类型码、images 字段——
// 任一明确指向图文即判图文，避免单一启发式误判（2026-09 分类优化需求）。
import { ItemType } from "./types";

/** 抖音 aweme_type 中表示图文（图片集合）的已知取值；0/4 等为视频。 */
export const IMAGE_AWEME_TYPES = new Set<number>([2, 68, 71]);

export interface ItemTypeSignals {
  hasImages: boolean;
  isNote?: boolean;
  awemeType?: number;
}

/** 明确区分视频/图片类收藏：显式图文信号优先，其次回退「有图即图文」启发式。 */
export function classifyItemType(s: ItemTypeSignals): ItemType {
  if (s.isNote === true) return "note";
  if (typeof s.awemeType === "number" && IMAGE_AWEME_TYPES.has(s.awemeType)) return "note";
  return s.hasImages ? "note" : "video";
}

/**
 * 「无视频轨的音频类条目」类型码（2026-09-21 实测定位）。
 * aweme_type=163 / media_type=43 的条目，抖音接口**不提供视频轨**：
 *   video.duration = 0、video.bit_rate = []、video.download_addr = []、
 *   video.play_addr.url_list[0] 直接指向背景音乐（douyinstatic.com 的 ies-music/*.mp3 等）。
 * 第三方类型表（含 0/2/4/68/71/150）均未收录 163。
 * 后果：本地 ffmpeg 的 -map 0:v:0 必然失败 → 该条命令整体退出 → 只留下 0 字节 audio.mp3。
 * 因此这类条目不抽帧、不转写（转写只会拿到 BGM 歌词，污染知识库），直接记 unavailable。
 */
export const AUDIO_ONLY_AWEME_TYPES = new Set<number>([163]);
/** 与 AUDIO_ONLY_AWEME_TYPES 同现的 media_type；实测 1470 条收藏中 43 只出现在 163 上。 */
export const AUDIO_ONLY_MEDIA_TYPES = new Set<number>([43]);

export interface AudioOnlySignals {
  awemeType?: number;
  mediaType?: number;
}

/** 是否属于「不提供视频轨的音频类条目」（见 AUDIO_ONLY_AWEME_TYPES 注释）。 */
export function isAudioOnlyItem(s: AudioOnlySignals): boolean {
  if (typeof s.awemeType === "number" && AUDIO_ONLY_AWEME_TYPES.has(s.awemeType)) return true;
  return typeof s.mediaType === "number" && AUDIO_ONLY_MEDIA_TYPES.has(s.mediaType);
}

/** 该项不可转写时的说明（写入笔记逐字稿区块 + 同步摘要）。 */
export const AUDIO_ONLY_REASON = "条目无视频轨（音频类条目），已跳过转写";
