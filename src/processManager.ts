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
const STOP_VERIFY_MS = 1_500;
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

  /** netstat -ano 找出监听桥接端口的 PID（parsePidsFromNetstat 只取 LISTENING 且端口精确匹配）。 */
  private async findPidsByPort(): Promise<number[]> {
    const out = await this.exec("netstat -ano");
    return parsePidsFromNetstat(out ?? "", this.port());
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

  private clearPids(): void {
    const pm = this.pm();
    pm.bridgePid = -1;
    pm.treePids = [];
    this.spawnedPids = [];
  }

  // ---------- 三个对外命令：异常一律可见化 ----------

  async start(): Promise<ProcResult> {
    try {
      return await this.startInner();
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
      return await this.stopInner();
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

  /** 重启 = 停止 + 启动（核心路径 ≤ 2 步，见 高层架构设计 §6.4 关键交互约束）。 */
  async restart(): Promise<ProcResult> {
    const stopped = await this.stop();
    if (!stopped.ok) return stopped;
    const started = await this.start();
    return { ok: started.ok, msg: started.ok ? "桥接已重启" : `重启失败：${started.msg}` };
  }

  /** onunload 防泄漏：只终止本插件拉起的整树；外部独立拉起的仅解除引用（系统设计 §3.2.M1.5 Step 5）。 */
  async dispose(): Promise<void> {
    const pids = new Set<number>([...this.spawnedPids, ...(this.pm().treePids ?? [])]);
    for (const pid of pids) {
      if (isNumericPid(String(pid)) && pid > 0) await this.killTree(pid);
    }
    this.spawnedPids = [];
    this.clearPids();
    await this.deps.persist();
  }

  // ---------- 内部实现 ----------

  private async startInner(): Promise<ProcResult> {
    if (this.busy) return { ok: true, msg: "已有进行中的启停命令，已忽略重复请求" };
    this.busy = true;
    this.lastStderr = "";
    this.setState("starting");

    // Step 1: 探测 —— 已在运行则幂等短路（可能是外部独立拉起的）
    const probe = await this.ping();
    if (probe.reachable && probe.ok) {
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
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        env,
        cwd: pluginDir || undefined,
      });
      child.unref?.();
      child.stderr?.on("data", (d: unknown) => {
        this.lastStderr = (this.lastStderr + String(d)).slice(-STDERR_TAIL);
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
      pm.bridgePid = childPid;
      pm.treePids = [...this.spawnedPids];
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
    if (occupied.length) {
      const msg = `端口 ${this.port()} 被占用（PID ${occupied.join(", ")}）`;
      this.deps.notify("P0", "101002", msg);
      return { ok: false, msg, anomaly: "E2" };
    }
    const msg = "桥接启动超时（15s 未就绪），请检查 Node 与依赖路径" + (this.lastStderr ? `｜stderr：${this.lastStderr}` : "");
    this.deps.notify("P1", "101001", msg);
    return { ok: false, msg, anomaly: "E1" };
  }

  private async stopInner(): Promise<ProcResult> {
    if (this.busy) return { ok: true, msg: "已有进行中的启停命令，已忽略重复请求" };
    this.busy = true;
    this.setState("stopping");

    const pm = this.pm();
    const candidates = new Set<number>([...this.spawnedPids]);
    if (isNumericPid(String(pm.bridgePid)) && pm.bridgePid > 0) candidates.add(pm.bridgePid);
    for (const pid of await this.findPidsByPort()) candidates.add(pid);

    // Step 1: 无候选 → 本来就没在运行
    if (!candidates.size) {
      this.clearPids();
      this.setState("stopped");
      await this.deps.persist();
      return { ok: true, msg: "桥接本来就没在运行" };
    }

    // Step 2: 优先优雅退出（问题 11）—— POST /shutdown 让桥接先关 Chromium 上下文再退出，
    // 避免强杀后 profile 目录锁残留导致下次启动失败。失败（旧版桥接无此端点/已僵死）再走强杀兜底。
    const graceful = await this.requestShutdown();
    await new Promise((r) => setTimeout(r, STOP_VERIFY_MS));
    let after = await this.ping();

    // Step 3: 强杀兜底（整树终止；停止动作重试 0 次，避免误杀他人进程）
    let killed = 0;
    if (after.reachable || !graceful) {
      for (const pid of candidates) {
        if (!isNumericPid(String(pid))) continue;
        const out = await this.exec(`taskkill /F /T /PID ${pid}`);
        if (out.trim() !== "") killed++;
      }
      await new Promise((r) => setTimeout(r, STOP_VERIFY_MS));
      after = await this.ping();
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
