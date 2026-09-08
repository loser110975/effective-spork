import { requestUrl } from "obsidian";

/** OpenAI 兼容 Chat Completions（适配百炼 compatible-mode / 硅基流动 / OpenAI 等）。 */
export class AiClient {
  private visionModel: string;

  constructor(
    private baseUrl: string,
    private key: string,
    private model: string,
    visionModel: string = "qwen-vl-plus",
  ) {
    this.visionModel = visionModel;
  }

  private endpoint(): string {
    const base = this.baseUrl.replace(/\/+$/, "");
    return /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`;
  }

  async chat(messages: any[], model?: string, maxTokens = 500): Promise<string> {
    if (!this.key) throw new Error("AI Key 未配置");
    const res = await requestUrl({
      url: this.endpoint(),
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.key}` },
      body: JSON.stringify({
        model: model || this.model,
        messages,
        max_tokens: maxTokens,
        temperature: 0.2,
      }),
      throw: false,
    });
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
