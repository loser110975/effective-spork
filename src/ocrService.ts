// ocrService.ts — M2 图片 OCR（Agnes 主通道 + 显式确认后的付费兜底 + 结果展示 / 复制 / 导出）。
// 设计依据：delivery/系统设计.md §3.2.M2、§4.2.4；验收标准：UserStory §5.2。
// 关键约束：主通道失败**不自动回退**，必须弹确认、经用户同意才调用付费通道（经中间确认）。
import { App, Modal, Notice, TFile } from "obsidian";
import type { DouyinSyncSettings } from "./types/settings";
import type { VisionRecord } from "./types/state";
import { appendOcrToNoteCallout, imageMimeFromName } from "./statusCore";
import { AiClient } from "./ai";
import { resolveOcrPanelChannel } from "./aiConfig";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 大小上限（超出直接拒绝，不发起模型调用）

/** 魔数白名单校验（防扩展名伪装）。 */
function magicOk(bytes: Uint8Array, mime: string): boolean {
  const b = bytes;
  if (mime === "image/png") return b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
  if (mime === "image/jpeg") return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  if (mime === "image/gif") return b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46;
  if (mime === "image/webp") return b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50;
  return false;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CH)) as any);
  return btoa(bin);
}

export interface OcrOutcome {
  ok: boolean;
  text: string;
  channel: "primary" | "fallback";
  /** 实际使用的模型名（展示用：付费确认弹窗与结果框不再硬编码模型名） */
  modelUsed?: string;
  errorCode?: string;
  /** 具体失败原因（如 Base URL / API Key 未配置），供界面直接展示 */
  error?: string;
  elapsedMs: number;
  imagePath: string;
  declinedFallback?: boolean;
}

/** 选择本地图片（点击选择 + 拖拽，见 UserStory §5.2.2 交互方式）。 */
export function pickImageFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/webp,image/gif";
    input.style.display = "none";
    input.onchange = () => resolve(input.files?.[0] ?? null);
    // 用户取消时无 change 事件：焦点回归后短暂等待后按取消处理
    window.addEventListener("focus", () => setTimeout(() => resolve(input.files?.[0] ?? null), 300), { once: true });
    document.body.appendChild(input);
    input.click();
    setTimeout(() => input.remove(), 60_000);
  });
}

/** 读取并校验图片 → data URL（格式 + 大小 + 魔数三重校验，见 UserStory §5.2.6 异常路径）。 */
export async function readImageAsDataUrl(file: File): Promise<{ dataUrl?: string; error?: string }> {
  const mime = file.type || imageMimeFromName(file.name) || "";
  if (!mime || !mime.startsWith("image/")) return { error: "不支持的图片格式（仅支持 PNG / JPEG / WebP / GIF）" };
  if (file.size > MAX_IMAGE_BYTES) return { error: `图片超出大小上限（${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)}MB）` };
  const buf = new Uint8Array(await file.arrayBuffer());
  if (!magicOk(buf, mime)) return { error: "图片内容与扩展名不符（魔数校验未通过）" };
  return { dataUrl: `data:${mime};base64,${bytesToBase64(buf)}` };
}

/** 调用一次视觉模型（OpenAI 兼容）。channel 决定用 Agnes 主通道还是兜底通道。 */
async function callVision(s: DouyinSyncSettings, channel: "primary" | "fallback", dataUrl: string, hint: string): Promise<{ ok: boolean; text?: string; errorCode?: string; error?: string }> {
  // 统一接入：Base URL + API Key 由 aiConfig 从 settings 解析（含 Agnes 主通道 → AI Key 回退链）
  const chan = resolveOcrPanelChannel(s, channel);
  const model = channel === "primary" ? s.ocrModelPrimary : s.ocrModelFallback;
  // 配置缺失 / 无效：明确给出原因（保持 201001 错误码语义不变）
  if (chan.problem) return { ok: false, errorCode: "201001", error: chan.problem };
  const client = new AiClient(chan.baseUrl, chan.apiKey, model, model);
  try {
    const text = await client.ocrImage(dataUrl, hint);
    return { ok: true, text };
  } catch (e: any) {
    const m = String(e?.message ?? e);
    return { ok: false, errorCode: /429|rate|限流/i.test(m) ? "201002" : "201001", error: m.slice(0, 200) };
  }
}

/** 主通道 OCR；失败时按 ocrFallbackEnabled 走「显式确认 → 付费兜底」。 */
export async function ocrWithFallback(s: DouyinSyncSettings, dataUrl: string, imagePath: string, hint: string): Promise<OcrOutcome> {
  const started = Date.now();
  const primary = await callVision(s, "primary", dataUrl, hint);
  if (primary.ok) {
    return { ok: true, text: primary.text ?? "", channel: "primary", modelUsed: s.ocrModelPrimary, elapsedMs: Date.now() - started, imagePath };
  }
  if (!s.ocrFallbackEnabled) {
    return { ok: false, text: "", channel: "primary", modelUsed: s.ocrModelPrimary, errorCode: primary.errorCode, error: primary.error, elapsedMs: Date.now() - started, imagePath };
  }
  const approved = await confirmFallback(s);
  if (!approved) {
    // 取消路径：不发起任何付费调用（UserStory §5.2.6 新增 AC）
    return { ok: false, text: "", channel: "primary", modelUsed: s.ocrModelPrimary, errorCode: primary.errorCode, error: primary.error, elapsedMs: Date.now() - started, imagePath, declinedFallback: true };
  }
  const fb = await callVision(s, "fallback", dataUrl, hint);
  if (fb.ok) {
    return { ok: true, text: fb.text ?? "", channel: "fallback", modelUsed: s.ocrModelFallback, elapsedMs: Date.now() - started, imagePath };
  }
  return {
    ok: false,
    text: "",
    channel: "fallback",
    modelUsed: s.ocrModelFallback,
    errorCode: fb.errorCode ?? primary.errorCode,
    error: fb.error ?? primary.error,
    elapsedMs: Date.now() - started,
    imagePath,
  };
}

/** 付费兜底确认弹窗：计费对象用实际配置的模型与端点（2026-09-27 修：不再硬编码「百炼 qwen3-vl-plus」）。 */
function confirmFallback(s: DouyinSyncSettings): Promise<boolean> {
  const chan = resolveOcrPanelChannel(s, "fallback");
  const target = `${s.ocrModelFallback}（${chan.baseUrl || "未配置端点"}）`;
  return new Promise((resolve) => {
    class ConfirmModal extends Modal {
      onOpen() {
        this.contentEl.createEl("p", { text: "识别失败，是否改用付费通道重试？" });
        this.contentEl.createEl("p", {
          cls: "mod-muted",
          text: `将调用 ${target}（按 token 计费）。取消则不发起任何付费调用。`,
        });
        const row = this.contentEl.createDiv();
        row.style.display = "flex";
        row.style.gap = "8px";
        row.style.justifyContent = "flex-end";
        // resolve 必须在 close() 之前（2026-09-27 第四轮修）：Modal.close() 会同步触发 onClose，
        // 原先「先 close 再 resolve(true)」的确认按钮被 onClose 的 resolve(false) 抢先落定——
        // 用户明确点了「使用付费通道重试」，实际却按取消处理，付费兜底通道形同虚设
        row.createEl("button", { text: "取消" }).onclick = () => {
          resolve(false);
          this.close();
        };
        row.createEl("button", { cls: "mod-cta", text: "使用付费通道重试" }).onclick = () => {
          resolve(true);
          this.close();
        };
      }
      onClose() {
        resolve(false);
      }
    }
    void new ConfirmModal(app0).open();
  });
}

/** 供 Modal 使用的 App 引用（由 main.ts 注入，避免与 main.ts 形成循环依赖）。 */
let app0: App;
export function setOcrApp(app: App): void {
  app0 = app;
}

/** 记录 OCR 结果（保留最近 200 条，见 安全设计 §3.3.5 数据最小化）。 */
export function pushVisionRecord(list: VisionRecord[] | undefined, rec: VisionRecord): VisionRecord[] {
  const next = [...(list ?? []), rec];
  return next.slice(-200);
}

/** 识别结果展示：可编辑文本区 + 复制 + 导出到当前笔记（UserStory §5.2.3）。 */
export class OcrResultModal extends Modal {
  constructor(
    app: App,
    private text: string,
    private channel: "primary" | "fallback",
    private modelUsed = "",
  ) {
    super(app);
  }

  onOpen(): void {
    this.contentEl.empty();
    this.contentEl.createEl("h4", { text: "图片文字识别结果" });
    const label = this.modelUsed || (this.channel === "primary" ? "主通道" : "付费兜底");
    this.contentEl.createDiv({ cls: "mod-muted" }).setText(
      this.channel === "primary" ? `通道：${label}（主）` : `通道：${label}（付费兜底，已确认）`,
    );
    const box = this.contentEl.createEl("textarea");
    box.value = this.text;
    box.style.width = "100%";
    box.style.minHeight = "180px";
    const row = this.contentEl.createDiv();
    row.style.display = "flex";
    row.style.gap = "8px";
    row.style.justifyContent = "flex-end";
    row.createEl("button", { text: "复制" }).onclick = async () => {
      await navigator.clipboard.writeText(this.text);
      new Notice("已复制到剪贴板", 2000);
    };
    row.createEl("button", { cls: "mod-cta", text: "导出到当前笔记" }).onclick = async () => {
      const f = this.app.workspace.getActiveFile();
      if (!f || !(f instanceof TFile)) {
        new Notice("请先打开一篇笔记再导出");
        return;
      }
      // vault.process 原子写（2026-09-27 第四轮）：原 read→modify 两段写之间，自动同步的
      // vault.process 写入会被陈旧快照整体覆盖（与摘要写入同类竞态，statusCore 已修过一次）。
      // 内容包上 `**图 1**（手动导出）` 分段头：collectExistingAssets 只认该头归属图片段落，
      // 裸文本会被重试重建静默丢弃
      const wrapped = `**图 1**（手动导出）\n\n${this.text}`;
      let changed = false;
      await this.app.vault.process(f, (data) => {
        const out = appendOcrToNoteCallout(data, wrapped);
        changed = out !== data;
        return out;
      });
      new Notice(changed ? "已追加到当前笔记「图片文字」折叠块（原文未改动）" : "内容已存在，未重复追加");
      this.close();
    };
  }
}
