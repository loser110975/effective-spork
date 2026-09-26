// videoMedia.ts — 视频类收藏的素材拉取（ffmpeg 编排）。
// 单条 ffmpeg 命令、一次网络拉取、双输出：转录用音频（mono 16kHz mp3）+ 关键帧图片。
// 主路径：ffmpeg 直接读远程直链（带 UA/Referer）；回退：requestUrl 下载字节（403 时经桥接
// 刷新播放地址）→ 本地文件再跑同一命令。帧图入库 vault，音频留 OS 临时目录供上传。
import { requestUrl, Vault, normalizePath, TFile, TFolder } from "obsidian";
import * as path from "path";
import { DouyinClient } from "./douyinClient";
import { DouyinSyncSettings } from "./types";
import { ensureFolder } from "./media";
import { nodeRequireFn } from "./util";

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const FFMPEG_TIMEOUT_MS = 8 * 60 * 1000; // 单次 ffmpeg 执行上限
const MAX_VIDEO_SEC = 600; // 只处理前 10 分钟（抖音视频极少超过；同时控住 SenseVoice 上传体积）
const MAX_VIDEO_BYTES = 200 * 1024 * 1024;
const MAX_FRAMES = 100; // 关键帧硬上限（按抽帧间隔自然达成的封顶）
const MIN_FRAMES = 4; // 短视频保底帧数：帧是多模态模型的画面上下文，太稀会看不全全程
const MIN_AUDIO_BYTES = 1024; // 小于此值的 audio.mp3 视为无效（0 字节 / ffmpeg 空壳产物）

/**
 * ffmpeg 因「目标流不存在」而失败的特征串（2026-09-21 实测）。
 * aweme_type=163 类条目不含视频轨时，`-map 0:v:0` 会命中这里；此时重下视频字节毫无意义。
 */
const NO_VIDEO_TRACK_RE =
  /Failed to set value '0:v:0'|Stream map '' matches no streams|Output file #\d+ does not contain any stream/i;

export interface VideoAssets {
  /** 本地音频绝对路径（临时目录）；空串 = 未产出音轨 */
  audioPath: string;
  /** 关键帧的 vault 相对路径（按时间顺序） */
  framePaths: string[];
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

/** 素材拉取失败的大类，供调用方区分「确定性结构问题」与「瞬时网络问题」（决定是否重试）。 */
export type MediaErrorKind = "none" | "no_video_track" | "no_media" | "no_audio" | "network" | "ffmpeg";

export class VideoMediaStore {
  /** 按 id 缓存（含 null=拉取失败），避免同一视频重复下载；cleanup 后移除 */
  private cache = new Map<string, VideoAssets | null>();
  /** 最近一次拉取失败的原因（供调用方写进同步摘要） */
  lastError = "";
  /** 最近一次拉取失败的类别（no_video_track / no_media 属确定性失败，不应重试） */
  lastErrorKind: MediaErrorKind = "none";

  /** 最近一次素材拉取是否属「确定性结构问题」（无视频轨 / 未产出有效音轨 / 无播放地址）→ 重试无用。 */
  get lastFailureDeterministic(): boolean {
    return this.lastErrorKind === "no_video_track" || this.lastErrorKind === "no_media" || this.lastErrorKind === "no_audio";
  }
  /** ffmpeg 探测结果按可执行路径缓存（性能治理 P1）：避免每条视频都 spawn 一次 ffmpeg -version。 */
  private ffmpegProbes = new Map<string, Promise<string | null>>();

  constructor(
    private vault: Vault,
    private mediaRoot: string,
    private settings: DouyinSyncSettings,
    private client?: DouyinClient | null,
  ) {}

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
   * 结果按可执行路径缓存（含 null），同一路径只探测一次；force=true 绕过缓存（设置页「检测」按钮）。
   */
  checkFfmpeg(force = false): Promise<string | null> {
    const bin = this.ffmpegBin();
    if (!force) {
      const hit = this.ffmpegProbes.get(bin);
      if (hit) return hit;
    }
    const p = this.probeFfmpeg(bin);
    this.ffmpegProbes.set(bin, p);
    return p;
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

  /** 取转录用音频（缓存命中直接返回；未缓存时按需拉取素材）。 */
  async getAudio(id: string, url: string, durationSec = 0): Promise<string | null> {
    const assets = await this.pullAssets({ id, playUrl: url, durationSec });
    return assets?.audioPath || null;
  }

  /** 拉取视频素材（音频 + 关键帧）。失败返回 null，原因写入 lastError。 */
  async pullAssets(item: VideoAssetSource): Promise<VideoAssets | null> {
    const cached = this.cache.get(item.id);
    if (cached !== undefined) return cached;
    this.cache.set(item.id, null); // 占位防并发重复拉取
    const assets = await this.pullAssetsInner(item);
    this.cache.set(item.id, assets);
    return assets;
  }

  /** 清理临时音频与缓存（帧图已入库 vault，不受影响）；ASR 结束后调用。 */
  cleanup(id: string): void {
    this.cache.delete(id);
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

  private tmpDir(id: string): string | null {
    try {
      const r = nodeRequire();
      if (!r) return null;
      const fs = r("fs");
      const os = r("os");
      const dir = path.join(os.tmpdir(), "douyin-sync", id);
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    } catch {
      return null;
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
        try {
          child?.kill();
        } catch {
          /* 忽略 */
        }
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

  private buildFfmpegArgs(input: string, remote: boolean, dir: string, fps: string, maxFrames: number): string[] {
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
    return [
      "-nostdin",
      "-y",
      ...netArgs,
      "-i",
      input,
      "-t",
      String(MAX_VIDEO_SEC),
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
    ];
  }

  private async pullAssetsInner(item: VideoAssetSource): Promise<VideoAssets | null> {
    this.lastError = "";
    this.lastErrorKind = "none";
    if (!item.playUrl) {
      this.lastErrorKind = "no_media";
      this.lastError = "无播放地址";
      return null;
    }
    const version = await this.checkFfmpeg();
    if (!version) {
      this.lastErrorKind = "ffmpeg";
      this.lastError = `未检测到 ffmpeg（当前路径：${this.ffmpegBin()}）。请安装：winget install "FFmpeg (Gyan.FFmpeg)"，或在设置中指定完整路径`;
      return null;
    }
    const dir = this.tmpDir(item.id);
    if (!dir) {
      this.lastErrorKind = "ffmpeg";
      this.lastError = "无法创建临时目录（Node 模块不可用）";
      return null;
    }
    const r = nodeRequire()!;
    const fs = r("fs");

    // 按时间间隔均匀抽帧（帧是多模态模型的画面上下文，与转录互补）；
    // 短视频保底：10s 间隔下 23s 视频只有 2~3 帧，按时长把帧率提到至少 MIN_FRAMES 帧覆盖全片
    const interval = Math.max(1, Math.min(60, this.settings.keyframeIntervalSec || 10));
    let rate = 1 / interval;
    const dur = item.durationSec && item.durationSec > 0 ? Math.min(item.durationSec, MAX_VIDEO_SEC) : 0;
    if (dur > 0) rate = Math.max(rate, MIN_FRAMES / dur);
    const fps = rate.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");

    // 主路径：ffmpeg 直接拉远程直链（一次下载双输出）
    let res = await this.runFfmpeg(this.buildFfmpegArgs(item.playUrl, true, dir, fps, MAX_FRAMES), FFMPEG_TIMEOUT_MS);
    let frames = this.listLocalFrames(dir, fs);
    const audioPath = path.join(dir, "audio.mp3");
    let audioSize = statSize(fs, audioPath);
    // 「目标流不存在」= 条目本身不含视频轨（如 aweme_type=163），重下字节也会以同样方式失败
    const noVideoTrack = NO_VIDEO_TRACK_RE.test(res.stderr || "");
    if (noVideoTrack) {
      this.lastErrorKind = "no_video_track";
      this.lastError = `条目不含视频轨：${(res.stderr || "").trim().slice(-160)}`;
      return null;
    }
    // P0（2026-09-21）：回退条件曾用 !fs.existsSync(audio.mp3)，而 ffmpeg 的 -y 会先建出输出文件，
    // 失败时留下 0 字节 audio.mp3 → existsSync 恒为 true → 「下载字节再本地重跑」的兜底永不触发。
    // 改为按**文件大小**判断，才能真正识别「音频没产出」。
    if (res.code !== 0 && frames.length === 0 && audioSize < MIN_AUDIO_BYTES) {
      // 回退：requestUrl 下载字节（播放地址过期 403 时经桥接刷新）→ 本地文件再跑
      try {
        const buf = await this.downloadVideo(item.playUrl, item.id);
        const local = path.join(dir, "source.mp4");
        fs.writeFileSync(local, Buffer.from(buf));
        res = await this.runFfmpeg(this.buildFfmpegArgs(local, false, dir, fps, MAX_FRAMES), FFMPEG_TIMEOUT_MS);
        frames = this.listLocalFrames(dir, fs);
        audioSize = statSize(fs, audioPath);
        if (NO_VIDEO_TRACK_RE.test(res.stderr || "")) {
          this.lastErrorKind = "no_video_track";
          this.lastError = "条目不含视频轨（本地重跑仍无视频流）";
          return null;
        }
      } catch (e: any) {
        this.lastErrorKind = "network";
        this.lastError = `视频拉取失败：${String(e?.message ?? e).slice(0, 150)}`;
        return null;
      }
    }
    // P0（2026-09-21）：audioOk 曾用 fs.existsSync —— 存在性 ≠ 有效性。0 字节空壳被当成有效音频
    // 上传给远端 ASR，服务端对不可解码输入固定返回 500 空 body，错误被误归因到转写服务商。
    const audioOk = audioSize >= MIN_AUDIO_BYTES;
    if (frames.length === 0 && !audioOk) {
      this.lastErrorKind = "no_media";
      this.lastError = `ffmpeg 未产出关键帧与有效音轨（音轨 ${audioSize}B，低于 ${MIN_AUDIO_BYTES}B 视为空）：${(res.stderr || "未知原因").trim().slice(-200)}`;
      return null;
    }
    const framePaths = await this.ingestFrames(item.id, dir, fs);
    if (!audioOk) this.lastErrorKind = "no_audio";
    return { audioPath: audioOk ? audioPath : "", framePaths };
  }

  private listLocalFrames(dir: string, fs: any): string[] {
    try {
      return fs
        .readdirSync(dir)
        .filter((f: string) => /^frame_\d+\.jpg$/i.test(f))
        .sort();
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
        if (!existing.has(f)) {
          try {
            const buf = fs.readFileSync(path.join(dir, f));
            await this.vault.createBinary(vp, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
          } catch {
            /* 单帧入库失败（已存在 / IO 异常）不阻断其余帧 */
          }
        }
        out.push(vp);
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

  /** 本地下载视频字节；URL 失效（403 签名过期）时经桥接刷新播放地址重试一次。 */
  private async downloadVideo(url: string, videoId: string): Promise<ArrayBuffer> {
    const headers = { "User-Agent": BROWSER_UA, Referer: "https://www.douyin.com/" };
    let res = await requestUrl({ url, method: "GET", headers, throw: false });
    if (res.status >= 400 && this.client) {
      const raw = await this.client.getAwemeDetail(videoId);
      const fresh = raw ? DouyinClient.normalize(raw as any, "collection") : null;
      if (fresh?.playUrl && fresh.playUrl !== url) {
        res = await requestUrl({ url: fresh.playUrl, method: "GET", headers, throw: false });
      }
    }
    if (res.status >= 400) {
      throw new Error(`HTTP ${res.status}（CDN 拒绝，播放地址可能已过期）`);
    }
    const buf = res.arrayBuffer;
    if (buf.byteLength > MAX_VIDEO_BYTES) {
      throw new Error(`视频超过 ${MAX_VIDEO_BYTES / 1024 / 1024}MB 上限`);
    }
    if (buf.byteLength < 1024) {
      throw new Error(`视频字节数异常（${buf.byteLength}B）`);
    }
    return buf;
  }
}
