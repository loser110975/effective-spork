import { requestUrl } from "obsidian";
import { AsrProvider, AsrResult, DEFAULT_SETTINGS } from "../types";
import { baseUrlProblem } from "../aiConfig";
import { sleep, randomHex } from "../util";

/**
 * 火山引擎 录音文件识别大模型（AUC，URL 提交）。
 * 文档：https://www.volcengine.com/docs/6561/1331193
 * 认证：Authorization: Bearer; {token}，X-Api-App-Key: {appid}，X-Api-Resource-Id: volc.bigasr.auc
 *
 * 接入方式：Base URL（settings.volcBaseUrl，默认官方端点）+ 凭证（AppID / Access Token）。
 */
export class VolcengineAsr implements AsrProvider {
  readonly name = "volcengine";
  private readonly baseUrl: string;

  constructor(
    private appId: string,
    private token: string,
    private cluster: string = "volcengine_auc_common",
    private pollTimeoutMs: number = 30 * 60 * 1000,
    baseUrl?: string,
  ) {
    // 统一接入：Base URL 由 settings（volcBaseUrl）传入，缺省回退官方端点
    this.baseUrl = (baseUrl || DEFAULT_SETTINGS.volcBaseUrl).trim();
  }

  async transcribe(url: string): Promise<AsrResult> {
    // 配置缺失 / 无效 → 明确报错（状态语义保持 unavailable：配置问题不进重试队列）
    const bad = baseUrlProblem(this.baseUrl, "火山引擎 ASR");
    if (bad) return { status: "unavailable", transcript: "", error: bad };
    if (!this.appId || !this.token) {
      return { status: "unavailable", transcript: "", error: "火山引擎 AppID / Access Token 未配置（Obsidian 设置 → 抖音同步 → 语音转写）" };
    }
    if (!url) return { status: "unavailable", transcript: "", error: "无播放地址" };

    let submit: any;
    try {
      submit = await requestUrl({
        url: `${this.baseUrl}/auc/submit`,
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
    } catch (e: any) {
      // 2026-09-27 修：此前提交/轮询的网络异常会冒泡到 processItem 顶层，整条流水线白跑且不进重试台账
      return { status: "failed", transcript: "", provider: this.name, error: `提交网络异常：${String(e?.message ?? e).slice(0, 150)}` };
    }
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
    let netFailures = 0;
    while (Date.now() < deadline) {
      await sleep(5000);
      let poll: any;
      try {
        poll = await requestUrl({
          url: `${this.baseUrl}/auc/query?appid=${encodeURIComponent(this.appId)}&token=${encodeURIComponent(this.token)}&id=${encodeURIComponent(taskId)}`,
          method: "GET",
          headers: {
            Authorization: `Bearer; ${this.token}`,
            "X-Api-App-Key": this.appId,
            "X-Api-Resource-Id": "volc.bigasr.auc",
          },
          throw: false,
        });
      } catch {
        if (++netFailures >= 5) return { status: "failed", transcript: "", provider: this.name, error: "轮询网络异常（连续多次请求失败）" };
        continue;
      }
      netFailures = 0;
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
