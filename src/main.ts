import { Notice, Plugin, WorkspaceLeaf, addIcon, requestUrl } from "obsidian";
import * as path from "path";
import { DouyinSyncSettings, DEFAULT_SETTINGS } from "./types";
import { DouyinSyncSettingTab } from "./settings";
import { SyncEngine, SyncSummary } from "./syncEngine";

const SYNC_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-9-9"/><polyline points="21 3 21 9 15 9"/><path d="M9 10v4l3 2"/></svg>`;

export default class DouyinSyncPlugin extends Plugin {
  settings: DouyinSyncSettings = DEFAULT_SETTINGS;
  engine!: SyncEngine;
  private intervalId: number | null = null;
  private statusBarEl!: HTMLElement;

  /** 拉起本地桥接服务并等待就绪（已在运行则直接返回）。 */
  async spawnBridge(): Promise<void> {
    const ping = `${this.settings.bridgeUrl}/ping`;
    try {
      const r = await requestUrl({ url: ping, method: "GET", throw: false });
      if (r.status === 200) return;
    } catch {
      /* 未启动，继续拉起 */
    }
    const port = this.settings.bridgeUrl.split(":").pop() || "8765";
    const script = path.join(this.manifest.dir || "", "douyin-bridge.js");
    const spawn = (window as any).require("child_process").spawn;
    const child = spawn(this.settings.bridgeNodePath, [script, port], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, NODE_PATH: this.settings.bridgeNodeModules },
      cwd: this.manifest.dir || undefined,
    });
    child.unref?.();
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 500));
      try {
        const r = await requestUrl({ url: ping, method: "GET", throw: false });
        if (r.status === 200) return;
      } catch {
        /* 继续等 */
      }
    }
    throw new Error("本地桥接启动超时（15s），请检查 bridgeNodePath / bridgeNodeModules 设置");
  }

  async onload() {
    await this.loadSettings();
    addIcon("douyin-sync", SYNC_ICON);

    this.engine = new SyncEngine(
      this.app,
      this.settings,
      () => this.saveSettings(), // state 与 settings 存在同一 data.json
      (t) => this.setStatusBar(t),
      () => this.spawnBridge(),
    );
    await this.engine.loadState(this._stateRaw);

    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass("douyin-sync-status");
    this.statusBarEl.setText(this.settings.syncIntervalMinutes > 0 ? "抖音同步" : "抖音同步（手动）");
    this.statusBarEl.onClickEvent(() => void this.runSync());

    this.addRibbonIcon("douyin-sync", "抖音同步", () => void this.runSync());

    this.addCommand({
      id: "sync-now",
      name: "立即同步",
      callback: () => void this.runSync(),
    });
    this.addCommand({
      id: "test-connection",
      name: "测试连接",
      callback: () => void this.testDouyinConnection(),
    });
    this.addCommand({
      id: "generate-bases",
      name: "生成 Bases 画廊",
      callback: async () => {
        const { generateBases } = await import("./bases");
        const n = await generateBases(this.app.vault, this.settings.basesFolder);
        this.showResult(n > 0 ? `已生成 ${n} 个 Bases 文件（已存在的不覆盖）` : "Bases 文件已存在，未改动");
      },
    });

    this.addSettingTab(new DouyinSyncSettingTab(this.app, this));
    this.restartInterval();

    // 首次同步：若从未同步过且 Cookie 已配置，延迟 30 秒自动跑一次全量
    if (!this.engine.state.lastSyncAt && this.settings.cookie && this.settings.syncIntervalMinutes > 0) {
      window.setTimeout(() => {
        if (!this.engine.running) void this.runSync();
      }, 30_000);
    }
  }

  onunload() {
    if (this.intervalId !== null) window.clearInterval(this.intervalId);
  }

  async loadSettings() {
    const data: any = (await this.loadData()) ?? {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data.settings ?? data);
    // 兼容：state 存在 settings 旁
    this._stateRaw = data.state;
  }

  private _stateRaw?: unknown;

  async saveSettings() {
    await this.saveData({
      settings: this.settings,
      state: this.engine?.state ?? this._stateRaw,
    });
  }

  async loadEngineState() {
    await this.engine.loadState(this._stateRaw);
  }

  /**
   * 按当前请求通道测试抖音连接。
   *
   * 设置页按钮与命令面板必须共用本入口，避免其中一处漏传桥接配置后
   * 回退到 Obsidian requestUrl 直连，并被抖音 Argus 风控误判为非浏览器请求。
   */
  async testDouyinConnection(): Promise<void> {
    const { DouyinClient } = await import("./douyinClient"); // 仅在用户测试时加载请求客户端。
    const bridgeUrl = this.settings.bridgeEnabled ? this.settings.bridgeUrl : undefined; // 开关关闭时明确选择直连。
    const channelLabel = bridgeUrl ? "（经本地桥接）" : "（直连，未走桥接）"; // 反馈中显示真实通道，便于定位风控。

    try {
      const client = new DouyinClient(this.settings.cookie, bridgeUrl, () => this.spawnBridge()); // 桥未启动时由插件拉起。
      const message = await client.testConnection(); // 只读取少量收藏，验证登录态和 API 响应。
      this.showResult(`${channelLabel}${message}`); // 成功提示也携带通道，避免把桥接成功误认成直连成功。
    } catch (error: any) {
      this.showResult(`连接失败${channelLabel}：${error?.message ?? error}`, true);
    }
  }

  restartInterval() {
    if (this.intervalId !== null) {
      window.clearInterval(this.intervalId);
      this.intervalId = null;
    }
    const min = this.settings.syncIntervalMinutes;
    if (min > 0) {
      this.intervalId = window.setInterval(() => {
        if (!this.engine.running) void this.runSync();
      }, min * 60_000);
      this.statusBarEl?.setText(`抖音同步（每 ${min} 分钟）`);
    } else {
      this.statusBarEl?.setText("抖音同步（手动）");
    }
  }

  private async runSync() {
    if (this.engine.running) {
      new Notice("抖音同步已在进行中");
      return;
    }
    const summary: SyncSummary = await this.engine.syncAll();
    if (summary.asrFailed > 0) {
      new Notice(`有 ${summary.asrFailed} 条转写失败，已加入重试队列（下次同步自动续传）`, 8000);
    }
  }

  setStatusBar(text: string) {
    this.statusBarEl?.setText(`抖音同步｜${text}`);
  }

  showResult(msg: string, isError = false) {
    new Notice(msg, isError ? 10000 : 5000);
  }
}
