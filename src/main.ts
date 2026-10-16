import { Notice, Plugin, TFile, addIcon, requestUrl } from "obsidian";
import * as path from "path";
import type { BridgeProcessManagerState } from "./types/state";
import { DEFAULT_SETTINGS, type DouyinSyncSettings } from "./types/settings";
import { DouyinSyncSettingTab } from "./settings";
import { SyncEngine, SyncSummary } from "./syncEngine";
import { ProcessManager, type NotifyFn, type ProcResult } from "./processManager";
import { StatusHub } from "./statusHub";
import { DouyinSyncPanelView, VIEW_TYPE_DOUYIN_PANEL, type PanelHost } from "./panelView";
import { OcrResultModal, runOcr, pickImageFile, pushVisionRecord, readImageAsDataUrl } from "./ocrService";
import { pushSummaryRecord } from "./statusCore";
import { generateSummaryForFile } from "./summaryService";
import { statusVisual } from "./statusCore";
import { pickSettingsSource, sanitizeNumericSettings } from "./settingsSanitize";
import { PluginFileStore, SETTINGS_FILE, STATE_FILE } from "./pluginStorage";
// nodeRequire 已随 P2-1 迁出（spawn 实现整体移至 ProcessManager.ensureRunning）
import { fsExists, resolveNodeExe } from "./util";

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
  private settingTab: DouyinSyncSettingTab | null = null;

  /** 拉起中的 promise（single-flight）：并发条目同时发现桥不可用时只发起一次拉起，避免多开 Chromium 抢同一 profile。 */
  private spawning: Promise<void> | null = null;
  /** 上次拉起失败时间（失败冷却：60s 内不再重试 spawn，防止同步期间反复空拉）。 */
  private lastSpawnFailAt = 0;
  /** onload 里的延迟启动定时器（复审 P2）：卸载时要能取消，否则禁用/重载后仍会拉起桥接或触发同步 */
  private startupTimers: number[] = [];
  /** data.json 写盘串行链（复审 P2）：引擎落盘 / 设置防抖 / PM persist / OCR·摘要台账都会并发写 */
  private saveChain: Promise<void> = Promise.resolve();

  /** 拉起本地桥接服务并等待就绪（已在运行则直接返回；并发调用合并为同一次拉起）。 */
  async spawnBridge(): Promise<void> {
    if (this.spawning) return this.spawning;
    const p = this.spawnBridgeInner().catch((e) => {
      // 冷却写入收进共享链（复审 P2）：finally 清 spawning 先于 owner 的 catch 执行，
      // 中间微任务窗口内新到的调用会看到「无在飞 + 无冷却」而绕过冷却二次 spawn
      this.lastSpawnFailAt = Date.now();
      throw e;
    });
    this.spawning = p.finally(() => {
      this.spawning = null;
    });
    await this.spawning;
  }

  private async spawnBridgeInner(): Promise<void> {
    // P2-1 单轨化：spawn→探测→就绪轮询→超时兜底的完整实现已迁至 ProcessManager.ensureRunning
    // （三态探测 / 15s·45s·60s 超时常量 / stderr 管道诊断 / detached+NODE_PATH / taskkill /T 整树
    // 全部复用 PM 一套，trackEngineSpawn 登记在 PM 内部完成，任何拉起路径都登记）。
    // 本方法只保留 main 侧关注点：60s 失败冷却的判定与记账（lastSpawnFailAt 在 spawnBridge 的
    // catch 里写入）；冷却门以回调注入，保证「先探测、后冷却」次序（回归审查 #6）。
    await this.processManager.ensureRunning(() => {
      if (Date.now() - this.lastSpawnFailAt < 60_000) {
        throw new Error("本地桥接刚拉起失败（60 秒冷却内），请检查 Node / 依赖配置或用「测试连接」复验");
      }
    });
  }

  async onload() {
    await this.loadSettings();
    addIcon("douyin-sync", SYNC_ICON);

    this.engine = new SyncEngine(
      this.app,
      this.settings,
      () => this.saveStateFile(), // 引擎节流落盘只写 state.json（settings 与 state 已拆双文件）
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
    // 图文 OCR 补录（2026-10-16）：同步收尾也会自动跑一轮，此命令是手动全量入口
    this.addCommand({
      id: "vision-backfill",
      name: "补录图文笔记的图片文字",
      callback: () => void this.backfillVisionOcr(),
    });
    // 强制重抽帧（keyframeIntervalSec 不追溯的逃生门）：一次性标志，下次同步生效后自动清除
    this.addCommand({
      id: "force-frame-resync",
      name: "抖音同步：重抽全部视频帧（下次同步生效）",
      callback: () => void this.requestForceFrameResync(),
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
    // 重试队列可视化（2026-09-27 新增）：dead-letter 条目此前只能翻 data.json 才能发现
    this.addCommand({
      id: "asr-retry-queue",
      name: "查看转写重试队列",
      callback: () => {
        const summary = this.engine.retryQueueSummary();
        console.log(`[douyin-sync] ${summary}`);
        new Notice(summary, 12000);
      },
    });
    // 相关笔记互链（2026-09-27 第八轮）：同步时自动增量互链，本命令全量重建
    this.addCommand({ id: "related-refresh", name: "重建相关笔记链接", callback: () => void this.rebuildRelatedNotes() });

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

    const settingTab = new DouyinSyncSettingTab(this.app, this);
    this.addSettingTab(settingTab);
    // 持有引用供 onunload 冲刷防抖（2026-09-27 第四轮）：停在设置页直接退出 Obsidian 时，
    // 600ms 防抖窗口内最后一批输入只落在 hide() 之外的路径上
    this.settingTab = settingTab;

    // 二维状态：订阅 → 状态栏（常驻浓缩呈现），并按 processRefreshMs 轮询（≤ 5s）
    this.statusUnsub = this.statusHub.subscribe((s) => {
      const v = statusVisual(s.processState, s.connectionState);
      this.bridgeStatusText = v.label;
      this.renderStatusBar();
    });
    this.statusHub.start();
    this.restartInterval();

    // 临时素材根目录清理（P3-2）：onload 即清上次会话崩溃残留，不等首次视频拉取
    this.engine.cleanupTempRoot();

    // 启动时自动拉起桥接（processAutoStart 默认开启，2026-10-16 拍板）：
    // ≠系统开机自启——只在 Obsidian 运行期拉起，退出仍随插件 dispose 回收，登录态失效仍需人工扫码
    if (this.settings.processAutoStart && this.settings.bridgeEnabled) {
      this.startupTimers.push(window.setTimeout(() => void this.processManager.start(), 3_000));
    }

    // 首次同步：若从未同步过且 Cookie 已配置，延迟 30 秒自动跑一次全量
    if (!this.engine.state.lastSyncAt && this.settings.cookie && this.settings.syncIntervalMinutes > 0) {
      this.startupTimers.push(
        window.setTimeout(() => {
          if (!this.engine.running) void this.runSync();
        }, 30_000),
      );
    }
  }

  onunload() {
    // 卸载后回调必须失效（复审 P2）：否则禁用/重载的 3s/30s 窗口内仍会拉起桥接或跑一轮同步
    for (const t of this.startupTimers) window.clearTimeout(t);
    this.startupTimers = [];
    if (this.intervalId !== null) window.clearInterval(this.intervalId);
    this.statusUnsub?.();
    this.statusUnsub = null;
    this.statusHub?.stop();
    // 设置页 600ms 防抖窗口内的最后一批输入在卸载前落盘（2026-09-27 第四轮）：
    // 停在设置页直接退出 Obsidian / 禁用插件时，hide() 不会触发
    this.settingTab?.flushPendingSave();
    // 副作用防抖（第九轮 C11）在卸载后不能执行：重启定时器/轮询会泄漏
    this.settingTab?.cancelPendingEffect();
    // 落盘节流窗口内可能还有未写盘的进度（性能治理 P0-2）：卸载前补一次强制落盘
    void this.engine?.flushNow();
    // 防进程泄漏：只终止本插件拉起的桥接整树（系统设计 §3.2.M1.5 Step 5）
    void this.processManager?.dispose();
  }

  async loadSettings() {
    // 存储拆分轮：data.json → settings.json / state.json 双文件。读路径三段：
    // ① 双新文件齐全 → 读新（损坏先走各自 .bak 抢救链）；
    // ② 旧 data.json 存在 → 自动迁移（按键域拆分写双新文件，data.json 原样保留作回滚锚点）；
    // ③ 都没有 → 全新安装。任何损坏都降级为 Notice + 默认值，不让插件加载失败。
    const dir = this.manifest.dir || "";
    this.store = new PluginFileStore(this.app.vault.adapter, dir);
    const result = await this.store.load();
    for (const n of result.notices) new Notice(n, 12000);
    // settings 消毒口径与旧版一致：pickSettingsSource 吃 {settings: 载荷} 合成复合结构——
    // 载荷是对象本体 → 直接采用；损坏/缺失 → {}（只用默认值）；旧扁平 data.json 兼容仍在函数内。
    this.settings = sanitizeNumericSettings(
      Object.assign({}, DEFAULT_SETTINGS, pickSettingsSource({ settings: result.settings })),
    );
    // state 载荷直接进引擎（engine.loadState 自带形状消毒）
    this._stateRaw = result.state;
  }

  private _stateRaw?: unknown;

  /** 双文件存储（loadSettings 时创建）：原子写 + 各自 .bak 备份链，旧 data.json 只读不写。 */
  private store!: PluginFileStore;

  /** F4 抢救与备份链已随存储拆分轮迁入 PluginFileStore（各文件独立 .bak，10 分钟节流）：
   *  旧 data.json 只读不写，作为迁移回滚锚点原样保留。 */

  async saveSettings() {
    // 串行写链（复审 P2 沿用）：所有调用方收口到同一条 Promise 链，避免并发写交错。
    // 存储拆分后本方法写双文件：settings.json（设置）+ state.json（台账快照）——
    // OCR/摘要/PM persist 等改完 state 再调 saveSettings 的既有调用点语义不变。
    const store = this.store;
    const p = this.saveChain.then(async () => {
      await store.writeJson(SETTINGS_FILE, this.settings);
      await store.writeJson(STATE_FILE, this.engine?.state ?? this._stateRaw ?? {});
    });
    this.saveChain = p.then(
      () => undefined,
      () => undefined,
    );
    await p;
  }

  /** 引擎节流落盘专用（onStateChange）：只写 state.json，不再连带全量序列化 settings。 */
  private async saveStateFile(): Promise<void> {
    const store = this.store;
    const p = this.saveChain.then(() => store.writeJson(STATE_FILE, this.engine?.state ?? this._stateRaw ?? {}));
    this.saveChain = p.then(
      () => undefined,
      () => undefined,
    );
    await p;
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

    // nodepath 过期加固（U1）：走桥接通道且配置了 Node 路径时，拉起前先做文件存在性快检——
    // 路径已失效立即 Notice 并按回退路径继续完成测试，绝不空等 15s 超时后才见到 ENOENT。
    // 决策复用 util.resolveNodeExe（与 spawn 侧同一纯函数）；后续 spawn 由 ProcessManager
    // 的同名逻辑自动回退 PATH node，本处只负责「立即有感知」。
    if (bridgeUrl) {
      const resolved = resolveNodeExe({ bridgeNodePath: this.settings.bridgeNodePath });
      if (resolved.stalePath) {
        new Notice(`Node 路径文件不存在：${resolved.stalePath}，已自动回退 PATH node 重试`);
      }
    }

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
    // 自动失败重试（2026-10-16 拍板「失败处置烦」）：同步收尾自动补两类缺口，不等人工捞——
    // ① 图文 OCR 缺口（上限 30 条/轮，成功段不重打零重复计费）
    // ② 摘要缺口（补跑通道 zeroAsrBudget 模式：只重出「已有转录」的摘要，零转写计费，上限 50）
    // 两者都受 backfillFails 连续失败保护（≥3 跳过），无缺口时引擎返回空串 → 不弹 Notice。
    try {
      const msgs: string[] = [];
      const ocrMsg = await this.engine.backfillVision((t) => this.setStatusBar(t));
      if (ocrMsg) msgs.push(ocrMsg);
      const sumMsg = await this.engine.backfillVideos((t) => this.setStatusBar(t), { zeroAsrBudget: true });
      if (sumMsg) msgs.push(sumMsg);
      if (msgs.length) new Notice(msgs.join("\n"), 10000);
    } catch (e: any) {
      // 补缺口失败不吞同步结果：只提示，不重抛
      new Notice(`自动补缺口失败：${String(e?.message ?? e)}`, 8000);
    } finally {
      // 自动链复用了状态栏展示进度，收尾恢复成常规「上次同步」口径
      this.setStatusBar(`上次同步 ${new Date().toLocaleTimeString("zh-CN")}`);
    }
    // 强制重抽帧（一次性标志）：常规同步只覆盖新增条目，已存视频的强制重抽由补跑通道执行。
    // 标志在补跑轮收尾自动清除；补跑失败（抛错）时标志保留，下次同步继续。
    if (this.engine.state.forceFrameResync && !this.engine.running) {
      new Notice("检测到强制重抽帧标志：开始重抽全部视频帧…", 8000);
      try {
        const msg = await this.engine.backfillVideos((t) => this.setStatusBar(t));
        new Notice(msg, 10000);
      } catch (e: any) {
        new Notice(`强制重抽视频帧失败：${String(e?.message ?? e)}`, 8000);
      }
    }
  }

  /** 置位强制重抽帧标志（命令面板入口）：置位 + Notice 确认 + 立即落盘。 */
  private async requestForceFrameResync(): Promise<void> {
    if (this.engine.state.forceFrameResync) {
      new Notice("强制重抽已置位，将在下次同步时生效（完成后自动清除）", 8000);
      return;
    }
    this.engine.state.forceFrameResync = true;
    await this.saveSettings();
    new Notice(
      "已置位强制重抽：下次同步时将忽略已存的抽帧间隔，重新抽取全部视频帧（受转写预算约束，完成后自动清除）",
      12000,
    );
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

  /** 图片 OCR：选择 → 校验 → 主通道识别 → 展示。 */
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
    try {
      const read = await readImageAsDataUrl(file);
      if (!read.dataUrl) {
        new Notice(read.error ?? "图片读取失败", 8000);
        return;
      }
      new Notice("识别中…");
      const out = await runOcr(this.settings, read.dataUrl, file.name, "");
      this.engine.state.vision = pushVisionRecord(this.engine.state.vision, {
        imagePath: file.name,
        channel: "primary",
        status: out.ok ? "success" : "failed",
        text: out.text,
        errorCode: out.errorCode,
        elapsedMs: out.elapsedMs,
        createdAt: new Date().toISOString(),
      });
      await this.saveSettings();
      if (!out.ok) {
        new Notice(
          `识别失败${out.errorCode ? `（错误码 ${out.errorCode}）` : ""}${out.error ? `：${out.error}` : ""}`,
          8000,
        );
        return;
      }
      new OcrResultModal(this.app, out.text, out.modelUsed ?? "").open();
    } catch (e: any) {
      // 命令入口兜底（复审 P2）：异常冒泡只会变成无反馈的 unhandled rejection
      new Notice(`图片识别异常：${String(e?.message ?? e).slice(0, 150)}`, 8000);
    }
  }

  /** AI 摘要：对当前活动笔记生成，原文零覆盖。视频笔记自动走多模态通道（转录+关键帧）。 */
  async summarizeActive(): Promise<void> {
    // 第十轮：同步进行中拦截——processItem 对同一条笔记的全量重写与手动摘要写入会互相覆盖
    //（各自都是 vault.process 原子写，但两次变换基于不同快照，先后顺序决定内容去留）
    if (this.engine.running) {
      new Notice("抖音同步正在进行中，请稍后再试");
      return;
    }
    const file = this.app.workspace.getActiveFile();
    if (!file || !(file instanceof TFile)) {
      new Notice("请先打开一篇笔记");
      return;
    }
    try {
      const r = await generateSummaryForFile(this.app, file, this.settings);
      if (r.record) {
        this.engine.state.summary = pushSummaryRecord(this.engine.state.summary, r.record);
        await this.saveSettings();
      }
      if (!r.ok) new Notice(r.msg, 8000);
    } catch (e: any) {
      // 命令入口兜底（复审 P2）：文件被删/IO 异常时给用户可见反馈而非静默失败
      new Notice(`摘要生成异常：${String(e?.message ?? e).slice(0, 150)}`, 8000);
    }
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

  /** 图文 OCR 补录（2026-10-16）：历史无块 / 识别失败段批量重识别并原位回写。 */
  async backfillVisionOcr(): Promise<void> {
    if (this.engine.running) {
      new Notice("抖音同步正在进行中，请稍后再试");
      return;
    }
    new Notice("图文 OCR 补录：开始…", 0);
    try {
      const msg = await this.engine.backfillVision((t) => this.setStatusBar(t));
      new Notice(msg || "图文 OCR 补录：无缺口（全部健康或未启用 OCR）", 10000);
    } catch (e: any) {
      new Notice(`图文 OCR 补录失败：${String(e?.message ?? e)}`, 8000);
    }
  }

  /** 重建全部相关笔记链接（第八轮）：历史笔记 / 改过分类后一次性刷新全库互链。 */
  async rebuildRelatedNotes(): Promise<void> {
    if (this.engine.running) {
      new Notice("抖音同步正在进行中，请稍后再试");
      return;
    }
    // 开关守卫（第九轮 A12）：关闭互链后执行重建会违背用户意愿全库写入互链块
    if (!this.settings.relatedNotesEnabled) {
      new Notice("相关笔记互链已在设置中关闭，请先开启后再重建");
      return;
    }
    const n = new Notice("重建相关笔记链接…");
    try {
      const r = await this.engine.refreshAllRelatedNotes();
      n.setMessage(`相关笔记链接重建完成：扫描 ${r.scanned} 篇，更新 ${r.updated} 篇`);
    } catch (e: any) {
      n.setMessage(`重建失败：${String(e?.message ?? e).slice(0, 150)}`);
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
