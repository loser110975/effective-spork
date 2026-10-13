// settingsSanitize.ts — 设置数值消毒与 data.json / 双文件布局抢救判定（第十一轮引入，第十二轮内部重构）。
//
// 背景：设置页 onChange 只消毒键盘输入；data.json 手改 / 外部工具写入 / 旧版本残留的
// 非法数值（NaN / 字符串 / null）会原样进入运行时。危害链以 maxTranscribePerSync=NaN 最重：
// syncAll 里 asrBudgetLeft = Math.max(0, NaN) = NaN → transcribeVideo 的 `NaN <= 0` 恒 false
// → 预算形同虚设（首次全量同步一次性烧几百条转写费）；retryPendingAsr 的 slice(0, NaN)
// 返回空数组 → 重试队列被静默清空。backfillVideos 同链（budget=NaN 使预算 0 语义与
// REUSE_ONLY_CAP 双双失效）。逐项钳制口径与 settings.ts onChange 保持一致。
//
// 对外契约（第十一轮定稿；第十二轮增补：删除死导出 NUMERIC_RULE_FALLBACKS、
// 数组一律按损坏处理——数组不是合法的 settings/state 容器；存储拆分轮增补 payloadNeedsRescue）：
// - sanitizeNumericSettings 就地修改并返回同一对象；合法值原样保留（含数值的取整与钳制）；
// - needsBackupRescue「复合结构的 settings 不是非空对象即抢救」（旧 data.json 及其 .bak）；settings={} 视为存在；settings=数组 → 抢救；
// - payloadNeedsRescue「单文件载荷非非空对象即损坏」（新布局 settings.json/state.json 逐文件抢救）；
// - pickSettingsSource 按「settings 对象 / 损坏回默认 / 旧版扁平兼容」三规则挑合并来源
//   （新布局迁移时对旧 data.json 复合结构同样适用）；
// - fallbackMatchesDefaults 校验 fallback 清单与 DEFAULT_SETTINGS 同步（漂移即测试红）。
import { DEFAULT_SETTINGS, type DouyinSyncSettings } from "./types/settings";

interface NumericRule {
  key: keyof DouyinSyncSettings;
  min?: number;
  max?: number;
  fallback: number;
}

/** 数值设置清单（key → 合法区间与缺省值）；与 settings.ts 各 onChange 的钳制逐项对齐。 */
const NUMERIC_RULES: NumericRule[] = [
  { key: "syncIntervalMinutes", min: 0, fallback: 60 },
  { key: "maxTranscribePerSync", min: 0, fallback: 20 },
  { key: "scanStopAfterProcessed", min: 0, fallback: 100 },
  { key: "syncConcurrency", min: 1, max: 6, fallback: 3 },
  { key: "keyframeIntervalSec", min: 1, max: 60, fallback: 10 },
  { key: "maxImages", min: 1, max: 10, fallback: 10 },
  { key: "visionConcurrency", min: 1, max: 6, fallback: 3 },
  { key: "relatedNotesMax", min: 1, max: 30, fallback: 8 },
  { key: "summaryMaxTokens", min: 200, max: 4000, fallback: 500 },
  { key: "processRefreshMs", min: 1000, max: 5000, fallback: 5000 },
];

/** 宽松对象判定：null 的 typeof 也是 "object"，须显式排除；数组不是合法的 settings/state
 *  容器（第十二轮收紧，原先按对象放行会把索引键混进合并结果），同样排除。 */
function isObjectLike(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * 非法数值 → null；合法数值 / 数字字符串 → 向下取整。
 * 判定必须是「值本身是数字/数字字符串」而不是直接 Number(raw)——
 * Number(null)/Number(false)/Number("") 都得 0，会把「字段缺失」静默变成合法的 0
 * （如 keyframeIntervalSec=null → 1s 每秒抽帧，转写预算 null → 0 恒禁用）。
 * 字符串只做一次 Number 解析（原实现判定与取整各解析一次）。
 */
function coerceInt(raw: unknown): number | null {
  let n: number;
  if (typeof raw === "number") n = raw;
  else if (typeof raw === "string" && raw.trim() !== "") n = Number(raw);
  else return null;
  return Number.isFinite(n) ? Math.floor(n) : null;
}

/** 闭区间钳制：先下限后上限（与原逐分支写法语义完全一致；未设边界即不钳该侧）。 */
function clamp(n: number, min: number | undefined, max: number | undefined): number {
  if (min !== undefined && n < min) n = min;
  if (max !== undefined && n > max) n = max;
  return n;
}

/**
 * 就地消毒 settings 的全部数值字段：真正的数字（含可解析的数字字符串）取整并钳到合法区间；
 * 其余一律回默认值。返回同一对象便于链式。
 */
export function sanitizeNumericSettings(s: DouyinSyncSettings): DouyinSyncSettings {
  const box = s as unknown as Record<string, unknown>;
  for (const r of NUMERIC_RULES) {
    const parsed = coerceInt(box[r.key]);
    box[r.key] = parsed === null ? r.fallback : clamp(parsed, r.min, r.max);
  }
  return s;
}

/**
 * data.json 是否需要走备份抢救（第十一轮：条件从 `!data || (!data.settings && !data.state)`
 * 收紧为「settings 不是非空对象即抢救」）。原条件漏掉两类半损坏形态——
 * 「state 完整但 settings 键丢失」与「settings 键存在但为 null/字符串」（手改误删 / 外部工具
 * 部分写入）：state 存在使抢救短路，Cookie 与全部 API Key 静默回默认值（等于配置归零），
 * 而 .bak 里明明有完整 settings 可恢复。settings={} 视为存在（全默认但非丢失）；
 * settings=数组按损坏处理（第十二轮收紧：数组不是合法 settings 容器）。
 */
export function needsBackupRescue(data: unknown): boolean {
  if (!isObjectLike(data)) return true;
  return !isObjectLike(data.settings);
}

/**
 * 单文件载荷抢救判定（存储拆分轮新增，settings.json/state.json 双文件布局适配）：
 * 新布局里每个文件载荷就是对象本体（不再是 {settings, state} 复合结构），
 * 「非非空对象即损坏」——口径与 isObjectLike 一致，供 pluginStorage 的逐文件抢救链使用。
 * 旧 data.json 复合结构的判定仍走 needsBackupRescue（检查 settings 键域）。
 */
export function payloadNeedsRescue(raw: unknown): boolean {
  return !isObjectLike(raw);
}

/**
 * 从 data.json 顶层结构挑出与 DEFAULT_SETTINGS 合并的 settings 来源（第十二轮接线收口）。
 * 修复原 `data?.settings ?? data` 回退链在「.bak 抢救也失败」时的两类异常路径污染：
 * - settings 键存在但损坏（null/字符串）→ 原写法回退合并整个 data，把 state 整块 / 字符串
 *   索引键混进 settings，随下次 saveSettings 固化进 data.json；现改为只用默认值；
 * - data 整体非对象（截断成标量）→ 原写法把字符串索引键逐字符混进 settings；现返回空对象。
 * 兼容保留：settings 是对象 → 直接用；无 settings 键（旧版扁平 data.json）→ 顶层即 settings。
 * 数组（无论作为 data 整体还是 settings 值）一律按损坏处理，返回空对象（第十二轮收紧）。
 */
export function pickSettingsSource(data: unknown): Record<string, unknown> {
  if (!isObjectLike(data)) return {};
  if (isObjectLike(data.settings)) return data.settings;
  return "settings" in data ? {} : data;
}

/** 供测试断言：fallback 必须与 DEFAULT_SETTINGS 对应字段一致（漂移即测试红）。 */
export function fallbackMatchesDefaults(s: DouyinSyncSettings = DEFAULT_SETTINGS): boolean {
  const box = s as unknown as Record<string, unknown>;
  return NUMERIC_RULES.every((r) => box[r.key] === r.fallback);
}
