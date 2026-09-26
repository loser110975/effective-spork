// statusHub.ts — M4 二维状态中心（进程态 × 连接态）。
// 设计依据：delivery/系统设计.md §3.2.M4（含 9 行联合迁移表）；验收标准：UserStory §5.4 / §5.5。
// 本项目相对四个标杆的自研增量：显式建模「进程存活」×「连接可达」两个正交状态。
import { requestUrl } from "obsidian";
import type { DouyinSyncSettings } from "./types";
import {
  ANOMALY_TEXT,
  classifyAnomaly,
  statusAdvice,
  statusVisual,
  type AnomalyCode,
  type ConnectionState,
  type ProcessState,
  type StatusVisual,
} from "./statusCore";
import type { NotifyFn } from "./processManager";

export interface StatusSnapshot {
  processState: ProcessState;
  connectionState: ConnectionState;
  updatedAt: string;
}

export type StatusListener = (s: StatusSnapshot) => void;

export class StatusHub {
  private timer: number | null = null;
  private snapshot: StatusSnapshot = { processState: "stopped", connectionState: "unknown", updatedAt: new Date().toISOString() };
  private listeners = new Set<StatusListener>();
  private lastAnomaly: AnomalyCode = "NONE";
  private probing = false;

  constructor(
    private getSettings: () => DouyinSyncSettings,
    private notifyFn: NotifyFn,
  ) {}

  getStatus(): StatusSnapshot {
    return { ...this.snapshot };
  }

  subscribe(cb: StatusListener): () => void {
    this.listeners.add(cb);
    cb(this.getStatus());
    return () => this.listeners.delete(cb);
  }

  /** ProcessManager 的进程态写入入口（starting / running / stopping / failed / stopped）。 */
  setProcessState(ps: ProcessState): void {
    this.apply(ps, this.snapshot.connectionState);
  }

  /** 进程态由外部（探测到桥接已被独立拉起）推进时使用。 */
  setConnectionState(cs: ConnectionState): void {
    this.apply(this.snapshot.processState, cs);
  }

  start(): void {
    if (this.timer !== null) return;
    const interval = Math.max(1000, Math.min(this.getSettings().processRefreshMs || 5000, 5000));
    this.timer = window.setInterval(() => void this.probe(), interval);
    void this.probe();
  }

  stop(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 一轮探测：GET /ping → 连接态 →（必要时）推进进程态 → 变更才提示。 */
  async probe(): Promise<ConnectionState> {
    if (this.probing) return this.snapshot.connectionState;
    this.probing = true;
    try {
      const s = this.getSettings();
      let cs: ConnectionState = "unreachable";
      let ok = false;
      try {
        const r = await requestUrl({ url: `${s.bridgeUrl}/ping`, method: "GET", throw: false });
        if (r.status === 200) {
          const j = r.json ?? {};
          ok = !!j.ok;
          cs = ok && j.ready ? "ok" : ok ? "unauthorized" : "unreachable";
        }
      } catch {
        cs = "unreachable";
      }

      const ps = this.snapshot.processState;
      // 联合迁移（系统设计 §3.2.M4.5）：外部拉起自愈 / 探测不可达不改变进程态
      let next = ps;
      if (ok && (ps === "stopped" || ps === "failed" || ps === "starting")) next = "running";
      this.apply(next, cs);

      // 分级异常提示：仅当异常类型发生变化时触发（防打扰）
      const code = classifyAnomaly({ reachable: cs !== "unreachable" || ps === "running", ok, ready: cs === "ok", kernel: ok ? "playwright" : null });
      if (code !== "NONE" && code !== this.lastAnomaly) {
        const t = ANOMALY_TEXT[code];
        this.notifyFn(t.level, code === "E1" ? "101004" : code === "E2" ? "101002" : code === "E3" ? "101005" : "101006", t.msg);
      }
      this.lastAnomaly = code;
      return cs;
    } finally {
      this.probing = false;
    }
  }

  private apply(ps: ProcessState, cs: ConnectionState): void {
    if (ps === this.snapshot.processState && cs === this.snapshot.connectionState) return;
    this.snapshot = { processState: ps, connectionState: cs, updatedAt: new Date().toISOString() };
    for (const cb of this.listeners) cb(this.getStatus());
  }
}

/** 面板 / 设置页共用的状态灯渲染（纯展示，逻辑在 statusCore）。 */
export function renderStatusBadge(container: HTMLElement, s: StatusSnapshot): void {
  const v: StatusVisual = statusVisual(s.processState, s.connectionState);
  container.empty();
  const dot = container.createSpan({ cls: "douyin-sync-dot" });
  dot.style.color = v.color;
  dot.setText(v.icon);
  container.createSpan({ cls: "douyin-sync-status-text", text: v.label });
  container.createSpan({ cls: "douyin-sync-status-advice", text: statusAdvice(s.processState, s.connectionState) });
}
