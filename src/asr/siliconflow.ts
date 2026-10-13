// asr/siliconflow.ts — 硅基流动 SenseVoice 语音转写（FunAudioLLM/SenseVoiceSmall）。
// 需要本地音频文件：经 AudioResolver（VideoMediaStore，ffmpeg 抽取）取得 mp3 后
// multipart 上传到 <Base URL>/audio/transcriptions。响应 {"text": "..."}，无时间戳。
// 接入方式：Base URL（settings.siliconflowBaseUrl，默认官方端点）+ API Key（settings.siliconflowKey）。
import { requestUrl, type RequestUrlParam } from "obsidian";
import { AsrProvider, AsrResult, AsrTranscribeOpts, AudioResolver, DEFAULT_SETTINGS } from "../types";
import { baseUrlProblem } from "../aiConfig";
import { nodeRequire } from "../util";

const MODEL = "FunAudioLLM/SenseVoiceSmall";
/** 小于此值的音频视为空壳产物：远端对不可解码输入只回 500 空 body，上传纯属浪费且会掩盖真因。 */
const MIN_AUDIO_BYTES = 1024;
/** 瞬时网络异常（连接被重置/超时）——重传一次即可覆盖，不必升级为转写失败。 */
const TRANSIENT_NET_RE = /net::ERR_|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|socket hang up/i;

export class SiliconflowSenseVoice implements AsrProvider {
  readonly name = "siliconflow_sensevoice";
  private readonly baseUrl: string;

  constructor(
    private key: string,
    private resolveAudio?: AudioResolver,
    baseUrl?: string,
  ) {
    // 统一接入：Base URL 由 settings（siliconflowBaseUrl）传入，缺省回退官方端点
    this.baseUrl = (baseUrl || DEFAULT_SETTINGS.siliconflowBaseUrl).trim();
  }

  async transcribe(url: string, videoId?: string, opts?: AsrTranscribeOpts): Promise<AsrResult> {
    // 配置缺失 / 无效 → 明确报错（保持既有状态语义 failed：与缺 Key 时一致，进重试队列由人工处理）
    const bad = baseUrlProblem(this.baseUrl, "硅基流动");
    if (bad) return { status: "failed", transcript: "", error: bad };
    if (!this.key) {
      return { status: "failed", transcript: "", error: "硅基流动 API Key 未配置（Obsidian 设置 → 抖音同步 → 语音转写）" };
    }
    if (!url) return { status: "unavailable", transcript: "", error: "无播放地址" };
    if (!this.resolveAudio) {
      return { status: "failed", transcript: "", error: "未接入音频解析通道（需要 ffmpeg 抽取音轨）" };
    }
    let audioPath: string | null = null;
    try {
      audioPath = await this.resolveAudio(url, videoId, opts?.durationSec);
    } catch (e: any) {
      return { status: "failed", transcript: "", provider: this.name, error: `音频抽取异常：${String(e?.message ?? e).slice(0, 150)}` };
    }
    if (!audioPath) {
      return { status: "failed", transcript: "", provider: this.name, error: "无法取得音频文件（需本机 ffmpeg 抽取音轨）" };
    }
    try {
      const text = await this.uploadTranscribe(audioPath);
      if (text) return { status: "success", transcript: text, provider: this.name };
      // 纯音乐 / 无对白：无可转写内容，与百炼通道同语义（移出重试队列，不反复重试）
      return { status: "unavailable", transcript: "", provider: this.name, error: "转写结果为空（可能无对白）" };
    } catch (e: any) {
      return { status: "failed", transcript: "", provider: this.name, error: String(e?.message ?? e).slice(0, 200) };
    }
  }

  /** 手工构造 multipart/form-data 上传（requestUrl 不支持 FormData），复用百炼 OSS 上传同款拼装方式。 */
  private async uploadTranscribe(audioPath: string): Promise<string> {
    const fs = nodeRequire<{ readFileSync: (p: string) => Buffer }>("fs");
    if (!fs) throw new Error("Node 运行时不可用，无法读取本地音频文件");
    const buf = fs.readFileSync(audioPath);
    // P2（2026-09-21）：空壳音频直接短路。ffmpeg 失败时 -y 会留下 0 字节文件，
    // 上传它只会拿到服务端 500 空 body，把「素材没产出」伪装成「SiliconFlow 故障」。
    if (!buf || buf.byteLength < MIN_AUDIO_BYTES) {
      throw new Error(`本地音频为空壳（${buf?.byteLength ?? 0}B），已跳过上传：ffmpeg 未产出有效音轨`);
    }
    const fileBytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    const boundary = "----dsboundary" + Date.now().toString(16);
    const enc = new TextEncoder();
    const parts: Uint8Array[] = [];
    const field = (name: string, value: string) => {
      parts.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
    };
    field("model", MODEL);
    field("language", "zh");
    field("response_format", "json");
    parts.push(
      enc.encode(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.mp3"\r\nContent-Type: audio/mpeg\r\n\r\n`,
      ),
    );
    parts.push(fileBytes);
    parts.push(enc.encode(`\r\n--${boundary}--\r\n`));

    const total = parts.reduce((s, x) => s + x.byteLength, 0);
    const body = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
      body.set(p, off);
      off += p.byteLength;
    }

    // P3（2026-09-21）：net::ERR_CONNECTION_CLOSED 曾让 2.8MB 上传一次失败即判 failed（无重传）。
    // 瞬时连接异常重传一次（3s 退避）；其余错误原样抛出。
    let res = await this.post(body.buffer as ArrayBuffer, boundary);
    if (!res) {
      await new Promise((r) => setTimeout(r, 3000));
      res = await this.post(body.buffer as ArrayBuffer, boundary);
    }
    if (!res) throw new Error("上传失败：连接被重置且重传仍未成功（net::ERR_*）");
    if (res.status >= 300) {
      // 5xx + 空 body 是服务端对「不可解码输入」的固定反应，不是服务故障——不要误导排障方向
      const empty = !res.text || !res.text.trim();
      if (res.status >= 500 && empty) {
        throw new Error(`素材不可解码（服务端 ${res.status} 空响应），非转写服务故障`);
      }
      throw new Error(`SiliconFlow HTTP ${res.status}: ${res.text.slice(0, 200)}`);
    }
    let data: any;
    try {
      data = res.json;
    } catch {
      throw new Error(`SiliconFlow 响应非 JSON: ${res.text.slice(0, 120)}`);
    }
    return typeof data?.text === "string" ? data.text.trim() : "";
  }

  /** 单次上传；瞬时网络异常返回 null（交由调用方重传），其余错误直接抛出。 */
  private async post(body: ArrayBuffer, boundary: string): Promise<{ status: number; text: string; json: any } | null> {
    try {
      const res = await requestUrl({
        url: `${this.baseUrl}/audio/transcriptions`,
        method: "POST",
        headers: { Authorization: `Bearer ${this.key}`, "Content-Type": `multipart/form-data; boundary=${boundary}` },
        body,
        throw: false,
        // 显式超时（2026-09-27 修）：无此参数受 requestUrl 默认 ~30s 摆布，
        // 10 分钟上限音频 ≈ 4.8MB，慢上行必被掐断；且 abort 报错若不含 net::ERR_* 特征连重传都没有
        timeout: 120_000,
      } as RequestUrlParam & { timeout: number });
      let json: any = null;
      try {
        json = res.json;
      } catch {
        json = null; // 非 JSON 响应由调用方按 text 处理
      }
      return { status: res.status, text: res.text, json };
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (TRANSIENT_NET_RE.test(msg)) return null;
      throw new Error(`上传异常：${msg.slice(0, 200)}`);
    }
  }
}
