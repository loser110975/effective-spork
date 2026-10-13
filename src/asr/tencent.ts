import { requestUrl } from "obsidian";
import { createHash, createHmac } from "crypto";
import { AsrProvider, AsrResult, DEFAULT_SETTINGS } from "../types";
import { baseUrlProblem } from "../aiConfig";
import { sleep } from "../util";

/**
 * 腾讯云 录音文件识别（CreateRecTask / DescribeTaskStatus，TC3-HMAC-SHA256 签名）。
 * 文档：https://cloud.tencent.com/document/product/1093/48982
 *
 * 接入方式：Base URL（settings.tencentBaseUrl，默认官方端点）+ 密钥对（SecretId / SecretKey）。
 * TC3 签名的 Host 头与规范请求从 Base URL 动态解析，改基址（中转/代理）签名依旧有效。
 */
export class TencentAsr implements AsrProvider {
  readonly name = "tencent";
  private readonly baseUrl: string;

  constructor(
    private secretId: string,
    private secretKey: string,
    private pollTimeoutMs: number = 30 * 60 * 1000,
    baseUrl?: string,
  ) {
    // 统一接入：Base URL 由 settings（tencentBaseUrl）传入，缺省回退官方端点
    this.baseUrl = (baseUrl || DEFAULT_SETTINGS.tencentBaseUrl).trim();
  }

  /** 从 Base URL 解析签名所需的 Host；解析失败时回退官方端点域名。 */
  private host(): string {
    try {
      return new URL(this.baseUrl).host;
    } catch {
      return new URL(DEFAULT_SETTINGS.tencentBaseUrl).host;
    }
  }

  private tc3Headers(action: string, payload: string): Record<string, string> {
    const service = "asr";
    const host = this.host();
    const version = "2019-06-14";
    const now = new Date();
    const date = now.toISOString().slice(0, 10);
    const timestamp = Math.floor(now.getTime() / 1000);

    const hashedPayload = createHash("sha256").update(payload).digest("hex");
    const canonicalRequest = [
      "POST",
      "/",
      "",
      `content-type:application/json; charset=utf-8\nhost:${host}\nx-tc-action:${action.toLowerCase()}\n`,
      `content-type;host;x-tc-action`,
      hashedPayload,
    ].join("\n");
    const stringToSign = [
      "TC3-HMAC-SHA256",
      String(timestamp),
      `${date}/${service}/tc3_request`,
      createHash("sha256").update(canonicalRequest).digest("hex"),
    ].join("\n");

    const kDate = createHmac("sha256", `TC3${this.secretKey}`).update(date).digest();
    const kService = createHmac("sha256", kDate).update(service).digest();
    const kSigning = createHmac("sha256", kService).update("tc3_request").digest();
    const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");

    return {
      "Content-Type": "application/json; charset=utf-8",
      Host: host,
      "X-TC-Action": action,
      "X-TC-Version": version,
      "X-TC-Timestamp": String(timestamp),
      Authorization:
        `TC3-HMAC-SHA256 Credential=${this.secretId}/${date}/${service}/tc3_request, ` +
        `SignedHeaders=content-type;host;x-tc-action, Signature=${signature}`,
    };
  }

  async transcribe(url: string): Promise<AsrResult> {
    // 配置缺失 / 无效 → 明确报错（状态语义保持 unavailable：配置问题不进重试队列）
    const bad = baseUrlProblem(this.baseUrl, "腾讯云 ASR");
    if (bad) return { status: "unavailable", transcript: "", error: bad };
    if (!this.secretId || !this.secretKey) {
      return { status: "unavailable", transcript: "", error: "腾讯云 SecretId / SecretKey 未配置（Obsidian 设置 → 抖音同步 → 语音转写）" };
    }
    if (!url) return { status: "unavailable", transcript: "", error: "无播放地址" };

    const createPayload = JSON.stringify({
      EngineModelType: "16k_zh",
      ChannelNum: 1,
      ResTextFormat: 3, // 带词级时间戳的分段
      SourceType: 0,
      Url: url,
    });
    let createRes: any;
    try {
      createRes = await requestUrl({
        url: this.baseUrl,
        method: "POST",
        headers: this.tc3Headers("CreateRecTask", createPayload),
        body: createPayload,
        throw: false,
      });
    } catch (e: any) {
      // 2026-09-27 修：此前提交/轮询的网络异常会冒泡到 processItem 顶层，整条流水线白跑且不进重试台账
      return { status: "failed", transcript: "", provider: this.name, error: `提交网络异常：${String(e?.message ?? e).slice(0, 150)}` };
    }
    let createData: any;
    try {
      createData = createRes.json;
    } catch {
      return { status: "failed", transcript: "", error: `提交失败 HTTP ${createRes.status}` };
    }
    const taskErr = createData?.Response?.Error;
    if (taskErr) {
      return { status: "failed", transcript: "", error: `CreateRecTask: ${taskErr.Code} ${taskErr.Message}` };
    }
    const taskId = createData?.Response?.Data?.TaskId;
    if (taskId === undefined || taskId === null) {
      return { status: "failed", transcript: "", error: "未返回 TaskId" };
    }

    const deadline = Date.now() + this.pollTimeoutMs;
    let netFailures = 0;
    let serverFailures = 0;
    while (Date.now() < deadline) {
      await sleep(5000);
      const pollPayload = JSON.stringify({ TaskId: taskId });
      let pollRes: any;
      try {
        pollRes = await requestUrl({
          url: this.baseUrl,
          method: "POST",
          headers: this.tc3Headers("DescribeTaskStatus", pollPayload),
          body: pollPayload,
          throw: false,
        });
      } catch {
        // 瞬时网络异常容忍连续多次（任务还在云端跑，不宜整体放弃）
        if (++netFailures >= 5) return { status: "failed", transcript: "", provider: this.name, error: "轮询网络异常（连续多次请求失败）" };
        continue;
      }
      netFailures = 0;
      let data: any;
      try {
        data = pollRes.json;
      } catch {
        continue;
      }
      const err = data?.Response?.Error;
      if (err) {
        // 服务端瞬时错误容忍（2026-09-27 第四轮）：Throttling / InternalError 一次即判失败
        // 会丢掉已付费的转写任务（重试队列下轮重新提交、重新计费）；与网络异常同款容忍计数
        if (/Throttling|RequestLimitExceeded|InternalError|Unavailable/i.test(String(err.Code ?? "")) && ++serverFailures < 5) {
          continue;
        }
        return { status: "failed", transcript: "", error: `DescribeTaskStatus: ${err.Code} ${err.Message}` };
      }
      serverFailures = 0;
      const d = data?.Response?.Data;
      if (d?.StatusStr === "success" || d?.Status === 2) {
        const segments: any[] = d?.ResultDetail ?? [];
        const segs = segments.map((s: any) => ({
          text: String(s?.FinalSentence ?? s?.SliceSentence ?? "").trim(),
          beginSec: Number(s?.StartMs ?? 0) / 1000,
          endSec: Number(s?.EndMs ?? 0) / 1000,
        }));
        const transcript = String(d?.Result ?? "") || segs.map((s) => s.text).join("");
        if (!transcript) return { status: "unavailable", transcript: "", provider: this.name, error: "转写结果为空" };
        return { status: "success", transcript, segments: segs, provider: this.name };
      }
      if (d?.StatusStr === "failed" || d?.Status === 3) {
        return { status: "failed", transcript: "", error: `任务失败: ${d?.ErrorMsg ?? ""}（云端可能无法访问抖音 CDN 直链）` };
      }
    }
    return { status: "failed", transcript: "", error: "轮询超时" };
  }
}
