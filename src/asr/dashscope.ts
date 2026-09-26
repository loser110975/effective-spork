import { requestUrl } from "obsidian";
import { AsrProvider, AsrResult } from "../types";
import { sleep } from "../util";
import { DouyinClient } from "../douyinClient";

/**
 * 阿里云百炼 DashScope — Paraformer 录音文件识别（异步任务）。
 * 文档：https://help.aliyun.com/zh/model-studio/paraformer-recorded-speech-recognition
 *
 * 通道 A（默认）：file_urls 直传公网 URL，服务端拉取。
 *   抖音 CDN 会 403 拒绝阿里云数据中心 IP → FILE_403_FORBIDDEN。
 * 通道 B（自动回退）：本地下载视频字节 → 百炼临时 OSS（getPolicy + multipart 上传）
 *   → file_urls 传 oss:// 地址（需 X-DashScope-OssResourceResolve: enable）。
 */

const BASE = "https://dashscope.aliyuncs.com/api/v1";
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

// 通道 A 失败后值得走上传通道的错误特征（CDN 拒绝云端拉取 / URL 失效）
const NEED_FALLBACK_RE = /FILE_403_FORBIDDEN|FILE_DOWNLOAD/i;
// 服务端处理错误（模型对特定音频流 bug）——上传通道救不了，跨模型重试才有意义
const SERVER_ERROR_RE = /SERVER_ERROR|InternalError/i;
// 免费额度耗尽（AllocationQuota.FreeTierOnly）——同样换模型（各模型额度独立）
const QUOTA_RE = /AllocationQuota|Free quota exhausted/i;
// 永久性失败：文件里没有可识别语音
const NO_SPEECH_RE = /SUCCESS_WITH_NO_VALID_FRAGMENT|ASR_RESPONSE_HAVE_NO_WORDS/i;

type AsrAttempt = AsrResult & { serverError?: boolean };

export class DashscopeParaformer implements AsrProvider {
  readonly name = "dashscope_paraformer";
  private readonly fallbackModel: string | null;

  constructor(
    private key: string,
    private model: string = "paraformer-v2",
    private pollTimeoutMs: number = 30 * 60 * 1000,
    private client?: DouyinClient | null,
  ) {
    this.fallbackModel = DashscopeParaformer.pickFallback(model);
  }

  /** 跨模型兜底链：fun-asr 系 ↔ paraformer 系互为备份（两者对个别音频流的兼容性互补） */
  static pickFallback(model: string): string | null {
    if (/^fun-asr/i.test(model)) return "paraformer-v2";
    if (/^paraformer/i.test(model)) return "fun-asr-mtl";
    return null;
  }

  async transcribe(url: string, videoId?: string): Promise<AsrResult> {
    if (!this.key) return { status: "unavailable", transcript: "", error: "缺少 DASHSCOPE_API_KEY" };
    if (!url) return { status: "unavailable", transcript: "", error: "无播放地址" };

    const first = await this.transcribeWithModel(this.model, url, videoId);
    // 服务端处理错误 / 主模型额度耗尽 且互备模型可用 → 换模型完整重试（直传 + 上传通道）
    if (first.status === "failed" && first.serverError && this.fallbackModel && this.fallbackModel !== this.model) {
      const second = await this.transcribeWithModel(this.fallbackModel, url, videoId);
      delete second.serverError;
      return second;
    }
    delete first.serverError;
    return first;
  }

  private async transcribeWithModel(model: string, url: string, videoId?: string): Promise<AsrAttempt> {
    // ---- 通道 A：URL 直传 ----
    const direct = await this.submitAndPoll([url], model);
    if (direct.ok) return await this.collectResult(direct.taskId!, model);

    // 永久性失败（纯音乐/无对白等，无可识别语音）——标记 unavailable，不再重试
    if (direct.permanent) {
      return { status: "unavailable", transcript: "", provider: model, error: direct.error };
    }

    // 非"云端拉不到"类错误：SERVER_ERROR / 额度耗尽 走跨模型兜底，其余原样返回
    if (!NEED_FALLBACK_RE.test(direct.error ?? "")) {
      const err = direct.error ?? "";
      return { status: "failed", transcript: "", error: err, serverError: SERVER_ERROR_RE.test(err) || QUOTA_RE.test(err) };
    }
    if (!videoId) {
      return { status: "failed", transcript: "", error: `${direct.error}（无 videoId，无法走上传通道）` };
    }

    // ---- 通道 B：本地下载 → 临时 OSS → oss:// 提交 ----
    try {
      const videoBuf = await this.fetchVideoBytes(url, videoId);
      const policy = await this.getUploadPolicy(model);
      const ossKey = await this.uploadToOss(policy, videoBuf, `${videoId}.mp4`);
      const retry = await this.submitAndPoll([`oss://${ossKey}`], model, { ossResolve: true });
      if (!retry.ok) {
        const err = retry.error ?? "";
        return retry.permanent
          ? { status: "unavailable", transcript: "", provider: model, error: err }
          : { status: "failed", transcript: "", error: err, serverError: SERVER_ERROR_RE.test(err) || QUOTA_RE.test(err) };
      }
      return await this.collectResult(retry.taskId!, model);
    } catch (e: any) {
      return { status: "failed", transcript: "", error: `上传通道失败: ${String(e?.message ?? e).slice(0, 200)}` };
    }
  }

  // ---------- 提交 + 轮询 ----------

  private async submitAndPoll(
    fileUrls: string[],
    model: string,
    opts?: { ossResolve?: boolean },
  ): Promise<{ ok: boolean; taskId?: string; error?: string; permanent?: boolean }> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.key}`,
      "Content-Type": "application/json",
      "X-DashScope-Async": "enable",
    };
    if (opts?.ossResolve) headers["X-DashScope-OssResourceResolve"] = "enable";

    const submit = await requestUrl({
      url: `${BASE}/services/audio/asr/transcription`,
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        input: { file_urls: fileUrls },
        // paraformer 需显式语种；fun-asr 系支持 31 语种自动检测，不传效果更好
        ...(model.startsWith("paraformer") ? { parameters: { language_hints: ["zh"] } } : {}),
      }),
      throw: false,
    });
    if (submit.status >= 300) {
      return { ok: false, error: `提交失败 HTTP ${submit.status}: ${submit.text.slice(0, 200)}` };
    }
    let submitData: any;
    try {
      submitData = submit.json;
    } catch {
      return { ok: false, error: "提交响应非 JSON" };
    }
    const taskId = submitData?.output?.task_id;
    if (!taskId) {
      return { ok: false, error: `无 task_id: ${submit.text.slice(0, 200)}` };
    }
    return await this.pollTask(taskId);
  }

  private async pollTask(taskId: string): Promise<{ ok: boolean; taskId?: string; error?: string; permanent?: boolean }> {
    const deadline = Date.now() + this.pollTimeoutMs;
    while (Date.now() < deadline) {
      await sleep(5000);
      const poll = await requestUrl({
        url: `${BASE}/tasks/${taskId}`,
        method: "GET",
        headers: { Authorization: `Bearer ${this.key}` },
        throw: false,
      });
      let taskData: any;
      try {
        taskData = poll.json;
      } catch {
        continue;
      }
      const st = String(taskData?.output?.task_status ?? "");
      if (st === "SUCCEEDED") return { ok: true, taskId };
      if (st === "FAILED" || st === "CANCELED" || st === "UNKNOWN") {
        const msg = String(taskData?.output?.message ?? "任务失败");
        const code = String(taskData?.output?.code ?? "");
        // 永久性失败：视频里没有可识别语音（纯音乐/无对白），重试无意义
        const permanent = NO_SPEECH_RE.test(code + " " + msg) || /INVALID_FILE|UNSUPPORTED_FILE|InvalidFile/i.test(code + " " + msg);
        return { ok: false, taskId, error: `任务 ${st}: ${code} ${msg}`.trim(), permanent };
      }
    }
    return { ok: false, error: "轮询超时" };
  }

  // ---------- 结果解析 ----------

  private async collectResult(taskId: string, model?: string): Promise<AsrResult> {
    const poll = await requestUrl({
      url: `${BASE}/tasks/${taskId}`,
      method: "GET",
      headers: { Authorization: `Bearer ${this.key}` },
      throw: false,
    });
    let taskData: any;
    try {
      taskData = poll.json;
    } catch {
      return { status: "failed", transcript: "", error: "结果拉取非 JSON" };
    }
    const result = taskData.output?.results?.[0];
    if (!result?.transcription_url) {
      return { status: "failed", transcript: "", error: "结果缺 transcription_url" };
    }
    const tr = await requestUrl({ url: result.transcription_url, method: "GET", throw: false });
    let trData: any;
    try {
      trData = tr.json;
    } catch {
      return { status: "failed", transcript: "", error: "转写结果非 JSON" };
    }
    const sentences: any[] = trData?.transcripts?.[0]?.sentences ?? [];
    const segments = sentences.map((s) => ({
      text: String(s.text ?? "").trim(),
      beginSec: Number(s.begin_time ?? 0) / 1000,
      endSec: Number(s.end_time ?? 0) / 1000,
    }));
    const transcript = segments.map((s) => s.text).join("");
    if (!transcript) {
      return { status: "unavailable", transcript: "", provider: model ?? this.name, error: "转写结果为空" };
    }
    return { status: "success", transcript, segments, provider: model ?? this.name };
  }

  // ---------- 通道 B：下载 / 凭证 / 上传 ----------

  /** 本地下载视频字节。URL 失效时经桥接刷新播放地址重试一次。 */
  private async fetchVideoBytes(url: string, videoId: string): Promise<ArrayBuffer> {
    const headers = { "User-Agent": BROWSER_UA, Referer: "https://www.douyin.com/" };
    let res = await requestUrl({ url, method: "GET", headers, throw: false });
    if (res.status >= 400 && this.client) {
      // 播放地址通常带 expires 签名，过期即 403 —— 经桥接重新拿 detail 刷新
      const raw = await this.client.getAwemeDetail(videoId);
      const fresh = raw ? DouyinClient.normalize(raw as any, "collection") : null;
      if (fresh?.playUrl && fresh.playUrl !== url) {
        res = await requestUrl({ url: fresh.playUrl, method: "GET", headers, throw: false });
      }
    }
    if (res.status >= 400) {
      throw new Error(`视频下载失败 HTTP ${res.status}（CDN 拒绝）`);
    }
    const buf = res.arrayBuffer;
    if (buf.byteLength > 200 * 1024 * 1024) {
      throw new Error(`视频超过 200MB（${(buf.byteLength / 1048576).toFixed(0)}MB），跳过上传通道`);
    }
    if (buf.byteLength < 1024) {
      throw new Error(`视频字节数异常（${buf.byteLength}B）`);
    }
    return buf;
  }

  private async getUploadPolicy(model?: string) {
    const r = await requestUrl({
      url: `${BASE}/uploads?action=getPolicy&model=${encodeURIComponent(model ?? this.model)}`,
      method: "GET",
      headers: { Authorization: `Bearer ${this.key}`, "Content-Type": "application/json" },
      throw: false,
    });
    if (r.status >= 300) throw new Error(`getPolicy HTTP ${r.status}`);
    let j: any;
    try {
      j = r.json;
    } catch {
      throw new Error("getPolicy 响应非 JSON");
    }
    const d = j?.data;
    if (!d?.upload_host || !d?.upload_dir) throw new Error(`getPolicy 异常: ${JSON.stringify(j).slice(0, 200)}`);
    return d as {
      policy: string;
      signature: string;
      upload_dir: string;
      upload_host: string;
      oss_access_key_id: string;
      x_oss_object_acl: string;
      x_oss_forbid_overwrite: string;
    };
  }

  /** 手工构造 multipart/form-data 上传到临时 OSS（requestUrl 不支持 FormData） */
  private async uploadToOss(policy: Awaited<ReturnType<DashscopeParaformer["getUploadPolicy"]>>, videoBuf: ArrayBuffer, filename: string) {
    const ossKey = `${policy.upload_dir}/${filename}`;
    const boundary = "----dsboundary" + Date.now().toString(16);
    const enc = new TextEncoder();
    const parts: Uint8Array[] = [];
    const field = (name: string, value: string) => {
      parts.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
    };
    field("OSSAccessKeyId", policy.oss_access_key_id);
    field("Signature", policy.signature);
    field("policy", policy.policy);
    field("x-oss-object-acl", policy.x_oss_object_acl);
    field("x-oss-forbid-overwrite", policy.x_oss_forbid_overwrite);
    field("key", ossKey);
    field("success_action_status", "200");
    parts.push(
      enc.encode(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
    );
    parts.push(new Uint8Array(videoBuf));
    parts.push(enc.encode(`\r\n--${boundary}--\r\n`));

    const total = parts.reduce((s, x) => s + x.byteLength, 0);
    const body = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
      body.set(p, off);
      off += p.byteLength;
    }

    const r = await requestUrl({
      url: policy.upload_host,
      method: "POST",
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
      body: body.buffer as ArrayBuffer,
      throw: false,
    });
    if (r.status !== 200) {
      throw new Error(`OSS 上传失败 HTTP ${r.status}: ${r.text.slice(0, 200)}`);
    }
    return ossKey;
  }
}

/**
 * 百炼 qwen3-asr-flash 多模态直转（旧工具验证过的调用形态，同步返回）。
 */
export class DashscopeQwen3Asr implements AsrProvider {
  readonly name = "dashscope_qwen3";

  constructor(private key: string) {}

  async transcribe(url: string): Promise<AsrResult> {
    if (!this.key) return { status: "unavailable", transcript: "", error: "缺少 DASHSCOPE_API_KEY" };
    if (!url) return { status: "unavailable", transcript: "", error: "无播放地址" };
    const res = await requestUrl({
      url: "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "qwen3-asr-flash",
        messages: [
          { role: "system", content: [{ text: "" }] },
          { role: "user", content: [{ audio: url }] },
        ],
        result_format: "message",
        asr_options: { enable_lid: true, enable_itn: false },
      }),
      throw: false,
    });
    let data: any;
    try {
      data = res.json;
    } catch {
      return { status: "failed", transcript: "", error: `HTTP ${res.status} 非 JSON` };
    }
    const content = data?.output?.choices?.[0]?.message?.content;
    let text = "";
    if (Array.isArray(content)) {
      text = content.map((p: any) => String(p?.text ?? "")).join("").trim();
    }
    if (!text) {
      return { status: "failed", transcript: "", error: `空结果: ${res.text.slice(0, 200)}` };
    }
    return { status: "success", transcript: text, provider: this.name };
  }
}
