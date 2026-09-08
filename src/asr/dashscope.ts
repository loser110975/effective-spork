import { requestUrl } from "obsidian";
import { AsrProvider, AsrResult } from "../types";
import { sleep } from "../util";

/**
 * 阿里云百炼 DashScope — Paraformer 录音文件识别（异步任务，file_urls 服务端拉取）。
 * 文档：https://help.aliyun.com/zh/model-studio/paraformer-recorded-speech-recognition
 */

const BASE = "https://dashscope.aliyuncs.com/api/v1";

export class DashscopeParaformer implements AsrProvider {
  readonly name = "dashscope_paraformer";

  constructor(
    private key: string,
    private model: string = "paraformer-v2",
    private pollTimeoutMs: number = 30 * 60 * 1000,
  ) {}

  async transcribe(url: string): Promise<AsrResult> {
    if (!this.key) return { status: "unavailable", transcript: "", error: "缺少 DASHSCOPE_API_KEY" };
    if (!url) return { status: "unavailable", transcript: "", error: "无播放地址" };

    // 1. 提交任务
    const submit = await requestUrl({
      url: `${BASE}/services/audio/asr/transcription`,
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.key}`,
        "Content-Type": "application/json",
        "X-DashScope-Async": "enable",
      },
      body: JSON.stringify({
        model: this.model,
        input: { file_urls: [url] },
        parameters: { language_hints: ["zh"] },
      }),
      throw: false,
    });
    if (submit.status >= 300) {
      return { status: "failed", transcript: "", error: `提交失败 HTTP ${submit.status}: ${submit.text.slice(0, 200)}` };
    }
    let submitData: any;
    try {
      submitData = submit.json;
    } catch {
      return { status: "failed", transcript: "", error: "提交响应非 JSON" };
    }
    const taskId = submitData?.output?.task_id;
    if (!taskId) {
      return { status: "failed", transcript: "", error: `无 task_id: ${submit.text.slice(0, 200)}` };
    }

    // 2. 轮询任务
    const deadline = Date.now() + this.pollTimeoutMs;
    let taskData: any = null;
    while (Date.now() < deadline) {
      await sleep(5000);
      const poll = await requestUrl({
        url: `${BASE}/tasks/${taskId}`,
        method: "GET",
        headers: { Authorization: `Bearer ${this.key}` },
        throw: false,
      });
      try {
        taskData = poll.json;
      } catch {
        continue;
      }
      const st = String(taskData?.output?.task_status ?? "");
      if (st === "SUCCEEDED") break;
      if (st === "FAILED" || st === "CANCELED" || st === "UNKNOWN") {
        const msg = taskData?.output?.message ?? "任务失败";
        return { status: "failed", transcript: "", error: `任务 ${st}: ${msg}（云端可能无法访问抖音 CDN 直链）` };
      }
    }
    if (!taskData || taskData?.output?.task_status !== "SUCCEEDED") {
      return { status: "failed", transcript: "", error: "轮询超时" };
    }

    // 3. 取转写结果
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
      return { status: "unavailable", transcript: "", provider: this.name, error: "转写结果为空" };
    }
    return { status: "success", transcript, segments, provider: this.name };
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
