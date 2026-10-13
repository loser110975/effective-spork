// videoMedia.ts — 视频类收藏的素材拉取（ffmpeg 编排）。
// 单条 ffmpeg 命令、一次网络拉取、双输出：转录用音频（mono 16kHz mp3）+ 关键帧图片。
// 主路径：ffmpeg 直接读远程直链（带 UA/Referer）；回退：requestUrl 下载字节（403 时经桥接
// 刷新播放地址）→ 本地文件再跑同一命令。帧图入库 vault，音频留 OS 临时目录供上传。
import { requestUrl, Vault, normalizePath, TFile, TFolder } from "obsidian";
import * as path from "path";
import { DouyinClient, downloadVideoBytes } from "./douyinClient";
import type { DouyinSyncSettings } from "./types/settings";
import { ensureFolder } from "./media";
import { nodeRequireFn, DOUYIN_UA } from "./util";

const BROWSER_UA = DOUYIN_UA;
const FFMPEG_TIMEOUT_MS = 8 * 60 * 1000; // 单次 ffmpeg 执行上限
const MAX_VIDEO_SEC = 600; // 只处理前 10 分钟（抖音视频极少超过；同时控住 SenseVoice 上传体积）
// 200MB 上限 / 1KB 下限判定已随 P2-3 合并至 douyinClient.downloadVideoBytes（DOWNLOAD_VIDEO_* 常量）
const MAX_FRAMES = 100; // 关键帧硬上限（按抽帧间隔自然达成的封顶）
const MIN_FRAMES = 4; // 短视频保底帧数：帧是多模态模型的画面上下文，太稀会看不全全程
const MIN_AUDIO_BYTES = 1024; // 小于此值的 audio.mp3 视为无效（0 字节 / ffmpeg 空壳产物）

/**
 * ffmpeg 因「视频流映射失败」而失败的特征串（2026-09-21 实测）。
 * aweme_type=163 类条目不含视频轨时，`-map 0:v:0` 会命中这里；此时重下视频字节毫无意义。
 * 2026-09-27 收窄：去掉 `Output file #N does not contain any stream`（音频输出路缺流时也报这句，
 * 有画面的无音轨视频会被误判成无视频轨而丢帧）；原 `Stream map ''` 为死模式（真实报错带映射描述符）。
 */
const NO_VIDEO_TRACK_RE = /Failed to set value '0:v:0'|Stream map '0:v:0' matches no streams/i;
/** 音频输出路零流（输入无音轨，`-map 0:a:0?` 可选匹配为空）——帧路仍可抢救，见 pullAssetsInner。 */
const NO_AUDIO_STREAM_RE = /Output file #\d+ does not contain any stream/i;

/** 素材拉取失败的大类，供调用方区分「确定性结构问题」与「瞬时网络问题」（决定是否重试）。 */
export type MediaErrorKind = "none" | "no_video_track" | "no_media" | "no_audio" | "network" | "ffmpeg";

/** 确定性失败（无视频轨 / 无有效产物 / 无音轨）：重试必然复现同一结果，不应进重试队列。 */
export function isDeterministicMediaError(kind: MediaErrorKind): boolean {
  return kind === "no_video_track" || kind === "no_media" || kind === "no_audio";
}

export interface VideoAssets {
  /** 本地音频绝对路径（临时目录）；空串 = 未产出音轨 */
  audioPath: string;
  /** 关键帧的 vault 相对路径（按时间顺序） */
  framePaths: string[];
}

/** 按需拉取：false 的那一路不产出也不参与成败判定（省一半 ffmpeg 编码耗时）。 */
export interface PullAssetsOpts {
  wantAudio?: boolean;
  wantFrames?: boolean;
}

/** 结构化结果：失败原因随返回值走，不再用共享实例字段（条目级并发下会串号污染重试分类）。 */
export interface PullAssetsResult {
  assets: VideoAssets | null;
  /** assets 为 null 时的失败原因 */
  error: string;
  /** 失败大类（assets 为 null 时非 none） */
  errorKind: MediaErrorKind;
}

export interface VideoAssetSource {
  id: string;
  playUrl: string;
  durationSec?: number;
}

// 问题 3：统一走 util.nodeRequireFn，不再各自 (window as any).require
const nodeRequire: () => any | null = nodeRequireFn;

/** 读文件字节数；不存在或读取失败返回 0（0 = 无效产物，用于替代 fs.existsSync 的误判）。 */
function statSize(fs: any, p: string): number {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

export class VideoMediaStore {
  /** 按 id 缓存成功/失败结果（避免同一视频重复下载）；cleanup 后移除 */
  private cache = new Map<string, PullAssetsResult>();
  /** 进行中的拉取 Promise：并发调用方等同一个 promise，而不是把「进行中」误读成「失败」 */
  private inflight = new Map<string, Promise<PullAssetsResult>>();
  /** ffmpeg 探测结果按可执行路径缓存（性能治理 P1）：避免每条视频都 spawn 一次 ffmpeg -version。 */
  private ffmpegProbes = new Map<string, Promise<string | null>>();

  constructor(
    private vault: Vault,
    private mediaRoot: string,
    private settings: DouyinSyncSettings,
    private client?: DouyinClient | null,
  ) {}

  /** refreshClients 重建 DouyinClient 后同步引用（downloadVideo 的播放地址刷新回退用）。 */
  updateClient(client: DouyinClient): void {
    this.client = client;
  }

  private cp(): any | null {
    const r = nodeRequire();
    try {
      return r ? r("child_process") : null;
    } catch {
      return null;
    }
  }

  private ffmpegBin(): string {
    return (this.settings.ffmpegPath || "ffmpeg").trim() || "ffmpeg";
  }

  /**
   * 检测 ffmpeg 可用性：返回版本首行；null = 不可用。
   * 成功结果按可执行路径永久缓存；失败（null）只缓存 60s——AV 首次拦截 spawn / 瞬时抖动
   * 不该把「未检测到 ffmpeg」钉死整个会话（2026-09-27 修）；force=true 绕过缓存（设置页「检测」按钮）。
   */
  checkFfmpeg(force = false): Promise<string | null> {
    const bin = this.ffmpegBin();
    if (!force) {
      const hit = this.ffmpegProbes.get(bin);
      if (hit) return hit;
    }
    const probe = this.probeFfmpeg(bin).then((v) => {
      if (!v) {
        // 失败结果短 TTL：60s 后允许重新探测（届时 probe 已入 Map，闭包捕获安全）
        setTimeout(() => {
          if (this.ffmpegProbes.get(bin) === probe) this.ffmpegProbes.delete(bin);
        }, 60_000);
      }
      return v;
    });
    this.ffmpegProbes.set(bin, probe);
    return probe;
  }

  private probeFfmpeg(bin: string): Promise<string | null> {
    const cp = this.cp();
    if (!cp) return Promise.resolve(null);
    return new Promise((resolve) => {
      let settled = false;
      let out = "";
      let child: any = null;
      const done = (v: string | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(v);
      };
      const timer = setTimeout(() => {
        try {
          child?.kill();
        } catch {
          /* 忽略 */
        }
        done(null);
      }, 15000);
      try {
        child = cp.spawn(bin, ["-version"], { windowsHide: true });
      } catch {
        done(null);
        return;
      }
      child.stdout?.on("data", (d: any) => {
        out += String(d);
      });
      child.on("error", () => done(null));
      child.on("close", (code: number) => done(code === 0 && out.trim() ? out.split(/\r?\n/)[0].trim() : null));
    });
  }

  /** 取转录用音频（缓存命中直接返回；未缓存时按需只拉音频一路，不白付抽帧编码成本）。 */
  async getAudio(id: string, url: string, durationSec = 0): Promise<string | null> {
    const res = await this.pullAssets({ id, playUrl: url, durationSec }, { wantAudio: true, wantFrames: false });
    return res.assets?.audioPath || null;
  }

  /**
   * 缓存结果是否满足本次请求（2026-09-27 修）：
   * ① 成功结果「按需裁剪」后可能只有一路（如 getAudio 只拉了音频）——调用方要的另一路缺席时视为未命中，
   *    否则 ASR 重试成功路径会命中仅音频缓存而永久丢帧（复审 P1）；
   * ② 失败结果：确定性失败复用（重试必然复现），可重试类（network/ffmpeg）不缓存、允许重拉。
   */
  private cachedSatisfies(cached: PullAssetsResult, opts?: PullAssetsOpts): boolean {
    if (cached.assets === null) return isDeterministicMediaError(cached.errorKind);
    const wantAudio = opts?.wantAudio !== false;
    const wantFrames = opts?.wantFrames !== false;
    const hasAudio = cached.assets.audioPath !== "";
    const hasFrames = cached.assets.framePaths.length > 0;
    return (!wantAudio || hasAudio) && (!wantFrames || hasFrames);
  }

  /** 拉取视频素材（音频 + 关键帧，可按需裁剪）。失败时 assets=null，原因在 result.error / errorKind。 */
  async pullAssets(item: VideoAssetSource, opts?: PullAssetsOpts): Promise<PullAssetsResult> {
    const cached = this.cache.get(item.id);
    if (cached && this.cachedSatisfies(cached, opts)) return cached;
    const running = this.inflight.get(item.id);
    if (running) {
      // 在飞结果未必满足本次需求（先 wantAudio 后双路的调用序列）：等它结束后按缓存同款
      // 判定复查，不满足走常规重拉（2026-09-27 第四轮）。不能在在飞时并发再拉——同 id 共用
      // 同一临时目录，两条 ffmpeg 会互踩产物。
      const r = await running;
      if (this.cachedSatisfies(r, opts)) return r;
      return this.pullAssets(item, opts);
    }
    const p = this.pullAssetsInner(item, opts)
      .catch((e: any): PullAssetsResult => {
        // 非预期异常归一为失败结果（回归审查 #5）：否则 inflight 表项残留 rejected promise，
        // 该视频在本会话内每次同步/补跑/重试都拿到同一个异常
        return { assets: null, errorKind: "network", error: `素材拉取异常：${String(e?.message ?? e).slice(0, 150)}` };
      })
      .then((res) => {
        // 失败结果只缓存确定性类（复审 P2）：network/ffmpeg 类毒化缓存会让重试队列对本条目空转
        if (res.assets || isDeterministicMediaError(res.errorKind)) {
          this.cache.set(item.id, res);
        }
        this.inflight.delete(item.id);
        return res;
      });
    this.inflight.set(item.id, p);
    return p;
  }

  /** 清理临时音频与缓存（帧图已入库 vault，不受影响）；ASR 结束后调用。 */
  cleanup(id: string): void {
    this.cache.delete(id);
    if (!id) return; // 空 id 会拼出临时根目录本身，rmSync 会清掉所有在途条目的音频（防御）
    try {
      const r = nodeRequire();
      if (!r) return;
      const fs = r("fs");
      const os = r("os");
      fs.rmSync(path.join(os.tmpdir(), "douyin-sync", id), { recursive: true, force: true });
    } catch {
      /* 清理失败不影响主流程 */
    }
  }

  // ---------- 内部实现 ----------

  /**
   * 会话级临时根目录清理标记（2026-09-27 第四轮）：上次会话崩溃/强杀会残留 frame_*.jpg、
   * audio.mp3 乃至 200MB 的 source.mp4——下次对同一条目 pullAssets 时 listLocalFrames 数到
   * 残留帧会把「拉取失败」伪装成「成功」，入库过期画面。每个插件会话首次建临时目录前，
   * 把整个 douyin-sync 临时根清掉一次。不能每次 pull 都清：同条目「先音频后帧」的二次拉取
   * 会删掉待上传的音频。Windows 下句柄占用导致 rmSync 失败时静默忽略（与现状一致）。
   */
  private static tmpRootCleared = false;

  private tmpDir(id: string): string | null {
    try {
      const r = nodeRequire();
      if (!r) return null;
      const fs = r("fs");
      const os = r("os");
      const root = path.join(os.tmpdir(), "douyin-sync");
      this.clearTempRoot();
      if (!id) return null; // 空 id 会拼出根目录本身，多条目互删产物（防御）
      const dir = path.join(root, id);
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    } catch {
      return null;
    }
  }

  /**
   * 会话级临时根目录清理（P3-2：触发点从「首次素材拉取」提前到插件 onload）。
   * 原懒策略下，用户只同步图文 / 长期不再拉视频素材时，崩溃残留会永久滞留 tmpdir
   * （实测 14 天前的 14MB 残留）。幂等（tmpRootCleared 门控），tmpDir 保留兜底调用。
   */
  clearTempRoot(): void {
    if (VideoMediaStore.tmpRootCleared) return;
    VideoMediaStore.tmpRootCleared = true;
    try {
      const r = nodeRequire();
      if (!r) return;
      const root = path.join(r("os").tmpdir(), "douyin-sync");
      r("fs").rmSync(root, { recursive: true, force: true });
    } catch {
      /* 残留清理失败不影响主流程 */
    }
  }

  private runFfmpeg(args: string[], timeoutMs: number): Promise<{ code: number | null; stderr: string }> {
    return new Promise((resolve) => {
      const cp = this.cp();
      if (!cp) {
        resolve({ code: -1, stderr: "无法访问 child_process（Node 模块不可用）" });
        return;
      }
      let settled = false;
      let stderr = "";
      let child: any = null;
      const done = (code: number | null, err: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code, stderr: err });
      };
      const timer = setTimeout(() => {
        // 超时：先礼貌 kill，5s 后仍不退则强制 settle——否则僵死进程会让 Promise 永不落定，占死并发槽
        try {
          child?.kill();
        } catch {
          /* 忽略 */
        }
        setTimeout(() => {
          try {
            child?.kill("SIGKILL");
          } catch {
            /* 忽略 */
          }
          done(-1, (stderr || "") + "\nffmpeg 超时被强制终止");
        }, 5000);
      }, timeoutMs);
      try {
        child = cp.spawn(this.ffmpegBin(), args, { windowsHide: true });
      } catch (e: any) {
        done(-1, String(e?.message ?? e));
        return;
      }
      child.stderr?.on("data", (d: any) => {
        stderr += String(d);
        if (stderr.length > 8000) stderr = stderr.slice(-4000); // 保留尾部（错误在最后）
      });
      child.on("error", (e: Error) => done(-1, String(e)));
      child.on("close", (code: number | null) => done(code, stderr));
    });
  }

  private buildFfmpegArgs(
    input: string,
    remote: boolean,
    dir: string,
    fps: string,
    maxFrames: number,
    want: { audio: boolean; frames: boolean },
  ): string[] {
    const audioPath = path.join(dir, "audio.mp3");
    const framePattern = path.join(dir, "frame_%02d.jpg");
    const netArgs = remote
      ? [
          "-user_agent",
          BROWSER_UA,
          "-headers",
          "Referer: https://www.douyin.com/\r\nOrigin: https://www.douyin.com\r\n",
          "-rw_timeout",
          "60000000", // 微秒：网络读写 60s 超时
          "-reconnect",
          "1",
          "-reconnect_streamed",
          "1",
        ]
      : [];
    // 按需裁剪输出路数（P1-13）：只要开一头时，另一头的编码成本不必照付
    // —— ffmpeg 的耗时主要耗在两路编码上，关摘要时白编 100 张 JPEG、走百炼 URL 直传时白编 mp3。
    const audioOut = want.audio
      ? [
          // 输出 1：转录用音频（对齐 .ref 参考实现的 16kHz mono 参数）
          "-map",
          "0:a:0?",
          "-vn",
          "-ac",
          "1",
          "-ar",
          "16000",
          "-b:a",
          "64k",
          audioPath,
        ]
      : [];
    const frameOut = want.frames
      ? [
          // 输出 2：关键帧（按时长均匀采样，限宽 720 防请求体过大）
          "-map",
          "0:v:0",
          "-an",
          "-vf",
          // 单引号包裹 min(720,iw)：无 shell spawn 下 \, 转义会被 filtergraph 解析器吃掉导致过滤器被拆分
          `fps=${fps},scale='min(720,iw)':-2`,
          "-frames:v",
          String(maxFrames),
          "-q:v",
          "3",
          framePattern,
        ]
      : [];
    return ["-nostdin", "-y", ...netArgs, "-i", input, "-t", String(MAX_VIDEO_SEC), ...audioOut, ...frameOut];
  }

  private async pullAssetsInner(item: VideoAssetSource, opts?: PullAssetsOpts): Promise<PullAssetsResult> {
    const wantAudio = opts?.wantAudio !== false;
    const wantFrames = opts?.wantFrames !== false;
    const fail = (kind: MediaErrorKind, error: string): PullAssetsResult => ({ assets: null, errorKind: kind, error });
    // 失败路径不再泄漏临时目录（含回退路径最大 200MB 的 source.mp4）：整个函数体包在 try/finally 里
    let dir: string | null = null;
    try {
      if (!item.playUrl) return fail("no_media", "无播放地址");
      const version = await this.checkFfmpeg();
      if (!version) {
        return fail(
          "ffmpeg",
          `未检测到 ffmpeg（当前路径：${this.ffmpegBin()}）。请安装：winget install "FFmpeg (Gyan.FFmpeg)"，或在设置中指定完整路径`,
        );
      }
      dir = this.tmpDir(item.id);
      if (!dir) return fail("ffmpeg", "无法创建临时目录（Node 模块不可用）");
      const r = nodeRequire()!;
      const fs = r("fs");

      // 按时间间隔均匀抽帧（帧是多模态模型的画面上下文，与转录互补）；
      // 短视频保底：10s 间隔下 23s 视频只有 2~3 帧，按时长把帧率提到至少 MIN_FRAMES 帧覆盖全片
      const interval = Math.max(1, Math.min(60, this.settings.keyframeIntervalSec || 10));
      let rate = 1 / interval;
      const dur = item.durationSec && item.durationSec > 0 ? Math.min(item.durationSec, MAX_VIDEO_SEC) : 0;
      if (dur > 0) rate = Math.max(rate, MIN_FRAMES / dur);
      const fps = rate.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
      const want = { audio: wantAudio, frames: wantFrames };

      // 主路径：ffmpeg 直接拉远程直链（一次下载、按需双输出）
      let input = item.playUrl;
      let remoteInput = true;
      let res = await this.runFfmpeg(this.buildFfmpegArgs(input, remoteInput, dir, fps, MAX_FRAMES, want), FFMPEG_TIMEOUT_MS);
      let frames = wantFrames ? this.listLocalFrames(dir, fs) : [];
      const audioPath = path.join(dir, "audio.mp3");
      let audioSize = wantAudio ? statSize(fs, audioPath) : 0;
      // 「目标流不存在」= 条目本身不含视频轨（如 aweme_type=163），重下字节也会以同样方式失败
      // （只在确有关键帧需求时才可能出现：wantFrames=false 时 args 里没有 0:v:0 这路）
      const noVideoTrack = NO_VIDEO_TRACK_RE.test(res.stderr || "");
      if (noVideoTrack) {
        return fail("no_video_track", `条目不含视频轨：${(res.stderr || "").trim().slice(-160)}`);
      }
      // 仅拉音频且输入无音轨（2026-09-27 第四轮）：音频输出路零流是确定性结果，
      // 走「下载全片重跑」必然复现同一失败，只会白付一次 200MB 下载
      if (res.code !== 0 && wantAudio && !wantFrames && NO_AUDIO_STREAM_RE.test(res.stderr || "")) {
        return fail("no_audio", "条目不含音轨：音频输出路零流");
      }
      // 无音轨视频抢救（复审 P2）：输入有视频轨但无音轨时，音频输出路零流导致整条命令失败，
      // 帧路也被连坐。识别「Output file #N does not contain any stream」（音频路缺失的形态——
      // 视频路缺失报的是 Stream map '0:v:0'，已被上面拦截）后按仅帧配置重跑一次，帧不再丢。
      if (
        res.code !== 0 &&
        want.audio &&
        want.frames &&
        frames.length === 0 &&
        audioSize < MIN_AUDIO_BYTES &&
        NO_AUDIO_STREAM_RE.test(res.stderr || "")
      ) {
        res = await this.runFfmpeg(
          this.buildFfmpegArgs(input, remoteInput, dir, fps, MAX_FRAMES, { audio: false, frames: true }),
          FFMPEG_TIMEOUT_MS,
        );
        frames = this.listLocalFrames(dir, fs);
        if (NO_VIDEO_TRACK_RE.test(res.stderr || "")) {
          return fail("no_video_track", `条目不含视频轨：${(res.stderr || "").trim().slice(-160)}`);
        }
      }
      // P0（2026-09-21）：回退条件曾用 !fs.existsSync(audio.mp3)，而 ffmpeg 的 -y 会先建出输出文件，
      // 失败时留下 0 字节 audio.mp3 → existsSync 恒为 true → 「下载字节再本地重跑」的兜底永不触发。
      // 改为按**文件大小**判断；且只在「需要的输出全部缺席」时才值得回退（下载全片重跑很贵）。
      const allWantedMissing = (!wantAudio || audioSize < MIN_AUDIO_BYTES) && (!wantFrames || frames.length === 0);
      if (res.code !== 0 && allWantedMissing) {
        // 回退：requestUrl 下载字节（播放地址过期 403 时经桥接刷新）→ 本地文件再跑
        try {
          const buf = await this.downloadVideo(item.playUrl, item.id);
          const local = path.join(dir, "source.mp4");
          fs.writeFileSync(local, Buffer.from(buf));
          input = local;
          remoteInput = false;
          res = await this.runFfmpeg(this.buildFfmpegArgs(input, remoteInput, dir, fps, MAX_FRAMES, want), FFMPEG_TIMEOUT_MS);
          frames = wantFrames ? this.listLocalFrames(dir, fs) : [];
          audioSize = wantAudio ? statSize(fs, audioPath) : 0;
          if (NO_VIDEO_TRACK_RE.test(res.stderr || "")) {
            return fail("no_video_track", "条目不含视频轨（本地重跑仍无视频流）");
          }
        } catch (e: any) {
          return fail("network", `视频拉取失败：${String(e?.message ?? e).slice(0, 150)}`);
        }
      }
      // P0（2026-09-21）：audioOk 曾用 fs.existsSync —— 存在性 ≠ 有效性。0 字节空壳被当成有效音频
      // 上传给远端 ASR，服务端对不可解码输入固定返回 500 空 body，错误被误归因到转写服务商。
      // 按需判定：不要的那一路不参与成败；单路失败单路成功时保持旧语义——部分成功（kind 记录残缺侧）。
      const audioOk = !wantAudio || audioSize >= MIN_AUDIO_BYTES;
      const framesOk = !wantFrames || frames.length > 0;
      if (!audioOk && !framesOk) {
        return fail(
          "no_media",
          `ffmpeg 未产出${wantAudio && wantFrames ? "关键帧与有效音轨" : "所需产物"}（音轨 ${audioSize}B，低于 ${MIN_AUDIO_BYTES}B 视为空）：${(res.stderr || "未知原因").trim().slice(-200)}`,
        );
      }
      // 退出码参与成功判定（2026-09-27 第四轮）：超时 kill / 中途崩溃后会留下「部分产物」——
      // 渐进写出的截断 mp3（>1KB 即过 MIN_AUDIO_BYTES）可正常解码，ASR 只转出前半段且无任何标记；
      // 写了一半的截断 JPEG 入库后可能拖垮整个多模态摘要请求。两侧产物都在而退出码非 0 =
      // 产物完整性不可信，按可重试的 ffmpeg 失败处理（超时等结构性场景由重试台账兜底）。
      if (res.code !== 0 && audioOk && framesOk) {
        return fail(
          "ffmpeg",
          `ffmpeg 退出码 ${res.code}（产物可能不完整）：${(res.stderr || "未知原因").trim().slice(-160)}`,
        );
      }
      const framePaths = wantFrames && framesOk ? await this.ingestFrames(item.id, dir, fs) : [];
      // 音频无效但帧有 → 部分成功：转写侧会拿到空 audioPath（确定性失败，不入重试队列），帧照常供摘要。
      // 此分支临时目录可立即删（音频已判定无效、帧已入库）。
      if (!audioOk) return { assets: { audioPath: "", framePaths }, errorKind: "no_audio", error: "未产出有效音轨" };
      // 完整成功且音频还要给 ASR 上传用 → 不能在这里删临时目录，交给 cleanup(id) 在 ASR 结束后清
      if (wantAudio) dir = null;
      return { assets: { audioPath, framePaths }, errorKind: "none", error: "" };
    } finally {
      if (dir) {
        try {
          const rr = nodeRequire();
          if (rr) {
            rr("fs").rmSync(dir, { recursive: true, force: true });
          }
        } catch {
          /* 清理失败不影响主流程 */
        }
      }
    }
  }

  private listLocalFrames(dir: string, fs: any): string[] {
    try {
      // 按帧序号数值排序（2026-09-27 第四轮）：`frame_%02d.jpg` 达到 100 帧时会产出 frame_100.jpg，
      // 字典序把它排在 frame_10 与 frame_11 之间——时间上最后一帧（结尾画面）被当成第 11 帧送进模型
      return fs
        .readdirSync(dir)
        .filter((f: string) => /^frame_\d+\.jpg$/i.test(f))
        .sort((a: string, b: string) => {
          const na = Number(a.match(/\d+/)?.[0] ?? 0);
          const nb = Number(b.match(/\d+/)?.[0] ?? 0);
          return na - nb;
        });
    } catch {
      return [];
    }
  }

  /**
   * 帧图复制入库 vault：Media/frames/<id>/frame_NN.jpg（幂等）；并清掉本次未产出的旧帧文件（重抽后网格变化）。
   * 性能治理 P1：改用帧目录的 TFolder.children 做差集，替代原 `vault.getFiles()` 全库扫描
   * —— vault 内已有 8.4k 关键帧 + 1.7k 图片 + 680 篇笔记，每条视频全扫一遍纯属浪费。
   */
  private async ingestFrames(id: string, dir: string, fs: any): Promise<string[]> {
    const out: string[] = [];
    const base = normalizePath(`${this.mediaRoot}/frames/${id}`);
    try {
      await ensureFolder(this.vault, base);
      const local = this.listLocalFrames(dir, fs);
      const localSet = new Set(local);
      // 既有帧集合：只读本目录 children（O(本目录文件数)），不再遍历全库
      const existing = new Set<string>();
      const dirEntry = this.vault.getAbstractFileByPath(base);
      if (dirEntry instanceof TFolder) {
        for (const c of dirEntry.children) {
          if (c instanceof TFile && /^frame_\d+\.jpg$/i.test(c.name)) existing.add(c.name);
        }
      }
      for (const f of local) {
        const vp = `${base}/${f}`;
        try {
          const buf = fs.readFileSync(path.join(dir, f));
          const bytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
          const tf = this.vault.getAbstractFileByPath(vp);
          if (tf instanceof TFile) {
            // 同名但内容已变（改抽帧间隔后重抽，新间隔的 frame_01 与旧的不是同一画面）：
            // 原实现同名跳过保留旧字节，同一网格混排两种时间基准。按大小判定变化后覆盖写。
            // 走 vault.modifyBinary（第九轮 B4）：adapter 直写绕过 Vault 封装，内存中的
            // TFile.stat.size 不更新，下轮变化判定会基于陈旧值误判
            if (tf.stat.size !== buf.byteLength) {
              await this.vault.modifyBinary(tf, bytes);
            }
          } else {
            await this.vault.createBinary(vp, bytes);
          }
          out.push(vp);
        } catch {
          /* 单帧入库失败（IO 异常）不阻断其余帧；不入 out——vault 中无此文件，
             帧列表与摘要提示词口径一致（原实现失败帧也 push，声称的帧并不存在） */
        }
      }
      // 旧网格清理：本目录中不在本次产物里的 frame_*.jpg 一并删除（例如间隔调大后帧数变少）
      for (const f of existing) {
        if (!localSet.has(f)) {
          await this.vault.adapter.remove(normalizePath(`${base}/${f}`));
        }
      }
    } catch {
      /* 入库失败按已有结果返回 */
    }
    return out;
  }

  /** 本地下载视频字节；URL 失效（403 签名过期）时经桥接刷新播放地址重试一次（P2-3：共享实现见 douyinClient.downloadVideoBytes）。 */
  private async downloadVideo(url: string, videoId: string): Promise<ArrayBuffer> {
    return downloadVideoBytes(url, { client: this.client, videoId, errorStyle: "media" });
  }
}
