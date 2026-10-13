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

  /** 设置页改「状态刷新间隔」后调用（2026-09-27 修：原实现间隔只在 start() 算一次，改了不生效）。 */
  restart(): void {
    this.stop();
    this.start();
  }

  /**
   * 端口占用粗检（异常分类 E2 用）：/ping 完全不可达时，探测端口上是否还有**其他** HTTP 服务在应答。
   * 有任何 HTTP 响应（哪怕 404）= 端口被占；连接被拒/超时 = 端口空闲。
   */
  private async portOccupied(): Promise<boolean> {
    try {
      await requestUrl({ url: `${this.getSettings().bridgeUrl}/`, method: "GET", throw: false });
      return true;
    } catch {
      return false;
    }
  }

  /** 一轮探测：GET /ping → 连接态 →（必要时）推进进程态 → 变更才提示。 */
  async probe(): Promise<ConnectionState> {
    if (this.probing) return this.snapshot.connectionState;
    this.probing = true;
    try {
      const s = this.getSettings();
      // 直连模式早退（第九轮 C2）：bridgeEnabled=false 时桥接进程与连接态不再适用——
      // 原实现关掉桥接后仍每 ≤5s ping 桥接端口、持续弹「桥接进程未运行」并建议「启动桥接」，
      // 与实际请求通道漂移。不再探测也不再产生异常提示。
      if (!s.bridgeEnabled) {
        this.lastAnomaly = "NONE";
        this.apply(this.snapshot.processState, "unknown");
        return this.snapshot.connectionState;
      }
      let cs: ConnectionState = "unreachable";
      let ok = false;
      let ready = false;
      let kernel: string | null = null;
      try {
        const r = await requestUrl({ url: `${s.bridgeUrl}/ping`, method: "GET", throw: false });
        if (r.status === 200) {
          const j = r.json ?? {};
          ok = !!j.ok;
          ready = !!j.ready;
          kernel = typeof j.kernel === "string" ? j.kernel : null;
          // ok && !ready = 桥已监听但浏览器未就绪的**启动窗口**（新桥接先听端口再启浏览器）：
          // 归入「连接未知」而不是「连接未授权」，否则每次冷启动都会误报登录态失效（回归审查 #3）
          cs = ok && ready ? "ok" : ok ? "unknown" : "unreachable";
        }
      } catch {
        cs = "unreachable";
      }

      const ps = this.snapshot.processState;
      // 联合迁移（系统设计 §3.2.M4.5）：外部拉起自愈 / 探测不可达不改变进程态
      let next = ps;
      if (ok && (ps === "stopped" || ps === "failed" || ps === "starting")) next = "running";
      this.apply(next, cs);

      // 分级异常提示：仅当异常类型发生变化时触发（防打扰）。
      // 2026-09-27 修：kernel 透传 /ping 的真实字段（原实现喂的是编造值，端口被占会误报「未找到内核」）；
      // 完全不可达且进程态非 running 时补一次端口占用检测，E2（端口被占）才真正可达。
      // 启动窗口（ok && !ready）不参与异常分类：那是「正在启动」，不是连接异常/内核缺失。
      const starting = ok && !ready;
      const portOccupiedByOther = cs === "unreachable" ? await this.portOccupied() : false;
      // 复审 P2：ping 完全不可达时（含进程态滞留 running 的僵尸场景）不再喂 ok:false/kernel:null——
      // 那会命中 classifyAnomaly 的「ok=false 且无 kernel → E3」分支，把「桥已死」误报成
      // 「未找到浏览器内核，请安装 Chrome」；不可达一律走 reachable=false 的 E1/E2 分类
      const code = starting
        ? "NONE"
        : cs === "unreachable"
          ? classifyAnomaly({ reachable: false, portOccupiedByOther })
          : classifyAnomaly({ reachable: true, ok, ready: cs === "ok", kernel });
      // E1 降噪（第九轮 C2）：进程态本就不是 running 时，「桥接进程未运行」是预期状态而非异常——
      // 默认配置（autoStart=false、桥未跑）下每次 Obsidian 启动都会弹 10s P0 纯属打扰。
      // 只有「先前在跑、探测发现没了」（ps=running 的僵尸场景）或端口被别的服务占用（E2）才弹窗。
      const suppressE1 = code === "E1" && next !== "running";
      if (code !== "NONE" && code !== this.lastAnomaly && !suppressE1) {
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
