import { requestUrl } from "obsidian";
import { AsrProvider, AsrResult } from "../types";
import { DEFAULT_SETTINGS } from "../types";
import { sleep } from "../util";
import { baseUrlProblem } from "../aiConfig";
import { DouyinClient, downloadVideoBytes } from "../douyinClient";
import { classifyAsrFailureKind } from "./failureKind";

/**
 * 阿里云百炼 DashScope — Paraformer 录音文件识别（异步任务）。
 * 文档：https://help.aliyun.com/zh/model-studio/paraformer-recorded-speech-recognition
 *
 * 接入方式：Base URL（settings.dashscopeBaseUrl，默认官方端点）+ API Key（settings.dashscopeKey）。
 * 通道 A（默认）：file_urls 直传公网 URL，服务端拉取。
 *   抖音 CDN 会 403 拒绝阿里云数据中心 IP → FILE_403_FORBIDDEN。
 * 通道 B（自动回退）：本地下载视频字节 → 百炼临时 OSS（getPolicy + multipart 上传）
 *   → file_urls 传 oss:// 地址（需 X-DashScope-OssResourceResolve: enable）。
 */

// 通道 A 失败后值得走上传通道的错误特征（CDN 拒绝云端拉取 / URL 失效）
const NEED_FALLBACK_RE = /FILE_403_FORBIDDEN|FILE_DOWNLOAD/i;
// 服务端处理错误（模型对特定音频流 bug）——上传通道救不了，跨模型重试才有意义
const SERVER_ERROR_RE = /SERVER_ERROR|InternalError/i;
// 免费额度耗尽（AllocationQuota.FreeTierOnly）——同样换模型（各模型额度独立）
const QUOTA_RE = /AllocationQuota|Free quota exhausted/i;
// 永久性失败：文件里没有可识别语音
const NO_SPEECH_RE = /SUCCESS_WITH_NO_VALID_FRAGMENT|ASR_RESPONSE_HAVE_NO_WORDS/i;

type AsrAttempt = AsrResult & { serverError?: boolean };

/** 单次轮询请求连续网络失败容忍次数：30 分钟窗口内网络抖动概率不低，抖一次就放弃整个任务太浪费。 */
const POLL_NET_TOLERANCE = 5;

export class DashscopeParaformer implements AsrProvider {
  readonly name = "dashscope_paraformer";
  private readonly fallbackModel: string | null;
  private readonly baseUrl: string;

  constructor(
    private key: string,
    private model: string = "paraformer-v2",
    private pollTimeoutMs: number = 30 * 60 * 1000,
    private client?: DouyinClient | null,
    baseUrl?: string,
  ) {
    // 统一接入：Base URL 由 settings（dashscopeBaseUrl）传入，缺省回退官方端点
    this.baseUrl = (baseUrl || DEFAULT_SETTINGS.dashscopeBaseUrl).trim();
    this.fallbackModel = DashscopeParaformer.pickFallback(model);
  }

  /** 跨模型兜底链：fun-asr 系 ↔ paraformer 系互为备份（两者对个别音频流的兼容性互补） */
  static pickFallback(model: string): string | null {
    if (/^fun-asr/i.test(model)) return "paraformer-v2";
    if (/^paraformer/i.test(model)) return "fun-asr-mtl";
    return null;
  }

  async transcribe(url: string, videoId?: string): Promise<AsrResult> {
    // 配置缺失 / 无效 → 明确报错（状态语义保持 unavailable：配置问题不进重试队列）
    const bad = baseUrlProblem(this.baseUrl, "百炼 DashScope");
    if (bad) return { status: "unavailable", transcript: "", error: bad };
    if (!this.key) return { status: "unavailable", transcript: "", error: "百炼 DashScope API Key 未配置（Obsidian 设置 → 抖音同步 → 语音转写）" };
    if (!url) return { status: "unavailable", transcript: "", error: "无播放地址" };

    // 顶层兜底（2026-09-27 修）：此前任何一次 requestUrl 网络异常都会直接冒泡到 processItem 的大 catch
    // —— 封面/抽帧/OCR 已全部完成，笔记却不写、重试台账也不记，下轮从零重跑整条流水线。
    try {
      const first = await this.transcribeWithModel(this.model, url, videoId);
      // 服务端处理错误 / 主模型额度耗尽 且互备模型可用 → 换模型完整重试（直传 + 上传通道）
      if (first.status === "failed" && first.serverError && this.fallbackModel && this.fallbackModel !== this.model) {
        const second = await this.transcribeWithModel(this.fallbackModel, url, videoId);
        delete second.serverError;
        return second;
      }
      delete first.serverError;
      return first;
    } catch (e: any) {
      const msg = `转写请求异常：${String(e?.message ?? e).slice(0, 200)}`;
      return { status: "failed", transcript: "", provider: this.name, error: msg, failureKind: classifyAsrFailureKind(msg) };
    }
  }

  private async transcribeWithModel(model: string, url: string, videoId?: string): Promise<AsrAttempt> {
    // ---- 通道 A：URL 直传 ----
    const direct = await this.submitAndPoll([url], model);
    if (direct.ok) {
      const got = await this.collectResult(direct.taskId!, model);
      // 任务 SUCCEEDED 但单文件结果失败（2026-09-27 第四轮）：results[0] 带 code/message
      // （如 FILE_403_FORBIDDEN / FILE_DOWNLOAD_*）而无 transcription_url，是「云端拉取失败」
      // 的确切形态——与提交阶段同类，通道 B（上传 OSS）同样能救。带不出错误码时
      // NEED_FALLBACK_RE 无法命中，通道 B 对这类失败永远不会触发。
      if (!(got.status === "failed" && videoId && NEED_FALLBACK_RE.test(got.error ?? ""))) {
        return got;
      }
    } else {
      // 永久性失败（纯音乐/无对白等，无可识别语音）——标记 unavailable，不再重试
      if (direct.permanent) {
        return { status: "unavailable", transcript: "", provider: model, error: direct.error };
      }
      // 非"云端拉不到"类错误：SERVER_ERROR / 额度耗尽 走跨模型兜底，其余原样返回
      if (!NEED_FALLBACK_RE.test(direct.error ?? "")) {
        const err = direct.error ?? "";
        return { status: "failed", transcript: "", error: err, failureKind: classifyAsrFailureKind(err), serverError: SERVER_ERROR_RE.test(err) || QUOTA_RE.test(err) };
      }
      if (!videoId) {
        return { status: "failed", transcript: "", error: `${direct.error}（无 videoId，无法走上传通道）`, failureKind: classifyAsrFailureKind(`${direct.error}（无 videoId，无法走上传通道）`) };
      }
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
          : { status: "failed", transcript: "", error: err, failureKind: classifyAsrFailureKind(err), serverError: SERVER_ERROR_RE.test(err) || QUOTA_RE.test(err) };
      }
      return await this.collectResult(retry.taskId!, model);
    } catch (e: any) {
      const msg = `上传通道失败: ${String(e?.message ?? e).slice(0, 200)}`;
      return { status: "failed", transcript: "", error: msg, failureKind: classifyAsrFailureKind(msg) };
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

    let submit: any;
    try {
      submit = await requestUrl({
        url: `${this.baseUrl}/services/audio/asr/transcription`,
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
    } catch (e: any) {
      return { ok: false, error: `提交网络异常：${String(e?.message ?? e).slice(0, 150)}` };
    }
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
    let netFailures = 0;
    while (Date.now() < deadline) {
      await sleep(5000);
      let poll: any;
      try {
        poll = await requestUrl({
          url: `${this.baseUrl}/tasks/${taskId}`,
          method: "GET",
          headers: { Authorization: `Bearer ${this.key}` },
          throw: false,
        });
      } catch {
        // 轮询中的瞬时网络异常：容忍连续 POLL_NET_TOLERANCE 次（任务本身还在云端跑，不宜整体放弃）
        if (++netFailures >= POLL_NET_TOLERANCE) {
          return { ok: false, taskId, error: "轮询网络异常（连续多次请求失败）" };
        }
        continue;
      }
      netFailures = 0;
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
    let poll: any;
    try {
      poll = await requestUrl({
        url: `${this.baseUrl}/tasks/${taskId}`,
        method: "GET",
        headers: { Authorization: `Bearer ${this.key}` },
        throw: false,
      });
    } catch (e: any) {
      return { status: "failed", transcript: "", error: `结果拉取网络异常：${String(e?.message ?? e).slice(0, 150)}`, failureKind: classifyAsrFailureKind(`结果拉取网络异常：${String(e?.message ?? e).slice(0, 150)}`) };
    }
    let taskData: any;
    try {
      taskData = poll.json;
    } catch {
      return { status: "failed", transcript: "", error: "结果拉取非 JSON" };
    }
    const result = taskData.output?.results?.[0];
    if (!result?.transcription_url) {
      // 单文件失败时服务端把 code/message 放在 results[0]（如 FILE_403_FORBIDDEN）：
      // 原样带回，让 NEED_FALLBACK_RE / 确定性分类正常接管（此前只报通用错误，两套分类全部失明）
      const code = String(result?.code ?? "");
      const msg = String(result?.message ?? "");
      const detail = `${code} ${msg}`.trim();
      // 文件级失败与任务级同语义归类（第六轮）：纯音乐/无对白（NO_SPEECH）与无效文件
      // 重试必然复现同一结果，与 pollTask 的 permanent 判定同口径 → unavailable 移出
      // 重试队列；原实现一律 failed，纯音乐条目被反复重试直至 dead-letter
      if (detail && (NO_SPEECH_RE.test(detail) || /INVALID_FILE|UNSUPPORTED_FILE|InvalidFile/i.test(detail))) {
        return { status: "unavailable", transcript: "", error: `文件级失败 ${detail.slice(0, 200)}` };
      }
      return {
        status: "failed",
        transcript: "",
        error: detail ? `文件级失败 ${detail.slice(0, 200)}` : "结果缺 transcription_url",
        // N1（QA 备注）：classify 必须用与 error 同一截断串——引擎侧兜底正则测的是
        // `文件级失败 ${detail.slice(0,200)}`（截断 200 字符），打标若测未截断 detail，
        // 「关键词恰好被 200 字符截断/截在边界」时打标结果会与旧正则判定不一致
        failureKind: classifyAsrFailureKind(detail.slice(0, 200)),
      };
    }
    let tr: any;
    try {
      tr = await requestUrl({ url: result.transcription_url, method: "GET", throw: false });
    } catch (e: any) {
      return { status: "failed", transcript: "", error: `转写结果下载网络异常：${String(e?.message ?? e).slice(0, 150)}`, failureKind: classifyAsrFailureKind(`转写结果下载网络异常：${String(e?.message ?? e).slice(0, 150)}`) };
    }
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

  /** 本地下载视频字节。URL 失效时经桥接刷新播放地址重试一次（P2-3：共享实现见 douyinClient.downloadVideoBytes）。 */
  private async fetchVideoBytes(url: string, videoId: string): Promise<ArrayBuffer> {
    return downloadVideoBytes(url, { client: this.client, videoId, errorStyle: "upload" });
  }

  private async getUploadPolicy(model?: string) {
    const r = await requestUrl({
      url: `${this.baseUrl}/uploads?action=getPolicy&model=${encodeURIComponent(model ?? this.model)}`,
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
    const field = (name: string, value: string) =>
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
    const headText =
      field("OSSAccessKeyId", policy.oss_access_key_id) +
      field("Signature", policy.signature) +
      field("policy", policy.policy) +
      field("x-oss-object-acl", policy.x_oss_object_acl) +
      field("x-oss-forbid-overwrite", policy.x_oss_forbid_overwrite) +
      field("key", ossKey) +
      field("success_action_status", "200") +
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
    const head = enc.encode(headText);
    const tail = enc.encode(`\r\n--${boundary}--\r\n`);
    // body 必须整体构建（multipart 无流式接口，requestUrl 只收单个 ArrayBuffer）：
    // header/tail 两次小拷贝 + 文件字节一次 set。注意 `new Uint8Array(videoBuf)` 只是视图
    // 不拷贝，但 body 分配与 set 仍是全量拷贝——videoBuf 在调用方仍存活时峰值仍约 2× 文件
    // 体积（200MB 文件 ≈ 400MB）。真正的峰值减半需要分片流式上传，requestUrl 不支持，维持现状。
    const fileBytes = new Uint8Array(videoBuf);
    const body = new Uint8Array(head.byteLength + fileBytes.byteLength + tail.byteLength);
    body.set(head, 0);
    body.set(fileBytes, head.byteLength);
    body.set(tail, head.byteLength + fileBytes.byteLength);

    const r = await requestUrl({
      url: policy.upload_host,
      method: "POST",
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
      body: body.buffer as ArrayBuffer,
      throw: false,
      // 显式超时（2026-09-27 第四轮）：requestUrl 默认 ~30s，家宽上行传 100MB+ 必被掐断——
      // 异常被归为「上传通道失败」可重试类，下轮重新下载 200MB 再传，反复白烧流量直到 dead-letter
      timeout: 600_000,
    } as any);
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
  private readonly baseUrl: string;

  constructor(private key: string, baseUrl?: string) {
    // 统一接入：Base URL 由 settings（dashscopeBaseUrl）传入，缺省回退官方端点
    this.baseUrl = (baseUrl || DEFAULT_SETTINGS.dashscopeBaseUrl).trim();
  }

  async transcribe(url: string): Promise<AsrResult> {
    const bad = baseUrlProblem(this.baseUrl, "百炼 DashScope");
    if (bad) return { status: "unavailable", transcript: "", error: bad };
    if (!this.key) return { status: "unavailable", transcript: "", error: "百炼 DashScope API Key 未配置（Obsidian 设置 → 抖音同步 → 语音转写）" };
    if (!url) return { status: "unavailable", transcript: "", error: "无播放地址" };
    let res: any;
    try {
      res = await requestUrl({
        url: `${this.baseUrl}/services/aigc/multimodal-generation/generation`,
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
        // 同步推理显式超时（2026-09-27 第四轮）：这是全部 provider 里唯一的同步直转调用，
        // requestUrl 默认 ~30s 对 600s 音频的服务端直转大概率不够——长视频稳定超时进重试，
        // 表现为「qwen3 转写永远失败」且极难排查
        timeout: 300_000,
      } as any);
    } catch (e: any) {
      const msg = `转写请求网络异常：${String(e?.message ?? e).slice(0, 150)}`;
      return { status: "failed", transcript: "", error: msg, failureKind: classifyAsrFailureKind(msg) };
    }
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
