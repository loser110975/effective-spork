import { requestUrl } from "obsidian";
import { createHash, createHmac } from "crypto";
import { AsrProvider, AsrResult } from "../types";
import { sleep } from "../util";

/**
 * 腾讯云 录音文件识别（CreateRecTask / DescribeTaskStatus，TC3-HMAC-SHA256 签名）。
 * 文档：https://cloud.tencent.com/document/product/1093/48982
 */
export class TencentAsr implements AsrProvider {
  readonly name = "tencent";

  constructor(
    private secretId: string,
    private secretKey: string,
    private pollTimeoutMs: number = 30 * 60 * 1000,
  ) {}

  private tc3Headers(action: string, payload: string): Record<string, string> {
    const service = "asr";
    const host = "asr.tencentcloudapi.com";
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
    if (!this.secretId || !this.secretKey) {
      return { status: "unavailable", transcript: "", error: "缺少腾讯云 SecretId / SecretKey" };
    }
    if (!url) return { status: "unavailable", transcript: "", error: "无播放地址" };

    const createPayload = JSON.stringify({
      EngineModelType: "16k_zh",
      ChannelNum: 1,
      ResTextFormat: 3, // 带词级时间戳的分段
      SourceType: 0,
      Url: url,
    });
    const createRes = await requestUrl({
      url: "https://asr.tencentcloudapi.com",
      method: "POST",
      headers: this.tc3Headers("CreateRecTask", createPayload),
      body: createPayload,
      throw: false,
    });
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
    while (Date.now() < deadline) {
      await sleep(5000);
      const pollPayload = JSON.stringify({ TaskId: taskId });
      const pollRes = await requestUrl({
        url: "https://asr.tencentcloudapi.com",
        method: "POST",
        headers: this.tc3Headers("DescribeTaskStatus", pollPayload),
        body: pollPayload,
        throw: false,
      });
      let data: any;
      try {
        data = pollRes.json;
      } catch {
        continue;
      }
      const err = data?.Response?.Error;
      if (err) return { status: "failed", transcript: "", error: `DescribeTaskStatus: ${err.Code} ${err.Message}` };
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
