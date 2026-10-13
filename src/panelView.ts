// panelView.ts — 插件管理面板（侧栏视图）：二维状态总览 + 启停重启 + 详情 + OCR/摘要入口。
// 设计依据：delivery/UserStory.md §5.1（US-1 七段式）、§5.4.3（状态灯对照表）、§5.5.3（异常内联块）。
import { ItemView, WorkspaceLeaf } from "obsidian";
import type { BridgeProcessManagerState, DouyinSyncSettings } from "./types";
import type { ProcessManager } from "./processManager";
import { renderStatusBadge, type StatusSnapshot } from "./statusHub";
import { formatRss } from "./statusCore";
import type { StatusHub } from "./statusHub";

export const VIEW_TYPE_DOUYIN_PANEL = "douyin-sync-panel";

export interface PanelHost {
  settings: DouyinSyncSettings;
  processManager: ProcessManager;
  statusHub: StatusHub;
  getPmState(): BridgeProcessManagerState;
  getPingDetail(): Promise<Record<string, unknown> | null>;
  openOcr(): void;
  summarizeActive(): Promise<void>;
}

export class DouyinSyncPanelView extends ItemView {
  private host: PanelHost;
  private unsub: (() => void) | null = null;
  private badgeEl!: HTMLElement;
  private detailEl!: HTMLElement;
  private inlineEl!: HTMLElement;

  constructor(leaf: WorkspaceLeaf, host: PanelHost) {
    super(leaf);
    this.host = host;
  }

  getViewType(): string {
    return VIEW_TYPE_DOUYIN_PANEL;
  }
  getDisplayText(): string {
    return "抖音同步 · 管理面板";
  }
  getIcon(): string {
    return "server";
  }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.createEl("h4", { text: "桥接进程" });

    // 二维状态总览卡
    const card = root.createDiv({ cls: "douyin-sync-card" });
    this.badgeEl = card.createDiv({ cls: "douyin-sync-badge" });

    // 操作区：启动 / 停止 / 重启（点击即执行，无二次确认；进行中禁用，见 §5.1.2）
    const ops = card.createDiv({ cls: "douyin-sync-ops" });
    const mkBtn = (text: string, fn: () => Promise<{ ok: boolean; msg: string }>) => {
      const b = ops.createEl("button", { text });
      b.onclick = () => void this.run(b, fn);
      return b;
    };
    mkBtn("启动桥接", () => this.host.processManager.start());
    mkBtn("停止桥接", () => this.host.processManager.stop());
    mkBtn("重启桥接", () => this.host.processManager.restart());

    // 详情区
    this.detailEl = card.createDiv({ cls: "douyin-sync-detail" });

    // 异常内联块（E1~E4）
    this.inlineEl = root.createDiv({ cls: "douyin-sync-inline" });

    // 图片 OCR 卡片
    if (this.host.settings.ocrPanelEnabled) {
      const c2 = root.createDiv({ cls: "douyin-sync-card" });
      c2.createEl("h5", { text: "图片 OCR" });
      c2.createEl("button", { text: "选择图片并识别" }).onclick = () => this.host.openOcr();
    }

    // AI 摘要卡片
    if (this.host.settings.summaryEnabled) {
      const c3 = root.createDiv({ cls: "douyin-sync-card" });
      c3.createEl("h5", { text: "AI 总结" });
      c3.createEl("button", { text: "为当前笔记生成摘要" }).onclick = () => void this.host.summarizeActive();
    }

    this.unsub = this.host.statusHub.subscribe((s) => this.render(s));
    this.render(this.host.statusHub.getStatus());
  }

  private async run(btn: HTMLButtonElement, fn: () => Promise<{ ok: boolean; msg: string }>): Promise<void> {
    const original = btn.textContent;
    btn.disabled = true;
    btn.setText("处理中…");
    try {
      const r = await fn();
      btn.setText(original);
      btn.disabled = false;
      // 成功时清掉上一次操作残留的错误文案（第九轮 C10）
      if (r.ok) this.inlineEl.setText("");
      else this.inlineEl.setText(r.msg);
      await this.host.statusHub.probe();
    } catch (e: any) {
      btn.setText(original);
      btn.disabled = false;
      this.inlineEl.setText(String(e?.message ?? e));
    }
  }

  private render(s: StatusSnapshot): void {
    renderStatusBadge(this.badgeEl, s);
    const pm = this.host.getPmState();
    this.detailEl.empty();
    const rows: [string, string][] = [
      ["进程态", s.processState],
      ["连接态", s.connectionState],
      ["桥接 PID", pm.bridgePid > 0 ? String(pm.bridgePid) : "未知（外部拉起或未运行）"],
      ["桥接地址", String(this.host.settings.bridgeUrl)],
      ["最近启动", pm.lastStartAt ?? "—"],
      ["最近停止", pm.lastStopAt ?? "—"],
    ];
    for (const [k, v] of rows) {
      const row = this.detailEl.createDiv({ cls: "douyin-sync-row" });
      row.createSpan({ cls: "douyin-sync-k", text: k });
      row.createSpan({ cls: "douyin-sync-v", text: v });
    }
    void this.refreshPingDetail();
  }

  /** /ping 详情固定复用同一行（复审 P2）：原实现每次 render 后异步追加一行，状态频繁翻转时行数只增不减 */
  private pingRow: { value: HTMLElement } | null = null;
  private pingSeq = 0;

  private async refreshPingDetail(): Promise<void> {
    const seq = ++this.pingSeq;
    const d = await this.host.getPingDetail();
    if (!d || seq !== this.pingSeq) return; // 期间又 render 过 → 本次结果作废，防并发双写
    if (!this.pingRow || !this.pingRow.value.isConnected) {
      const row = this.detailEl.createDiv({ cls: "douyin-sync-row" });
      row.createSpan({ cls: "douyin-sync-k", text: "/ping" });
      this.pingRow = { value: row.createSpan({ cls: "douyin-sync-v" }) };
    }
    // 第十轮 P2-1 给 /ping 加了 rss 字节（内存自保的观察口），第十一轮补上展示——
    // 挂机场景下 RSS 持续增长（≥800MB 会整重建）此前只能翻控制台才能看到
    this.pingRow.value.setText(
      `kernel=${d.kernel ?? "—"} ready=${d.ready ?? "—"} headed=${d.headed ?? "—"} rss=${formatRss(d.rss)}`,
    );
  }

  async onClose(): Promise<void> {
    this.unsub?.();
    this.unsub = null;
  }
}
