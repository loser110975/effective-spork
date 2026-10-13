import { Notice, Plugin, TFile, addIcon, normalizePath, requestUrl } from "obsidian";
import * as path from "path";
import { BridgeProcessManagerState, DouyinSyncSettings, DEFAULT_SETTINGS } from "./types";
import { DouyinSyncSettingTab } from "./settings";
import { SyncEngine, SyncSummary } from "./syncEngine";
import { ProcessManager, type NotifyFn, type ProcResult } from "./processManager";
import { StatusHub } from "./statusHub";
import { DouyinSyncPanelView, VIEW_TYPE_DOUYIN_PANEL, type PanelHost } from "./panelView";
import { OcrResultModal, ocrWithFallback, pickImageFile, pushVisionRecord, readImageAsDataUrl, setOcrApp } from "./ocrService";
import { pushSummaryRecord } from "./statusCore";
import { generateSummaryForFile } from "./summaryService";
import { statusVisual } from "./statusCore";
import { needsBackupRescue, pickSettingsSource, sanitizeNumericSettings } from "./settingsSanitize";
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
    const ping = `${this.settings.bridgeUrl}/ping`;
    // 三态探测（第九轮 C15）：ready=就绪；starting=桥已监听但浏览器未就绪（慢启动，要等不能杀）；
    // down=不可达。原实现二值化后，慢机器上 Chromium 启动超 15s 的健康桥会被超时分支 taskkill。
    const probe = async (): Promise<"ready" | "starting" | "down"> => {
      try {
        const r = await requestUrl({ url: ping, method: "GET", throw: false });
        if (r.status !== 200) return "down";
        const j = r.json;
        return !!j?.ok && !!j?.ready ? "ready" : j?.ok ? "starting" : "down";
      } catch {
        return "down";
      }
    };
    if ((await probe()) === "ready") return;
    // 冷却检查放在探测之后（回归审查 #6）：桥可能已在启动中或被外部拉起，
    // 冷却挡住「先 ping」会造成桥就绪后仍报「冷却内」的假性失败
    if (Date.now() - this.lastSpawnFailAt < 60_000) {
      throw new Error("本地桥接刚拉起失败（60 秒冷却内），请检查 Node / 依赖配置或用「测试连接」复验");
    }
    // 端口解析与 processManager.port() 同款正则：split(":").pop() 在无端口 URL 上会把「//127.0.0.1」当端口
    const portMatch = this.settings.bridgeUrl.match(/:(\d+)\s*\/?$/);
    const port = portMatch ? portMatch[1] : "8765";
    // 脚本路径走 resolveBridgeScript（2026-09-27 第四轮）：manifest.dir 是 Vault 相对路径，
    // Obsidian 进程 cwd ≠ Vault 根时 path.join 出来的相对路径解析失败，且 stdio:ignore 把
    // 「Cannot find module」吞掉，用户只看到「启动超时」；resolveBridgeScript 核过存在性
    const script = this.resolveBridgeScript();
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
      // stderr 走管道（第九轮 C4，与 PM 路径同款）：缺脚本/缺依赖时 node 秒退、stderr 带真实原因，
      // 原 stdio:"ignore" + 无 exit 监听 = 诊断黑洞，只能空等满 15s 后给通用报错
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
      env,
      cwd: script ? path.dirname(script) : undefined,
    });
    child.unref?.();
    // spawn 后立即登记（2026-09-27 第四轮，原为 ready 后才登记）：慢机器上 Chromium 启动超 15s
    // 时原实现走超时分支，这个 child 从未进过台账，dispose 的身份校验名单里没有它——孤儿无人回收
    if (child.pid) this.processManager?.trackEngineSpawn(Number(child.pid));
    // spawn 对不存在的可执行文件是异步 emit error（复审 P1）：不挂监听会以
    // uncaught exception 崩掉渲染进程，用户看到的是崩溃而非本方法尾部的明确报错
    const spawnErr: { err: Error | null } = { err: null };
    child.on("error", (e: Error) => {
      spawnErr.err = e;
    });
    let stderrTail = "";
    child.stderr?.on("data", (d: unknown) => {
      stderrTail = (stderrTail + String(d)).slice(-1200);
    });
    // 退出状态放对象里承载（回调赋值，TS 对基本类型局部变量会收窄成 never）
    const exitState: { code: number | null; done: boolean } = { code: null, done: false };
    child.on("exit", (code: number | null) => {
      exitState.code = code;
      exitState.done = true;
    });
    const START_TIMEOUT_MS = 15_000;
    const startWaitAt = Date.now(); // 超时文案报告实际等待时长（第九轮复审批 2：C15 慢启动下原文案写死 15s 误导排查）
    let deadline = Date.now() + START_TIMEOUT_MS;
    const hardDeadline = deadline + 45_000; // 慢启动上限 60s（与 PM 路径 45s 原地等待对齐）
    for (;;) {
      await new Promise((r) => setTimeout(r, 500));
      if (spawnErr.err) {
        throw new Error(
          `桥接进程启动失败：${spawnErr.err.message}（请检查 Node 路径「${nodeExe}」与依赖目录配置）`,
        );
      }
      const st = await probe();
      if (st === "ready") {
        return;
      }
      if (exitState.done && st === "down") {
        // 子进程已退出且端口无健康桥：带上 stderr 尾巴报真实原因（第九轮 C4）
        const tail = stderrTail.trim().slice(-200);
        throw new Error(
          `桥接进程启动后立即退出（code=${exitState.code}）${tail ? `：${tail}` : ""}（脚本：${script}）`,
        );
      }
      if (st === "starting") {
        // 桥在启动中（可能外部拉起或本子进程慢启动）→ 延长等待而不是计失败并杀掉健康桥（第九轮 C15）
        deadline = Math.min(hardDeadline, Math.max(deadline, Date.now() + 10_000));
      }
      if (Date.now() >= deadline) break;
    }
    // 超时兜底（2026-09-27 第四轮）：child.kill() 在 Windows 是 TerminateProcess，只杀 node 主进程，
    // playwright 启动的 Chromium 成为孤儿继续持有 profile 锁，之后每次拉桥都失败。改 taskkill /F /T 整树终止
    try {
      child.kill();
    } catch {
      /* 已退出则忽略 */
    }
    if (child.pid) {
      const cp = nodeRequire<{ exec: (cmd: string, opts: object, cb?: (err: unknown, stdout: string) => void) => void }>("child_process");
      try {
        cp?.exec(`taskkill /F /T /PID ${Number(child.pid)}`, { windowsHide: true }, () => {});
      } catch {
        /* 清理失败不影响报错路径 */
      }
    }
    throw new Error(
      `本地桥接启动超时（等了 ${Math.round((Date.now() - startWaitAt) / 1000)}s，慢启动上限 60s）。` +
        `请确认：① Node 已安装且路径正确 ② 依赖目录含 playwright-core ③ 已扫码登录抖音。`,
    );
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

    // 可选：启动时自动拉起桥接（默认关闭；用户已明确不要开机自启类行为）
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
    // F4（第十轮）：主文件损坏/为空时从 data.json.bak 抢救。data.json 全量非原子写（truncate-write），
    // 写盘中段被杀（断电/强杀）会留下截断文件——本项目有过截断事故前科，截断即台账与全部 Key
    // 一次归零。bak 由 saveSettings 周期性落成（落后主文件 ≤10 分钟，可接受）。
    let data: any = null;
    try {
      data = (await this.loadData()) ?? null;
    } catch {
      data = null;
    }
    if (needsBackupRescue(data)) {
      try {
        const adapter = this.app.vault.adapter;
        // 第十轮复审批：bak 之外再探 .bak.tmp——备份是「copy 到 tmp 再换名」两步（见 maybeBackupData），
        // 换名窗口被杀会留下 bak 缺失 + tmp 完整的中间态；tmp 残留也可能本身是半截 copy，
        // JSON.parse 不过就当没有，继续探下一个候选
        const bakCandidates = [
          normalizePath(`${this.manifest.dir}/data.json.bak`),
          normalizePath(`${this.manifest.dir}/data.json.bak.tmp`),
        ];
        for (const bakPath of bakCandidates) {
          if (!(await adapter.exists(bakPath))) continue;
          try {
            const parsed = JSON.parse(await adapter.read(bakPath));
            if (parsed && (parsed.settings || parsed.state)) {
              data = parsed;
              console.warn("[douyin-sync] data.json 损坏/缺失，已从备份恢复 settings/state");
              new Notice("抖音同步：data.json 读取失败，已从备份 data.json.bak 恢复", 10000);
              break;
            }
          } catch {
            /* 该副本损坏/为空，试下一个候选 */
          }
        }
      } catch {
        /* 抢救失败按全新安装处理 */
      }
    }
    // 数值消毒（第十一轮）：设置页 onChange 只消毒键盘输入，手改 data.json / 外部工具写入的
    // NaN/字符串会让 maxTranscribePerSync=NaN 静默解除转写预算（计费失控）、slice(0,NaN) 清空
    // 重试队列。统一在读取入口按设置页同口径钳制（详见 settingsSanitize.ts 头注释）。
    // 合并来源守卫（第十二轮）：settings 键损坏且 .bak 抢救也失败时只用默认值，
    // 不再回退合并整个 data（避免 state 整块/字符串索引键混入 settings 随下次落盘固化）。
    this.settings = sanitizeNumericSettings(Object.assign({}, DEFAULT_SETTINGS, pickSettingsSource(data)));
    // 兼容：state 存在 settings 旁
    this._stateRaw = data?.state;
  }

  private _stateRaw?: unknown;

  /** F4（第十轮）：距上次备份 ≥10 分钟时把 data.json 复制为同目录 data.json.bak（成功落盘后调用）。
   *  第十轮复审批两处加固：① copy 先落 .bak.tmp 再换名——adapter.copy 直接覆盖旧备份的话，
   *  copy 中段被杀（与主文件写坏是独立事件，完全可能叠加）会把**唯一的好备份**变成半截文件，
   *  F4 的抢救通道随之整体失效；同目录 rename 是元数据操作，bak 永远要么旧完整要么新完整。
   *  ② lastBakAt 在成功后才记账——原实现在 copy 前置位，失败后 10 分钟内不重试。 */
  private async maybeBackupData(): Promise<void> {
    const now = Date.now();
    if (now - this.lastBakAt < 10 * 60_000) return;
    try {
      const adapter = this.app.vault.adapter;
      const dataPath = normalizePath(`${this.manifest.dir}/data.json`);
      const bakPath = normalizePath(`${this.manifest.dir}/data.json.bak`);
      if (!(await adapter.exists(dataPath))) return;
      const tmpPath = normalizePath(`${this.manifest.dir}/data.json.bak.tmp`);
      await adapter.copy(dataPath, tmpPath);
      try {
        if (await adapter.exists(bakPath)) await adapter.remove(bakPath);
      } catch {
        /* remove 失败让下一步 rename 失败，走外层 catch 下轮重试 */
      }
      await adapter.rename(tmpPath, bakPath);
      this.lastBakAt = now;
    } catch {
      /* 备份失败不影响主流程（主文件仍是权威数据）；lastBakAt 未置位，下次落盘即重试 */
    }
  }

  private lastBakAt = 0;

  async saveSettings() {
    // 串行写链（复审 P2）：data.json 全量 ~700KB 且非原子写，引擎落盘（节流队列只串行化引擎侧）、
    // 设置防抖、PM persist、OCR/摘要台账写入并发到达时，两个 write 交错有截断/混写风险
    //（本项目有过 data.json 截断事故前科）。所有调用方收口到同一条 Promise 链。
    const p = this.saveChain.then(() =>
      this.saveData({
        settings: this.settings,
        state: this.engine?.state ?? this._stateRaw,
      }),
    );
    this.saveChain = p.then(
      () => undefined,
      () => undefined,
    );
    await p;
    void this.maybeBackupData();
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
    try {
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
          `识别失败${out.declinedFallback ? "（已取消付费通道）" : ""}${out.errorCode ? `（错误码 ${out.errorCode}）` : ""}${out.error ? `：${out.error}` : ""}`,
          8000,
        );
        return;
      }
      new OcrResultModal(this.app, out.text, out.channel, out.modelUsed ?? "").open();
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
