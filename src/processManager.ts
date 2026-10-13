// processManager.ts — M1 进程管控（桥接启动 / 停止 / 重启 + PID 持久化与去重 + 卸载整树终止）。
// 设计依据：delivery/系统设计.md §3.2.M1、§4.2.3；验收标准：UserStory §5.1。
// 纪律：start/stop/restart 的任何异常都必须转成可见失败（Notice + 返回值），绝不静默吞掉；
//       桥接子进程 stderr 捕获保留尾巴，失败时随提示输出（消除「stdio:ignore」导致的诊断黑洞）。
import { requestUrl, type RequestUrlParam } from "obsidian";
import type { BridgeProcessManagerState, DouyinSyncSettings } from "./types";
import { isNumericPid, parsePidsFromNetstat, type AnomalyCode, type ProcessState } from "./statusCore";
import { nodeRequire } from "./util";

/** 分级提示通道（P0~P3），与 M4 StatusHub 共用同一实现。 */
export type NotifyFn = (level: "P0" | "P1" | "P2" | "P3", code: string, msg: string) => void;

export interface ProcessManagerDeps {
  getSettings(): DouyinSyncSettings;
  getPmState(): BridgeProcessManagerState;
  persist(): Promise<void>;
  notify: NotifyFn;
  /** 进程态变更回调（M4 StatusHub 订阅） */
  onProcessState(ps: ProcessState): void;
  /** douyin-bridge.js 绝对路径（与 bridge-common.js 成对部署，见 AGENTS.md） */
  bridgeScriptPath(): string;
  /** 插件目录（作为桥接子进程 cwd） */
  pluginDir(): string;
}

const START_TIMEOUT_MS = 15_000; // 插件侧就绪等待（30 × 500ms）；控制台侧 25s 为有意差异，见 系统设计 §3.5
const START_POLL_INTERVAL = 500;
const STOP_DRAIN_MS = 6_000; // 优雅退出后轮询等待上限（桥接 ctx.close() 通常 1~3s，固定短等会白白落到强杀）
const STDERR_TAIL = 1200;

export interface ProcResult {
  ok: boolean;
  msg: string;
  anomaly?: AnomalyCode;
}

export class ProcessManager {
  /** 进行中的命令去重标记：同一时刻只允许一条启停命令（幂等，拒绝重复 spawn） */
  private busy = false;
  /** 本次会话内由本插件拉起的子进程 PID（onunload 整树终止用） */
  private spawnedPids: number[] = [];
  /** 桥接子进程 stderr 尾巴（失败时附在提示里） */
  private lastStderr = "";

  constructor(private deps: ProcessManagerDeps) {}

  /**
   * 登记引擎路径（main.spawnBridge）拉起的桥接 PID（复审 P2）：
   * 这些桥不在 start() 管控链里，不登记的话 dispose/stop 对它既不会优雅退出也不会兜底强杀
   * （ownsPortHolders 判 false → 跳过；pids 集合里也没有它）——每次 Obsidian退出泄漏一个 Chromium。
   * 2026-09-27 第四轮：同步写入持久化台账（bridgePid / treePids）——只存内存的话，
   * Obsidian 崩溃后重启，spawnedPids 清空、台账是陈旧值，跨会话游离的桥 + Chromium
   * 锁着 profile，后续 start() 只会「已在运行」短路，永不收编。
   */
  trackEngineSpawn(pid: number): void {
    if (!Number.isFinite(pid) || pid <= 0 || this.spawnedPids.includes(pid)) return;
    this.spawnedPids.push(pid);
    const pm = this.pm();
    pm.bridgePid = pid;
    pm.treePids = [...this.spawnedPids];
    void this.deps.persist().catch(() => {});
  }

  private get s(): DouyinSyncSettings {
    return this.deps.getSettings();
  }

  private port(): number {
    const m = this.s.bridgeUrl.match(/:(\d+)\s*\/?$/);
    return m ? Number(m[1]) : 8765;
  }

  private pm(): BridgeProcessManagerState {
    return this.deps.getPmState();
  }

  private setState(ps: ProcessState): void {
    this.deps.onProcessState(ps);
  }

  private async ping(): Promise<{ reachable: boolean; ok?: boolean; ready?: boolean; kernel?: string | null }> {
    try {
      const r = await requestUrl({ url: `${this.s.bridgeUrl}/ping`, method: "GET", throw: false });
      if (r.status !== 200) return { reachable: false };
      const j = r.json;
      return { reachable: true, ok: !!j?.ok, ready: !!j?.ready, kernel: j?.kernel ?? null };
    } catch {
      return { reachable: false };
    }
  }

  /**
   * netstat -ano 找出监听桥接端口的 PID（parsePidsFromNetstat 只取 LISTENING 且端口精确匹配）。
   * 返回 null = 探测本身失败（exec 超时 / 无 node）——「无法确认」不等于「端口空闲」，
   * 调用方（ownsPortHolders）必须按保守处理，不得据此对外部进程动手。
   */
  private async findPidsByPort(): Promise<number[] | null> {
    const out = await this.exec("netstat -ano");
    if (!out || !out.trim()) return null;
    return parsePidsFromNetstat(out, this.port());
  }

  private exec(cmd: string, timeoutMs = 10_000): Promise<string> {
    return new Promise((resolve) => {
      const cp = nodeRequire<{ exec: (cmd: string, opts: object, cb: (err: unknown, stdout: string) => void) => void }>("child_process");
      if (!cp) return resolve("");
      try {
        cp.exec(cmd, { timeout: timeoutMs, windowsHide: true }, (err: unknown, stdout: string) =>
          resolve(err && !stdout ? "" : String(stdout ?? "")),
        );
      } catch {
        resolve("");
      }
    });
  }

  private async killTree(pid: number): Promise<void> {
    if (!isNumericPid(String(pid)) || pid <= 0) return;
    await this.exec(`taskkill /F /T /PID ${pid}`);
  }

  /**
   * taskkill 前校验该 PID 当前映像是否为 node.exe（2026-09-27 修）：
   * bridgePid / treePids 跨会话持久化在 data.json，Windows 会复用 PID——
   * 桥接崩溃后 PID 落到别的进程上时，/T 整树终止会误杀无关进程树。
   * 查询失败（tasklist 无输出）宁可视为非目标进程、放弃强杀。
   */
  private async isNodeProcess(pid: number): Promise<boolean> {
    const out = await this.exec(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, 5000);
    if (!out.trim()) return false;
    return /"node\.exe"/i.test(out);
  }

  /**
   * 强杀前的命令行指纹校验（2026-09-27 第四轮）：isNodeProcess 只能挡住「PID 被非 Node 进程复用」，
   * 挡不住「被另一个 node.exe 复用」（开发机极常见）——taskkill /F /T 照样误杀无关 Node 进程树。
   * 桥接进程的命令行必含 douyin-bridge.js，用 PowerShell CIM 查询命令行做二次确认
   * （wmic 在 Win11 已弃用）；查询失败/超时/无输出一律视为非目标、放弃强杀（宁可放过）。
   */
  private async isBridgeProcess(pid: number): Promise<boolean> {
    if (!(await this.isNodeProcess(pid))) return false;
    const out = await this.exec(
      `powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine"`,
      8000,
    );
    if (!out.trim()) return false;
    return /douyin-bridge\.js/i.test(out);
  }

  /** 轮询等待桥接 /ping ready（新桥接先听端口后启浏览器，就绪判据是 ok && ready）。 */
  private async waitReady(ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    for (;;) {
      const p = await this.ping();
      if (p.reachable && p.ok && p.ready) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, START_POLL_INTERVAL));
    }
  }

  /**
   * 轮询等待桥接不可达（优雅退出 / 强杀后的复核）：每 500ms ping 一次，
   * 原固定等 1.5s 的实现多数情况来不及等 ctx.close()（1~3s）完成，白白落到强杀分支。
   */
  private async waitGone(ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    for (;;) {
      const after = await this.ping();
      if (!after.reachable) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, START_POLL_INTERVAL));
    }
  }

  private clearPids(): void {
    const pm = this.pm();
    pm.bridgePid = -1;
    pm.treePids = [];
    this.spawnedPids = [];
  }

  // ---------- 三个对外命令：异常一律可见化 ----------

  async start(): Promise<ProcResult> {
    try {
      return await this.startInner(false);
    } catch (e: any) {
      this.setState("failed");
      this.pm().lastErrorCode = "101001";
      this.pm().updatedAt = new Date().toISOString();
      const msg = `启动桥接异常：${String(e?.message ?? e)}` + (this.lastStderr ? `｜桥接 stderr：${this.lastStderr}` : "");
      this.deps.notify("P0", "101001", msg);
      return { ok: false, msg, anomaly: "E1" };
    } finally {
      this.busy = false;
    }
  }

  async stop(): Promise<ProcResult> {
    try {
      return await this.stopInner(false);
    } catch (e: any) {
      this.setState("failed");
      this.pm().lastErrorCode = "101003";
      this.pm().updatedAt = new Date().toISOString();
      const msg = `停止桥接异常：${String(e?.message ?? e)}`;
      this.deps.notify("P1", "101003", msg);
      return { ok: false, msg };
    } finally {
      this.busy = false;
    }
  }

  /**
   * 重启 = 停止 + 启动（核心路径 ≤ 2 步，见 高层架构设计 §6.4 关键交互约束）。
   * 全程持有同一 busy 会话（2026-09-27 第四轮）：原实现 stop() 的 finally 释放 busy 到
   * start() 置位之间有窗口，并发命令可在两段之间插入。
   */
  async restart(): Promise<ProcResult> {
    if (this.busy) return { ok: true, msg: "已有进行中的启停命令，已忽略重复请求" };
    this.busy = true;
    try {
      const stopped = await this.stopInner(true);
      if (!stopped.ok) return stopped;
      const started = await this.startInner(true);
      return { ok: started.ok, msg: started.ok ? "桥接已重启" : `重启失败：${started.msg}` };
    } catch (e: any) {
      this.setState("failed");
      const msg = `重启桥接异常：${String(e?.message ?? e)}`;
      this.deps.notify("P1", "101003", msg);
      return { ok: false, msg };
    } finally {
      this.busy = false;
    }
  }

  /**
   * 端口上的桥是否「归我们管」（回归审查 #2）：监听 PID 属于本会话 spawn 或持久化台账，
   * 或端口空闲，才允许 dispose 时发优雅退出——外部独立拉起的桥不该在 Obsidian 卸载时被顺手关掉。
   */
  private async ownsPortHolders(): Promise<boolean> {
    const holders = await this.findPidsByPort();
    // 探测失败 ≠ 端口空闲（2026-09-27 第四轮）：netstat 超时时按「无法确认归属」保守处理，
    // 不向可能属于外部进程的端口发优雅退出
    if (!holders) return false;
    if (!holders.length) return true;
    const ours = new Set<number>([...this.spawnedPids, ...(this.pm().treePids ?? [])]);
    if (isNumericPid(String(this.pm().bridgePid)) && this.pm().bridgePid > 0) ours.add(this.pm().bridgePid);
    return holders.some((p) => ours.has(p));
  }

  /** onunload 防泄漏：只终止本插件拉起的整树；外部独立拉起的仅解除引用（系统设计 §3.2.M1.5 Step 5）。 */
  async dispose(): Promise<void> {
    const pids = new Set<number>([...this.spawnedPids, ...(this.pm().treePids ?? [])]);
    // 先优雅退出（关 Chromium 上下文释放 profile 锁，2026-09-27 修：原实现每次 Obsidian 退出都直接强杀），
    // 3s 内自行退场就不必强杀；幸存者再逐个验身份后整树终止。
    // 优雅退出仅在端口上的桥确属我们管理时发起（回归审查 #2）：否则外部独立拉起的桥会被误关。
    if (await this.ownsPortHolders()) {
      const graceful = await this.requestShutdown();
      if (graceful) {
        const gone = await this.waitGone(3_000);
        if (gone) {
          this.spawnedPids = [];
          this.clearPids();
          await this.deps.persist();
          return;
        }
      }
    }
    for (const pid of pids) {
      // 持久化 PID 先验身份再杀（2026-09-27 第四轮升级为命令行指纹）：
      // 不是 douyin-bridge（含 PID 被其他 node.exe 复用的情形）一律跳过，防误杀无关进程树
      if (isNumericPid(String(pid)) && pid > 0 && (await this.isBridgeProcess(pid))) await this.killTree(pid);
    }
    this.spawnedPids = [];
    this.clearPids();
    await this.deps.persist();
  }

  // ---------- 内部实现 ----------

  private async startInner(force: boolean): Promise<ProcResult> {
    if (!force) {
      if (this.busy) return { ok: true, msg: "已有进行中的启停命令，已忽略重复请求" };
      this.busy = true;
    }
    this.lastStderr = "";
    this.setState("starting");

    // Step 1: 探测 —— 已就绪则幂等短路（可能是外部独立拉起的）。
    // 2026-09-27 修：新桥接先听端口再启浏览器，启动窗口内 /ping 会 ok=true 但 ready=false，
    // 这种「正在启动」状态不能当成就绪短路，要等它 ready。
    const probe = await this.ping();
    if (probe.reachable && probe.ok && !probe.ready) {
      // 桥已监听但浏览器未就绪（外部拉起 / 上条命令刚拉起）：原地等它就绪。
      // 回归审查 #7：这里绝不能 spawn 第二实例（EADDRINUSE 白死一场），
      // 也不能跌落到 Step4 把「正在启动的桥」误报成 E2 端口被占。
      const readyInPlace = await this.waitReady(START_TIMEOUT_MS + 30_000);
      const pmWait = this.pm();
      pmWait.updatedAt = new Date().toISOString();
      if (readyInPlace) {
        pmWait.lastErrorCode = null;
        this.setState("running");
        return { ok: true, msg: "桥接已在启动中并就绪（未重复拉起）" };
      }
      const recheck = await this.ping();
      if (recheck.reachable && recheck.ok) {
        this.setState("failed");
        const msg = "桥接已监听端口但 45s 未就绪（浏览器启动过慢或自检未通过），已放弃等待；请查看 bridge.log";
        this.deps.notify("P1", "101001", msg);
        return { ok: false, msg, anomaly: "E1" };
      }
      // 等待期间进程退场 → 跌落正常 spawn 流程
    }
    if (probe.reachable && probe.ok && probe.ready) {
      const pm = this.pm();
      pm.updatedAt = new Date().toISOString();
      this.setState("running");
      return { ok: true, msg: "桥接已在运行（未重复拉起）" };
    }

    // Step 2: spawn（detached / 捕获 stderr / windowsHide / NODE_PATH 注入）
    const nodeExe = this.s.bridgeNodePath.trim() || "node";
    const script = this.deps.bridgeScriptPath();
    const pluginDir = this.deps.pluginDir();
    if (!script) {
      this.pm().lastErrorCode = "101001";
      this.pm().updatedAt = new Date().toISOString();
      this.setState("failed");
      const msg = "无法定位桥接脚本：manifest.dir 与 Vault 根目录均不可用";
      this.deps.notify("P0", "101001", msg);
      return { ok: false, msg, anomaly: "E1" };
    }
    const env: Record<string, string | undefined> = { ...process.env };
    const modulesDir = this.s.bridgeNodeModules.trim();
    if (modulesDir) env.NODE_PATH = modulesDir;

    let childPid = -1;
    const cp = nodeRequire<{ spawn: typeof import("child_process").spawn }>("child_process");
    if (!cp) {
      this.pm().lastErrorCode = "101001";
      this.pm().updatedAt = new Date().toISOString();
      this.setState("failed");
      const msg = "Node 运行时不可用（非桌面端或 nodeIntegration 关闭），无法拉起桥接";
      this.deps.notify("P0", "101001", msg);
      return { ok: false, msg, anomaly: "E1" };
    }
    try {
      const child = cp.spawn(nodeExe, [script, String(this.port())], {
        detached: true,
        // stdout 用 ignore（2026-09-27 修）：Windows 下管道写入是同步的，无人消费的 stdout 在
        // 日志风暴时填满 64KB 缓冲会阻塞桥接的事件循环，整个进程假死；诊断信息在 stderr 与 bridge.log
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
        env,
        cwd: pluginDir || undefined,
      });
      child.unref?.();
      child.stderr?.on("data", (d: unknown) => {
        this.lastStderr = (this.lastStderr + String(d)).slice(-STDERR_TAIL);
      });
      child.on("error", (e: Error) => {
        // spawn 对不存在的可执行文件是异步 emit error（复审 P1）：不挂监听会以
        // uncaught exception 崩掉渲染进程；这里留证据，由就绪轮询超时路径给出明确报错
        if (!this.lastStderr) this.lastStderr = `桥接进程启动失败：${String(e?.message ?? e)}`;
      });
      child.on("exit", (code: number) => {
        // 启动阶段进程即退出 = 拉起失败（如缺依赖 / 内核缺失），留下证据
        if (!this.lastStderr) this.lastStderr = `桥接进程提前退出（code=${code}）`;
      });
      childPid = Number(child.pid) || -1;
    } catch (e: any) {
      this.pm().lastErrorCode = "101001";
      this.pm().updatedAt = new Date().toISOString();
      this.setState("failed");
      const msg = `拉起桥接失败：${e?.message ?? e}`;
      this.deps.notify("P0", "101001", msg);
      return { ok: false, msg, anomaly: "E1" };
    }
    if (isNumericPid(String(childPid))) this.spawnedPids.push(childPid);

    // Step 3: 就绪轮询（30 × 500ms ≤ 15s）
    const deadline = Date.now() + START_TIMEOUT_MS;
    let ready = false;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, START_POLL_INTERVAL));
      const p = await this.ping();
      if (p.reachable && p.ok && p.ready) {
        ready = true;
        break;
      }
    }

    const pm = this.pm();
    pm.lastStartAt = new Date().toISOString();
    pm.lastCommandKey = `${nodeExe}|${script}`;
    pm.updatedAt = pm.lastStartAt;

    if (ready) {
      // 台账写入前校验 childPid 仍是端口监听者（第九轮 C5）：与引擎路径并发双拉起时，
      // 败者 EADDRINUSE 秒退、胜者（外部桥）的 /ping 也会 ready——原实现无条件把
      // 自己已退出的子进程 PID 盖进 bridgePid，面板显示死 PID、台账被污染
      const holders = await this.findPidsByPort();
      if (!holders || holders.includes(childPid)) {
        pm.bridgePid = childPid;
        pm.treePids = [...this.spawnedPids];
      }
      pm.lastErrorCode = null;
      this.setState("running");
      await this.deps.persist();
      return { ok: true, msg: "桥接已启动" };
    }

    // Step 4: 超时补偿 —— 终止残留进程，避免半启动实例占用端口；端口被占则归类 E2
    await this.killTree(childPid);
    const occupied = await this.findPidsByPort();
    pm.lastErrorCode = "101002";
    pm.updatedAt = new Date().toISOString();
    this.setState("failed");
    await this.deps.persist();
    if (occupied && occupied.length) {
      const msg = `端口 ${this.port()} 被占用（PID ${occupied.join(", ")}）`;
      this.deps.notify("P0", "101002", msg);
      return { ok: false, msg, anomaly: "E2" };
    }
    const msg = "桥接启动超时（15s 未就绪），请检查 Node 与依赖路径" + (this.lastStderr ? `｜stderr：${this.lastStderr}` : "");
    this.deps.notify("P1", "101001", msg);
    return { ok: false, msg, anomaly: "E1" };
  }

  private async stopInner(force: boolean): Promise<ProcResult> {
    if (!force) {
      if (this.busy) return { ok: true, msg: "已有进行中的启停命令，已忽略重复请求" };
      this.busy = true;
    }
    this.setState("stopping");

    const pm = this.pm();
    const candidates = new Set<number>([...this.spawnedPids]);
    if (isNumericPid(String(pm.bridgePid)) && pm.bridgePid > 0) candidates.add(pm.bridgePid);
    const portHolders = await this.findPidsByPort();
    if (portHolders) for (const pid of portHolders) candidates.add(pid);

    // Step 1: 无候选 → 本来就没在运行
    if (!candidates.size) {
      this.clearPids();
      this.setState("stopped");
      await this.deps.persist();
      return { ok: true, msg: "桥接本来就没在运行" };
    }

    // Step 2: 优先优雅退出（问题 11）—— POST /shutdown 让桥接先关 Chromium 上下文再退出，
    // 避免强杀后 profile 目录锁残留导致下次启动失败。轮询等待其退场（2026-09-27 修：原固定等 1.5s
    // 多数来不及，优雅端点形同虚设）；6s 内未退场才走强杀兜底。
    const graceful = await this.requestShutdown();
    let after = { reachable: true };
    if (graceful) {
      const gone = await this.waitGone(STOP_DRAIN_MS);
      if (gone) after = { reachable: false };
    }

    // Step 3: 强杀兜底（整树终止；停止动作重试 0 次，避免误杀他人进程）。
    // 杀前逐一验身份（2026-09-27 第四轮升级为命令行指纹 douyin-bridge.js）：端口上无关的
    // node.exe（dev server 等）不再被连坐误杀；手动 node douyin-bridge.js 拉起的外部桥仍可被
    // 用户显式的「停止桥接」停掉（命令行指纹命中）。
    let killed = 0;
    if (!graceful || after.reachable) {
      for (const pid of candidates) {
        if (!isNumericPid(String(pid))) continue;
        if (!(await this.isBridgeProcess(pid))) continue;
        const out = await this.exec(`taskkill /F /T /PID ${pid}`);
        if (out.trim() !== "") killed++;
      }
      const gone = await this.waitGone(4_000);
      after = { reachable: !gone };
    }

    // Step 4: 复核端口已释放
    pm.lastStopAt = new Date().toISOString();
    pm.updatedAt = pm.lastStopAt;
    if (after.reachable) {
      this.setState("running");
      const msg = `停止失败：端口 ${this.port()} 仍被占用（可能为他人进程，权限不足）`;
      this.deps.notify("P1", "101003", msg);
      return { ok: false, msg };
    }
    this.clearPids();
    this.setState("stopped");
    await this.deps.persist();
    return {
      ok: true,
      msg: `桥接已停止${graceful && !killed ? "（优雅退出）" : killed ? `（终止 ${killed} 个进程）` : ""}`,
    };
  }

  /** 问题 11：请求桥接优雅退出（POST /shutdown，先关浏览器上下文再退出）。 */
  private async requestShutdown(): Promise<boolean> {
    try {
      const r = await requestUrl({
        url: `${this.s.bridgeUrl}/shutdown`,
        method: "POST",
        throw: false,
        timeout: 2500,
      } as RequestUrlParam & { timeout: number });
      return r.status === 200;
    } catch {
      return false;
    }
  }
}
