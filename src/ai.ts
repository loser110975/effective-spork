import { requestUrl, type RequestUrlParam } from "obsidian";
import { sleep } from "./util";

/** 单次 AI 请求默认超时：多模态请求（大量图片 base64）远超 Obsidian 内部默认 30s，故显式放大。 */
const DEFAULT_TIMEOUT_MS = 120_000;
/** 429 限流退避：免费/flash 档模型（如 glm-4.6v-flash）高峰期会整段 429，重试 3 次可救回大部分。 */
const RATE_LIMIT_BACKOFF_MS = [5_000, 15_000, 30_000];
/** 5xx 服务端过载（如硅基流动 503 + code 50508）单独一套退避：过载恢复通常更快，先短等。 */
const SERVER_BUSY_BACKOFF_MS = [3_000, 10_000, 20_000];

/** OpenAI 兼容 Chat Completions（适配百炼 compatible-mode / 硅基流动 / OpenAI 等）。 */
export class AiClient {
  private visionModel: string;
  private timeoutMs = DEFAULT_TIMEOUT_MS;

  constructor(
    private baseUrl: string,
    private key: string,
    private model: string,
    visionModel: string = "qwen-vl-plus",
  ) {
    this.visionModel = visionModel;
  }

  /** 设置请求超时（毫秒），下限 5s（问题 5）。 */
  setTimeoutMs(ms: number): void {
    this.timeoutMs = Math.max(5_000, ms);
  }

  private endpoint(): string {
    const base = this.baseUrl.replace(/\/+$/, "");
    return /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`;
  }

  async chat(messages: any[], model?: string, maxTokens = 500): Promise<string> {
    if (!this.key) throw new Error("AI Key 未配置");
    let attempt = 0;
    let busyAttempt = 0;
    let tokens = maxTokens;
    let tokensClamped = false;
    for (;;) {
      let res;
      try {
        // obsidian 的 RequestUrlParam 类型未声明 timeout 字段（ARCHITECTURE.md §3.5 已记录），
        // 但运行时支持——这里显式传入并收窄类型，避免多模态大请求被默认 30s 掐断（问题 5）。
        res = await requestUrl({
          url: this.endpoint(),
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.key}` },
          body: JSON.stringify({
            model: model || this.model,
            messages,
            max_tokens: tokens,
            temperature: 0.2,
          }),
          throw: false,
          timeout: this.timeoutMs,
        } as RequestUrlParam & { timeout: number });
      } catch (e: any) {
        const m = String(e?.message ?? e);
        if (/timed?\s*out|timeout|abort/i.test(m)) {
          throw new Error(`AI 请求超时（${Math.round(this.timeoutMs / 1000)}s）：${m.slice(0, 120)}`);
        }
        throw e;
      }
      // 429 限流：指数退避重试（实测 glm-4.6v-flash 高峰期整段 429/1305，重试可救回大部分）
      if (res.status === 429 && attempt < RATE_LIMIT_BACKOFF_MS.length) {
        await sleep(RATE_LIMIT_BACKOFF_MS[attempt++]);
        continue;
      }
      // 5xx 服务端过载：同样退避重试（过载是瞬时的，重试收益高于直接放弃）
      // 实测（2026-09-19）：硅基流动视觉模型高峰期返回 503 {"code":50508,"message":"System is too busy now"}，
      // 原实现只重试 429 → 503 直接判失败：全量 137 张图里有 12 张因此永久丢掉识别结果。
      if (res.status >= 500 && busyAttempt < SERVER_BUSY_BACKOFF_MS.length) {
        await sleep(SERVER_BUSY_BACKOFF_MS[busyAttempt++]);
        continue;
      }
      // 部分通道的 max_tokens 上限很低（如智谱 glm-4v-flash 仅支持 [1,1024]，超限报 400/1210）：
      // 收敛到 1024 后重试一次，避免整条摘要因参数上限而失败。
      if (res.status === 400 && !tokensClamped && /max_tokens/i.test(res.text)) {
        tokensClamped = true;
        tokens = Math.min(tokens, 1024);
        continue;
      }
      if (res.status >= 300) {
        throw new Error(`AI HTTP ${res.status}: ${res.text.slice(0, 200)}`);
      }
      const data: any = res.json;
      const text = data?.choices?.[0]?.message?.content;
      if (typeof text !== "string" || !text.trim()) {
        throw new Error(`AI 返回为空: ${res.text.slice(0, 200)}`);
      }
      return text.trim();
    }
  }

  /** 从给定分类列表中挑一个。 */
  async categorize(categories: string[], title: string, desc: string, transcriptExcerpt: string): Promise<string> {
    const prompt =
      `你是内容分类器。从下面的分类列表中选一个最贴切的，只输出分类名称本身，不要任何其他文字。\n\n` +
      `分类列表：\n${categories.map((c) => `- ${c}`).join("\n")}\n\n` +
      `标题：${title}\n描述：${desc.slice(0, 300)}\n` +
      (transcriptExcerpt ? `逐字稿摘录：${transcriptExcerpt.slice(0, 800)}\n` : "");
    const out = await this.chat([{ role: "user", content: prompt }], this.model, 50);
    const clean = out.replace(/["'「」\s]/g, "");
    const hit = categories.find((c) => clean.includes(c));
    return hit ?? categories[0] ?? "未分类";
  }

  /** 多图视觉调用：images 传 URL 或 data:base64，按传入顺序对应提示词中的序号。 */
  async chatVision(prompt: string, images: string[], model?: string, maxTokens = 1200): Promise<string> {
    const content: any[] = images.map((url) => ({ type: "image_url", image_url: { url } }));
    content.push({ type: "text", text: prompt });
    const out = await this.chat([{ role: "user", content }], model || this.visionModel, maxTokens);
    return out.replace(/^```[a-z]*\n?|```$/g, "").trim();
  }

  /** 视觉模型识别图片中的文字。image 传 URL 或 data:base64。 */
  async ocrImage(image: string, hint: string): Promise<string> {
    const prompt =
      `识别这张图片中的所有文字内容（字幕、口播字幕、标题、图表文字等），按阅读顺序输出纯文本。` +
      `没有文字则描述图片内容（20字以内）。只输出结果本身。` +
      (hint ? `\n上下文提示：${hint.slice(0, 100)}` : "");
    const out = await this.chat(
      [
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: image } },
            { type: "text", text: prompt },
          ],
        },
      ],
      this.visionModel,
      800,
    );
    return out.replace(/^```[a-z]*\n?|```$/g, "").trim();
  }

  setVisionModel(m: string) {
    this.visionModel = m;
  }
}
