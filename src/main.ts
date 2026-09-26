import { Notice, Plugin, TFile, addIcon, requestUrl } from "obsidian";
import * as path from "path";
import { BridgeProcessManagerState, DouyinSyncSettings, DEFAULT_SETTINGS } from "./types";
import { DouyinSyncSettingTab } from "./settings";
import { SyncEngine, SyncSummary } from "./syncEngine";
import { ProcessManager, type NotifyFn, type ProcResult } from "./processManager";
import { StatusHub } from "./statusHub";
import { DouyinSyncPanelView, VIEW_TYPE_DOUYIN_PANEL, type PanelHost } from "./panelView";
import { OcrResultModal, ocrWithFallback, pickImageFile, pushVisionRecord, readImageAsDataUrl, setOcrApp } from "./ocrService";
import { generateSummaryForFile, pushSummaryRecord } from "./summaryService";
import { statusVisual } from "./statusCore";
import { fsExists, nodeRequire } from "./util";

const SYNC_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-9-9"/><polyline points="21 3 21 9 15 9"/><path d="M9 10v4l3 2"/></svg>`;

export default class DouyinSyncPlugin extends Plugin {
  settings: DouyinSyncSettings = DEFAULT_SETTINGS;
  engine!: SyncEngine;
  processManager!: ProcessManager;
  statusHub!: StatusHub;
  private intervalId: number | null = null;
  private statusBarEl!: HTMLElement;
  private syncStatusText = "";
  private bridgeStatusText = "";
  private statusUnsub: (() => void) | null = null;

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
    const spawn = nodeRequire<{ spawn: typeof import("child_process").spawn }>("child_process")?.spawn;
    if (!spawn) throw new Error("Node 运行时不可用（非桌面端或 nodeIntegration 关闭），无法拉起桥接");
    // 未配置路径时回退到 PATH 里的 node；未配置依赖目录时不写 NODE_PATH，交给常规解析。
    // 安装脚本会按目标机器把这两项写好，所以正常情况下都命中第一个分支。
    const nodeExe = (this.settings.bridgeNodePath || "").trim() || "node";
    const env: Record<string, string | undefined> = { ...process.env };
    const modulesDir = (this.settings.bridgeNodeModules || "").trim();
    if (modulesDir) env.NODE_PATH = modulesDir;
    const child = spawn(nodeExe, [script, port], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env,
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
    throw new Error("本地桥接启动超时（15s）。请确认：① Node 已安装且路径正确 ② 依赖目录含 playwright-core ③ 已扫码登录抖音。");
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

    // ---- 四项新功能接线（M1 进程管控 / M4 二维状态中心 / M2 OCR / M3 摘要） ----
    const notify: NotifyFn = (level, _code, msg) => {
      if (level === "P0" || level === "P1") new Notice(msg, level === "P0" ? 10000 : 8000);
    };
    this.statusHub = new StatusHub(() => this.settings, notify);
    this.processManager = new ProcessManager({
      getSettings: () => this.settings,
      getPmState: () => this.ensurePmState(),
      persist: () => this.saveSettings(),
      notify,
      onProcessState: (ps) => this.statusHub.setProcessState(ps),
      bridgeScriptPath: () => this.resolveBridgeScript(),
      pluginDir: () => {
        const s = this.resolveBridgeScript();
        return s ? path.dirname(s) : this.manifest.dir || "";
      },
    });
    setOcrApp(this.app);

    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass("douyin-sync-status");
    this.setStatusBar(this.settings.syncIntervalMinutes > 0 ? "" : "手动");
    this.statusBarEl.onClickEvent(() => void this.runSync());

    this.addRibbonIcon("douyin-sync", "抖音同步", () => void this.runSync());
    this.addRibbonIcon("server", "抖音同步 · 管理面板", () => void this.openPanel());

    this.registerView(
      VIEW_TYPE_DOUYIN_PANEL,
      (leaf) => new DouyinSyncPanelView(leaf, this.panelHost()),
    );

    this.addCommand({
      id: "open-panel",
      name: "打开管理面板",
      callback: () => void this.openPanel(),
    });
    // 桥接命令：失败结果必须可见（Notice），不允许静默
    const pmNotice = (p: Promise<ProcResult>) =>
      void p.then((r) => {
        if (!r.ok) new Notice(r.msg, 8000);
      });
    this.addCommand({ id: "bridge-start", name: "启动桥接进程", callback: () => pmNotice(this.processManager.start()) });
    this.addCommand({ id: "bridge-stop", name: "停止桥接进程", callback: () => pmNotice(this.processManager.stop()) });
    this.addCommand({ id: "bridge-restart", name: "重启桥接进程", callback: () => pmNotice(this.processManager.restart()) });
    this.addCommand({ id: "ocr-pick", name: "图片文字识别（选择图片）", callback: () => void this.openOcr() });
    this.addCommand({ id: "summary-generate", name: "为当前笔记生成 AI 摘要", callback: () => void this.summarizeActive() });
    this.addCommand({
      id: "video-backfill",
      name: "补跑旧视频笔记（转录+抽帧+摘要）",
      callback: () => void this.backfillVideos(),
    });
    this.addCommand({
      id: "perf-report",
      name: "查看同步性能画像",
      callback: () => {
        // 埋点展示（P2-15）：一行画像 + 分阶段明细，同时写控制台便于留档对比
        const line = this.engine.perfSummary();
        const detail = this.engine.perfDetail();
        console.log(`[douyin-sync] ${line}\n${detail}`);
        new Notice(`${line}\n\n${detail}`, 15000);
      },
    });

    // 既有命令（保留，不破坏原有功能）
    this.addCommand({ id: "sync-now", name: "立即同步", callback: () => void this.runSync() });
    this.addCommand({ id: "test-connection", name: "测试连接", callback: () => void this.testDouyinConnection() });
    this.addCommand({ id: "retry-asr", name: "重试失败转写", callback: () => void this.runSync() });
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

    // 二维状态：订阅 → 状态栏（常驻浓缩呈现），并按 processRefreshMs 轮询（≤ 5s）
    this.statusUnsub = this.statusHub.subscribe((s) => {
      const v = statusVisual(s.processState, s.connectionState);
      this.bridgeStatusText = v.label;
      this.renderStatusBar();
    });
    this.statusHub.start();
    this.restartInterval();

    // 可选：启动时自动拉起桥接（默认关闭；用户已明确不要开机自启类行为）
    if (this.settings.processAutoStart && this.settings.bridgeEnabled) {
      window.setTimeout(() => void this.processManager.start(), 3_000);
    }

    // 首次同步：若从未同步过且 Cookie 已配置，延迟 30 秒自动跑一次全量
    if (!this.engine.state.lastSyncAt && this.settings.cookie && this.settings.syncIntervalMinutes > 0) {
      window.setTimeout(() => {
        if (!this.engine.running) void this.runSync();
      }, 30_000);
    }
  }

  onunload() {
    if (this.intervalId !== null) window.clearInterval(this.intervalId);
    this.statusUnsub?.();
    this.statusUnsub = null;
    this.statusHub?.stop();
    // 落盘节流窗口内可能还有未写盘的进度（性能治理 P0-2）：卸载前补一次强制落盘
    void this.engine?.flushNow();
    // 防进程泄漏：只终止本插件拉起的桥接整树（系统设计 §3.2.M1.5 Step 5）
    void this.processManager?.dispose();
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
      this.setStatusBar(`每 ${min} 分钟`);
    } else {
      this.setStatusBar("手动");
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
    this.syncStatusText = text;
    this.renderStatusBar();
  }

  /** 状态栏 = 常驻桥接状态（二维）+ 同步进度（引擎回调），二者互不覆盖。 */
  private renderStatusBar() {
    const parts = ["抖音同步"];
    if (this.bridgeStatusText) parts.push(this.bridgeStatusText);
    if (this.syncStatusText) parts.push(this.syncStatusText);
    this.statusBarEl?.setText(parts.join("｜"));
  }

  private panelHost(): PanelHost {
    return {
      settings: this.settings,
      processManager: this.processManager,
      statusHub: this.statusHub,
      getPmState: () => this.ensurePmState(),
      getPingDetail: () => this.getPingDetail(),
      openOcr: () => void this.openOcr(),
      summarizeActive: () => this.summarizeActive(),
    };
  }

  private async openPanel(): Promise<void> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(VIEW_TYPE_DOUYIN_PANEL);
    const leaf = existing.length ? existing[0] : workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: VIEW_TYPE_DOUYIN_PANEL, active: true });
    workspace.revealLeaf(leaf);
  }

  /** 兼容旧 data.json：进程管控状态缺省时给默认值（系统设计 §4.2.3）。 */
  private ensurePmState(): BridgeProcessManagerState {
    if (!this.engine.state.processManager) {
      this.engine.state.processManager = {
        bridgePid: -1,
        panelPid: -1,
        treePids: [],
        lastStartAt: null,
        lastStopAt: null,
        lastCommandKey: null,
        lastErrorCode: null,
        updatedAt: null,
      };
    }
    return this.engine.state.processManager;
  }

  /**
   * 解析 douyin-bridge.js 绝对路径：优先 manifest.dir，回退「Vault 根 + 配置目录 + 插件目录」。
   * 两个候选都核过存在性才返回；都找不到时返回第一个候选（让下游报错带出具体路径，便于定位）。
   */
  resolveBridgeScript(): string {
    const name = "douyin-bridge.js";
    const candidates: string[] = [];
    if (this.manifest.dir) candidates.push(path.join(this.manifest.dir, name));
    try {
      const v = this.app.vault as any;
      const base: string | undefined = v?.adapter?.basePath;
      const cfg: string = (typeof v?.getConfigDir === "function" ? v.getConfigDir() : ".obsidian") || ".obsidian";
      if (base) candidates.push(path.join(String(base), String(cfg), "plugins", "douyin-sync", name));
    } catch {
      /* 适配器不可用时忽略，走 manifest.dir 候选 */
    }
    for (const c of candidates) if (fsExists(c)) return c;
    return candidates[0] ?? "";
  }

  /** 图片 OCR：选择 → 校验 → 主通道 →（失败且开关开启）显式确认 → 付费兜底 → 展示。 */
  async openOcr(): Promise<void> {
    if (!this.settings.ocrPanelEnabled) {
      new Notice("图片 OCR 已在设置中关闭");
      return;
    }
    const file = await pickImageFile();
    if (!file) {
      new Notice("未选择图片");
      return;
    }
    const read = await readImageAsDataUrl(file);
    if (!read.dataUrl) {
      new Notice(read.error ?? "图片读取失败", 8000);
      return;
    }
    new Notice("识别中…");
    const out = await ocrWithFallback(this.settings, read.dataUrl, file.name, "");
    this.engine.state.vision = pushVisionRecord(this.engine.state.vision, {
      imagePath: file.name,
      channel: out.channel,
      status: out.ok ? "success" : out.declinedFallback ? "awaiting_confirm" : "failed",
      text: out.text,
      errorCode: out.errorCode,
      elapsedMs: out.elapsedMs,
      createdAt: new Date().toISOString(),
    });
    await this.saveSettings();
    if (!out.ok) {
      new Notice(
        `识别失败${out.declinedFallback ? "（已取消付费通道）" : ""}${out.errorCode ? `（错误码 ${out.errorCode}）` : ""}`,
        8000,
      );
      return;
    }
    new OcrResultModal(this.app, out.text, out.channel).open();
  }

  /** AI 摘要：对当前活动笔记生成，原文零覆盖。视频笔记自动走多模态通道（转录+关键帧）。 */
  async summarizeActive(): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file || !(file instanceof TFile)) {
      new Notice("请先打开一篇笔记");
      return;
    }
    const r = await generateSummaryForFile(this.app, file, this.settings);
    if (r.record) {
      this.engine.state.summary = pushSummaryRecord(this.engine.state.summary, r.record);
      await this.saveSettings();
    }
    if (!r.ok) new Notice(r.msg, 8000);
  }

  /** 批量补跑旧视频笔记：缺转录或缺摘要的视频笔记重新执行新流程（预算=每次转写上限）。 */
  async backfillVideos(): Promise<void> {
    if (this.engine.running) {
      new Notice("抖音同步正在进行中，请稍后再试");
      return;
    }
    new Notice("开始补跑旧视频笔记…");
    try {
      const msg = await this.engine.backfillVideos((t) => this.setStatusBar(t));
      new Notice(msg, 10000);
    } catch (e: any) {
      new Notice(`补跑失败：${String(e?.message ?? e)}`, 8000);
    }
  }

  private async getPingDetail(): Promise<Record<string, unknown> | null> {
    try {
      const r = await requestUrl({ url: `${this.settings.bridgeUrl}/ping`, method: "GET", throw: false });
      return r.status === 200 ? ((r.json ?? null) as Record<string, unknown> | null) : null;
    } catch {
      return null;
    }
  }

  showResult(msg: string, isError = false) {
    new Notice(msg, isError ? 10000 : 5000);
  }
}
