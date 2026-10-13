// statusMachine.ts — 二维状态机（进程态 × 连接态）的纯函数层。
// 不依赖 obsidian，可在 Node 中独立单元验证（见 tests/）。

// ---------- 二维状态（M4 StatusHub 的核心新增设计） ----------

export type ProcessState =
  | "stopped" // 已停止
  | "starting" // 启动中
  | "running" // 运行中
  | "stopping" // 停止中
  | "failed"; // 失败

export type ConnectionState =
  | "unknown" // 未知
  | "ok" // 连接正常
  | "unreachable" // 连接不可达
  | "unauthorized"; // 连接未授权（登录态失效）

export interface StatusVisual {
  /** 颜色（CSS 变量优先，回退到字面量以便测试断言） */
  color: string;
  label: string;
  icon: string;
  /** 用户处置建议（UserStory §5.4.3） */
  advice: string;
}

const VISUAL: Record<string, Omit<StatusVisual, "advice">> = {
  "running|ok": { color: "#4caf50", label: "运行中 · 连接正常", icon: "●" },
  "running|unauthorized": { color: "#e6a23c", label: "运行中 · 连接未授权", icon: "▲" },
  "running|unreachable": { color: "#e6a23c", label: "运行中 · 连接不可达", icon: "▲" },
  "running|unknown": { color: "#e6a23c", label: "运行中 · 连接未知", icon: "▲" },
  "starting|ok": { color: "#4c8dff", label: "启动中…", icon: "↻" },
  "starting|unknown": { color: "#4c8dff", label: "启动中…", icon: "↻" },
  "starting|unreachable": { color: "#4c8dff", label: "启动中…", icon: "↻" },
  "starting|unauthorized": { color: "#4c8dff", label: "启动中…", icon: "↻" },
  "stopping|ok": { color: "#4c8dff", label: "停止中…", icon: "↻" },
  "stopping|unknown": { color: "#4c8dff", label: "停止中…", icon: "↻" },
  "stopping|unreachable": { color: "#4c8dff", label: "停止中…", icon: "↻" },
  "stopping|unauthorized": { color: "#4c8dff", label: "停止中…", icon: "↻" },
  "stopped|ok": { color: "#8b93a1", label: "已停止", icon: "●" },
  "stopped|unknown": { color: "#8b93a1", label: "已停止", icon: "●" },
  "stopped|unreachable": { color: "#e05252", label: "已停止", icon: "●" },
  "stopped|unauthorized": { color: "#e05252", label: "已停止", icon: "●" },
  "failed|ok": { color: "#e05252", label: "启动失败", icon: "▲" },
  "failed|unknown": { color: "#e05252", label: "启动失败", icon: "▲" },
  "failed|unreachable": { color: "#e05252", label: "启动失败 · 连接不可达", icon: "▲" },
  "failed|unauthorized": { color: "#e05252", label: "启动失败 · 连接未授权", icon: "▲" },
};

const FALLBACK: Omit<StatusVisual, "advice"> = { color: "#8b93a1", label: "状态未知", icon: "○" };

/** 二维状态 → 状态灯（颜色 + 文案 + 图标 + 处置建议，见 UserStory §5.4.3）。 */
export function statusVisual(ps: ProcessState, cs: ConnectionState): StatusVisual {
  const base = VISUAL[`${ps}|${cs}`] ?? FALLBACK;
  return { ...base, advice: statusAdvice(ps, cs) };
}

/** 由二维状态推导用户处置建议（UserStory §5.4.3 / §5.5.3）。 */
export function statusAdvice(ps: ProcessState, cs: ConnectionState): string {
  if (ps === "stopped") return "点击「启动桥接」一键拉起";
  if (ps === "starting" || ps === "stopping") return "等待就绪轮询完成";
  if (ps === "failed") return "复核 Node 与依赖路径，或查看 bridge.log";
  if (ps === "running" && cs === "ok") return "无需操作";
  if (ps === "running" && cs === "unauthorized") return "检查登录态 / 重新扫码";
  return "检查内核与端口占用";
}

/** E1~E4 异常分类（UserStory §5.5.3）。probe 传 null 表示探测完全不可达。 */
export type AnomalyCode = "E1" | "E2" | "E3" | "E4" | "NONE";

export interface ProbeResult {
  reachable: boolean; // HTTP 是否可达（连接被拒 / 超时 = false）
  ok?: boolean;
  ready?: boolean;
  kernel?: string | null;
  portOccupiedByOther?: boolean; // 启动动作失败后附加检测
}

export const ANOMALY_TEXT: Record<Exclude<AnomalyCode, "NONE">, { msg: string; advice: string; level: "P0" | "P1" | "P2" }> = {
  E1: { msg: "桥接进程未运行", advice: "点击「启动桥接」一键拉起", level: "P0" },
  E2: { msg: "端口 8765 被占用", advice: "终止占用进程，或在设置页更换桥接端口", level: "P0" },
  E3: { msg: "未找到浏览器内核", advice: "安装 Chrome 或 Edge，或保留内置内核", level: "P1" },
  E4: { msg: "桥接已运行但连接异常（可能登录态失效）", advice: "检查登录态 / 重启桥接 / 运行环境自检", level: "P1" },
};

/** 依固定顺序判定异常类型：端口监听 → /ping 可达性 → 内核字段 → 端口占用。 */
export function classifyAnomaly(probe: ProbeResult | null): AnomalyCode {
  if (!probe || !probe.reachable) {
    return probe && probe.portOccupiedByOther ? "E2" : "E1";
  }
  if (probe.ok === false || probe.ready === false) {
    return !probe.kernel ? "E3" : "E4";
  }
  return "NONE";
}

/**
 * 桥接进程 RSS 展示格式化（第十一轮）：/ping 已带 rss 字节（第十轮 P2-1），
 * 面板此前未展示——「管理面板可直接观察」的声明没有落地。字节 → MB 一位小数；
 * 非法输入返回 "—"（字段缺失 / 旧桥接无此字段时不显示噪音）。
 */
export function formatRss(bytes: unknown): string {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return "—";
  return `${(n / 1048576).toFixed(1)}MB`;
}
