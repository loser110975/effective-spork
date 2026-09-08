import { requestUrl } from "obsidian";
import { AsrProvider, AsrResult } from "../types";
import { sleep, randomHex } from "../util";

/**
 * 火山引擎 录音文件识别大模型（AUC，URL 提交）。
 * 文档：https://www.volcengine.com/docs/6561/1331193
 * 认证：Authorization: Bearer; {token}，X-Api-App-Key: {appid}，X-Api-Resource-Id: volc.bigasr.auc
 */
export class VolcengineAsr implements AsrProvider {
  readonly name = "volcengine";

  constructor(
    private appId: string,
    private token: string,
    private cluster: string = "volcengine_auc_common",
    private pollTimeoutMs: number = 30 * 60 * 1000,
  ) {}

  async transcribe(url: string): Promise<AsrResult> {
    if (!this.appId || !this.token) {
      return { status: "unavailable", transcript: "", error: "缺少火山引擎 AppID / Token" };
    }
    if (!url) return { status: "unavailable", transcript: "", error: "无播放地址" };

    const submit = await requestUrl({
      url: "https://openspeech.bytedance.com/api/v1/auc/submit",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer; ${this.token}`,
        "X-Api-App-Key": this.appId,
        "X-Api-Resource-Id": "volc.bigasr.auc",
        "X-Api-Request-Id": randomHex(32),
      },
      body: JSON.stringify({
        app: { appid: this.appId, token: this.token, cluster: this.cluster },
        user: { uid: "obsidian-douyin-sync" },
        request: { model_name: "bigmodel", enable_punc: true, show_utterances: true },
        audio: { format: "mp4", url },
      }),
      throw: false,
    });
    let submitData: any;
    try {
      submitData = submit.json;
    } catch {
      return { status: "failed", transcript: "", error: `提交失败 HTTP ${submit.status}` };
    }
    if (submit.status >= 300 || !submitData?.id) {
      return { status: "failed", transcript: "", error: `提交失败: ${submit.text.slice(0, 200)}` };
    }
    const taskId = submitData.id;

    const deadline = Date.now() + this.pollTimeoutMs;
    while (Date.now() < deadline) {
      await sleep(5000);
      const poll = await requestUrl({
        url: `https://openspeech.bytedance.com/api/v1/auc/query?appid=${encodeURIComponent(this.appId)}&token=${encodeURIComponent(this.token)}&id=${encodeURIComponent(taskId)}`,
        method: "GET",
        headers: {
          Authorization: `Bearer; ${this.token}`,
          "X-Api-App-Key": this.appId,
          "X-Api-Resource-Id": "volc.bigasr.auc",
        },
        throw: false,
      });
      let data: any;
      try {
        data = poll.json;
      } catch {
        continue;
      }
      const status = Number(data?.resp?.status ?? data?.status ?? 0);
      // 0=进行中 3=完成 4=失败（按文档常见取值，做宽泛处理）
      if (status === 3) {
        const result = data?.resp?.result ?? data?.result;
        const utterances: any[] = result?.utterances ?? [];
        const segments = utterances.map((u) => ({
          text: String(u.text ?? "").trim(),
          beginSec: Number(u.start_time ?? 0) / 1000,
          endSec: Number(u.end_time ?? 0) / 1000,
        }));
        const transcript = String(result?.text ?? "") || segments.map((s) => s.text).join("");
        if (!transcript) return { status: "unavailable", transcript: "", provider: this.name, error: "转写结果为空" };
        return { status: "success", transcript, segments, provider: this.name };
      }
      if (status === 4) {
        return { status: "failed", transcript: "", error: `任务失败: ${data?.resp?.message ?? ""}（云端可能无法访问抖音 CDN 直链）` };
      }
    }
    return { status: "failed", transcript: "", error: "轮询超时" };
  }
}
