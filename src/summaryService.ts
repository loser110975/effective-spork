// summaryService.ts — M3 AI 摘要（对逐字稿 + 图片文字生成摘要，原文零覆盖）。
// 设计依据：delivery/系统设计.md §3.2.M3、§4.2.5；验收标准：UserStory §5.3。
// 零覆盖约束：只允许「新增/替换 frontmatter summary 属性」与「插入/原位替换摘要折叠块」，
// 严禁触碰 `[!quote]- 逐字稿` 与 `[!note]- 图片文字` 折叠块（UserStory §5.3.6 AC）。
import { App, Notice, TFile } from "obsidian";
import type { DouyinSyncSettings, SummaryRecord } from "./types";
import { extractSummarySources, upsertAbstractBlock } from "./statusCore";
import { AiClient } from "./ai";
import { generateAndWriteVideoSummary, listVideoFramePaths } from "./videoSummaryService";

export interface SummaryOutcome {
  ok: boolean;
  msg: string;
  record?: SummaryRecord;
}

function resolveKey(s: DouyinSyncSettings): string {
  return (s.aiKey || s.dashscopeKey).trim();
}

/** 对指定笔记生成摘要并写入（frontmatter 属性 + 正文摘要折叠块）。 */
export async function generateSummaryForFile(app: App, file: TFile, s: DouyinSyncSettings): Promise<SummaryOutcome> {
  if (!s.summaryEnabled) return { ok: false, msg: "AI 摘要已在设置中关闭" };
  const key = resolveKey(s);
  if (!key) return { ok: false, msg: "未配置 AI Key（设置页 → AI → API Key）" };

  const before = await app.vault.read(file);

  // 视频笔记 → 多模态通道（转录文字 + 关键帧；帧缺失时退化为纯转录，仍走视觉模型）
  // 引号无关：processFrontMatter 写回 summary 后会把 YAML 引号去掉（type: 视频）
  if (/^type:\s*"?(视频)"?\s*$/m.test(before)) {
    const douyinId = (before.match(/^douyin_id:\s*"?(\d{6,30})"?/m) ?? [])[1] ?? "";
    const framePaths = douyinId ? listVideoFramePaths(app.vault, s.mediaFolder, douyinId) : [];
    const { transcript } = extractSummarySources(before);
    const r = await generateAndWriteVideoSummary(app, file, s, {
      title: file.basename,
      transcript,
      framePaths,
    });
    return { ok: r.ok, msg: r.msg, record: r.record };
  }

  const { transcript, ocrText } = extractSummarySources(before);
  const source = [transcript, ocrText].filter((x) => x.trim()).join("\n\n").trim();
  if (!source) return { ok: false, msg: "当前笔记无可摘要的转录或图片文字" };

  const client = new AiClient(s.aiBaseUrl, key, s.aiModel, s.visionModel);
  const prompt =
    "你是笔记摘要助手。请把下面的抖音视频逐字稿与图片文字压缩成一份中文摘要，" +
    `输出 3~6 条要点，每条一行、以「- 」开头，不要任何开场白与总结语。\n\n${source.slice(0, 8000)}`;

  let summaryText = "";
  let errorCode: string | undefined;
  try {
    summaryText = await client.chat([{ role: "user", content: prompt }], s.aiModel, Math.max(200, s.summaryMaxTokens));
  } catch (e: any) {
    errorCode = "301001";
    const rec: SummaryRecord = {
      notePath: file.path,
      sourceChars: source.length,
      model: s.aiModel,
      status: "failed",
      errorCode,
      errorMessage: `摘要生成失败：${String(e?.message ?? e).slice(0, 300)}`,
      generatedAt: new Date().toISOString(),
    };
    return { ok: false, msg: `摘要生成失败：${String(e?.message ?? e).slice(0, 120)}`, record: rec };
  }

  // 写入：frontmatter 属性 + 正文摘要折叠块（原位替换，其余逐字保留）
  await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
    fm.summary = summaryText;
  });
  const after = await app.vault.read(file);
  const rewritten = upsertAbstractBlock(after, summaryText);
  await app.vault.modify(file, rewritten);

  const record: SummaryRecord = {
    notePath: file.path,
    sourceChars: source.length,
    model: s.aiModel,
    status: "success",
    generatedAt: new Date().toISOString(),
  };
  new Notice("摘要已生成（原文未改动）", 4000);
  return { ok: true, msg: "摘要已生成", record };
}

/**
 * 记录摘要结果（保留最近 50 条）。
 * 性能治理 P0-2：原为 200 条且每条含摘要全文，实测占 data.json 204KB（全文字符量 58%），
 * 而正文已有同一份摘要 → 收紧条数并停止存全文。
 */
export function pushSummaryRecord(list: SummaryRecord[] | undefined, rec: SummaryRecord): SummaryRecord[] {
  return [...(list ?? []), rec].slice(-50);
}
