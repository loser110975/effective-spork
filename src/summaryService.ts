// summaryService.ts — M3 AI 摘要（对逐字稿 + 图片文字生成摘要，原文零覆盖）。
// 设计依据：delivery/系统设计.md §3.2.M3、§4.2.5；验收标准：UserStory §5.3。
// 零覆盖约束：只允许「新增/替换 frontmatter summary 属性」与「插入/原位替换摘要折叠块」，
// 严禁触碰 `[!quote]- 逐字稿` 与 `[!note]- 图片文字` 折叠块（UserStory §5.3.6 AC）。
import { App, Notice, TFile } from "obsidian";
import type { DouyinSyncSettings, SummaryRecord } from "./types";
import { extractSummarySources, applySummaryToNote, frontmatterBlock } from "./statusCore";
import { AiClient } from "./ai";
import { resolveAiChannel } from "./aiConfig";
import { sliceByCodePoints } from "./util";
import { generateAndWriteVideoSummary, listVideoFramePaths } from "./videoSummaryService";

export interface SummaryOutcome {
  ok: boolean;
  msg: string;
  record?: SummaryRecord;
}

/** 对指定笔记生成摘要并写入（frontmatter 属性 + 正文摘要折叠块）。 */
export async function generateSummaryForFile(app: App, file: TFile, s: DouyinSyncSettings): Promise<SummaryOutcome> {
  if (!s.summaryEnabled) return { ok: false, msg: "AI 摘要已在设置中关闭" };

  const before = await app.vault.read(file);

  // 视频笔记 → 多模态通道（转录文字 + 关键帧；帧缺失时退化为纯转录，仍走视觉模型）
  // 引号无关：processFrontMatter 写回 summary 后会把 YAML 引号去掉（type: 视频）。
  // 先切 frontmatter 区间再匹配（2026-09-27 修）：直接对整篇 /m 匹配，正文出现同名行会劫持分支
  if (/^type:\s*"?(视频)"?\s*$/m.test(frontmatterBlock(before))) {
    // douyin_id 同样先切 frontmatter 区间（2026-09-27 第四轮）：整篇 /m 匹配时正文里的
    // `douyin_id: …` 行（逐字稿/OCR 文本/粘贴内容）会劫持帧目录定位——最坏取到另一条视频的
    // 帧目录，把别的视频画面送进本条的摘要提示词
    const douyinId = (frontmatterBlock(before).match(/^douyin_id:\s*"?(\d{6,30})"?/m) ?? [])[1] ?? "";
    const framePaths = douyinId ? listVideoFramePaths(app.vault, s.mediaFolder, douyinId) : [];
    const { transcript } = extractSummarySources(before);
    const r = await generateAndWriteVideoSummary(app, file, s, {
      title: file.basename,
      transcript,
      framePaths,
    });
    return { ok: r.ok, msg: r.msg, record: r.record };
  }

  // 文本通道预检移到类型分支之后（第六轮，复审 P1 收尾）：视频路径走专用多模态通道
  //（generateAndWriteVideoSummary 自行解析并校验 resolveVideoSummaryChannel），
  // 只配专用 Key 的用户此前被文本通道的「AI API Key 未配置」挡死，手动摘要静默失败
  const chan = resolveAiChannel(s);
  if (chan.problem) return { ok: false, msg: chan.problem };

  const { transcript, ocrText } = extractSummarySources(before);
  const source = [transcript, ocrText].filter((x) => x.trim()).join("\n\n").trim();
  if (!source) return { ok: false, msg: "当前笔记无可摘要的转录或图片文字" };

  const client = new AiClient(chan.baseUrl, chan.apiKey, s.aiModel, s.visionModel);
  const prompt =
    "你是笔记摘要助手。请把下面的抖音视频逐字稿与图片文字压缩成一份中文摘要，" +
    `输出 3~6 条要点，每条一行、以「- 」开头，不要任何开场白与总结语。\n\n${sliceByCodePoints(source, 8000)}`;

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

  // 单次 vault.process 原子写（2026-09-27 修）：frontmatter summary 与正文摘要折叠块一次变换完成，
  // 消除两次全文件写之间用户编辑被陈旧快照覆盖的竞态窗口。
  await app.vault.process(file, (data) => applySummaryToNote(data, summaryText));

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
