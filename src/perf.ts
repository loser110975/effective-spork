// perf.ts — 阶段耗时统计（性能埋点 P2-15）。
//
// 输入：state.metrics 里逐条累积的 StageTimings。
// 输出：一行可直接展示的「耗时画像」，用于验证 §8.6 的优化收益是否兑现。
//
// 设计取舍：
// - 取 p50 / p90 而非平均值：单条耗时受视频时长影响极重（30 秒视频 vs 10 分钟视频差 20 倍），
//   平均值会被长尾拉偏，中位数才反映「典型一条要多久」。
// - 只列 ≥0.2s 的阶段并最多列 4 个：避免输出被一堆 0.0s 的阶段淹没。

import type { StageTimings } from "./types";

/** 参与统计的数值字段（显式列出，避免把 id / type / recordedAt 当数字处理）。 */
type NumericKey =
  | "totalMs"
  | "reuseMs"
  | "coverMs"
  | "ffmpegMs"
  | "imagesMs"
  | "ocrMs"
  | "asrMs"
  | "categoryMs"
  | "noteWriteMs"
  | "summaryMs";

/** 展示顺序即优先级：越靠前越可能是瓶颈。 */
const STAGE_LABELS: { key: NumericKey; label: string }[] = [
  { key: "ffmpegMs", label: "视频素材" },
  { key: "summaryMs", label: "视频摘要" },
  { key: "asrMs", label: "转写" },
  { key: "coverMs", label: "封面" },
  { key: "ocrMs", label: "图片OCR" },
  { key: "imagesMs", label: "图片下载" },
  { key: "categoryMs", label: "分类" },
  { key: "noteWriteMs", label: "写笔记" },
  { key: "reuseMs", label: "资产回收" },
];

/** 线性插值分位数（输入不必有序，内部排序）。空数组返回 0。 */
export function percentile(values: number[], p: number): number {
  const arr = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (arr.length === 0) return 0;
  if (arr.length === 1) return arr[0];
  const idx = (arr.length - 1) * Math.min(Math.max(p, 0), 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return arr[lo];
  return arr[lo] + (arr[hi] - arr[lo]) * (idx - lo);
}

/** 秒制显示，保留 1 位小数。 */
function sec(ms: number): string {
  return (ms / 1000).toFixed(1);
}

/**
 * 生成一行耗时画像。
 * 形如：`耗时画像 n=12｜单条 p50 168.2s / p90 220.5s｜视频素材 62.1s｜视频摘要 68.4s｜转写 27.9s`
 */
export function summarizeStageTimings(rows: StageTimings[]): string {
  if (!rows.length) return "";
  const valuesOf = (key: NumericKey) => rows.map((r) => Number(r[key]) || 0);

  const totalP50 = percentile(valuesOf("totalMs"), 0.5);
  const totalP90 = percentile(valuesOf("totalMs"), 0.9);

  const stages = STAGE_LABELS.map((s) => ({ label: s.label, p50: percentile(valuesOf(s.key), 0.5) }))
    .filter((s) => s.p50 >= 200)
    .sort((a, b) => b.p50 - a.p50)
    .slice(0, 4)
    .map((s) => `${s.label} ${sec(s.p50)}s`);

  const head = `耗时画像 n=${rows.length}｜单条 p50 ${sec(totalP50)}s / p90 ${sec(totalP90)}s`;
  return stages.length ? `${head}｜${stages.join("｜")}` : head;
}

/**
 * 生成多行明细（命令「查看同步性能画像」用）：各阶段 p50 / p90。
 * 返回 markdown 风格的纯文本，供 Notice 或 modal 展示。
 */
export function detailStageTimings(rows: StageTimings[]): string {
  if (!rows.length) return "暂无性能样本（先跑一次同步）";
  const valuesOf = (key: NumericKey) => rows.map((r) => Number(r[key]) || 0);
  const lines = [`样本 ${rows.length} 条`, ""];
  const all: { key: NumericKey; label: string }[] = [{ key: "totalMs", label: "单条合计" }, ...STAGE_LABELS];
  for (const s of all) {
    const v = valuesOf(s.key);
    const p50 = percentile(v, 0.5);
    if (s.key !== "totalMs" && p50 < 50) continue; // 明细里也略过 50ms 以下的噪声
    lines.push(`${s.label}：p50 ${sec(p50)}s / p90 ${sec(percentile(v, 0.9))}s`);
  }
  return lines.join("\n");
}
