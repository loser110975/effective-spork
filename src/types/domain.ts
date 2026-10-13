// types/domain.ts —— 条目域类型（自 types.ts 按域拆分，2026-10 类型域拆分轮）：
// 抖音原始响应结构（宽松）、归一化条目 SyncItem 与来源/类型枚举、来源标签映射。

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

/** 来源 → 中文标签（笔记 frontmatter / 目录归类用）。 */
export const SOURCE_LABEL: Record<ItemSource, string> = {
  collection: "收藏",
  like: "点赞",
  post: "作品",
};
