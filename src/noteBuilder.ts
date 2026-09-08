import { SyncItem } from "./types";
import { SOURCE_LABEL } from "./types";
import { AsrResult } from "./types";
import { isoFromUnix, localDate, mmss, yamlStr, fmtDuration } from "./util";

export interface NoteContentInput {
  item: SyncItem;
  folder: string; // 收藏夹名 / "" 
  category: string;
  coverPath: string; // vault 相对路径，空=未下载
  imagePathPrefix: string; // Media 下本条目的图片目录
  imagesDownloaded: string[]; // 已下载的 vault 相对路径
  visionTexts: { index: number; text: string; status: string }[];
  asr: AsrResult | null;
  syncedAt: string;
}

export function planNotePath(
  root: string,
  item: SyncItem,
  folder: string,
  title: string,
): string {
  const parts = [root];
  if (item.source === "collection") {
    parts.push("收藏", folder || "未分类");
  } else {
    parts.push(SOURCE_LABEL[item.source]);
  }
  const date = localDate(item.createTime) || localDate(Math.floor(Date.now() / 1000));
  const file = `${date} ${title} [${item.id}]`.replace(/\s+/g, " ");
  parts.push(file);
  return parts.join("/") + ".md";
}

function callout(lines: string[], type = "quote", title = "逐字稿", fold = true): string {
  const head = `> [!${type}]${fold ? "-" : "+"} ${title}`;
  const body = lines.map((l) => `> ${l.replace(/^>+\s*/, "＞ ")}`);
  return [head, ...body].join("\n");
}

export function buildNote(input: NoteContentInput): string {
  const { item, folder, category, coverPath, imagesDownloaded, visionTexts, asr, syncedAt } = input;
  const typeLabel = item.type === "note" ? "图文" : "视频";
  const sourceLabel = SOURCE_LABEL[item.source];
  const shareUrl =
    item.type === "note" ? `https://www.douyin.com/note/${item.id}` : `https://www.douyin.com/video/${item.id}`;

  const fm: string[] = [
    "---",
    `douyin_id: ${yamlStr(item.id)}`,
    `title: ${yamlStr(item.title)}`,
    `type: ${yamlStr(typeLabel)}`,
    `source: ${yamlStr(sourceLabel)}`,
  ];
  if (item.source === "collection") fm.push(`folder: ${yamlStr(folder || "未分类")}`);
  fm.push(
    `author: ${yamlStr(item.author)}`,
    `published: ${yamlStr(isoFromUnix(item.createTime))}`,
    `category: ${yamlStr(category)}`,
    `url: ${yamlStr(shareUrl)}`,
  );
  if (item.durationSec > 0) fm.push(`duration: ${yamlStr(fmtDuration(item.durationSec))}`);
  if (coverPath) fm.push(`cover: ${yamlStr(coverPath)}`);
  fm.push(`likes: ${item.stats.likes}`);
  fm.push(
    `stats:`,
    `  likes: ${item.stats.likes}`,
    `  comments: ${item.stats.comments}`,
    `  collects: ${item.stats.collects}`,
    `  shares: ${item.stats.shares}`,
  );
  if (asr) {
    fm.push(`transcript_provider: ${yamlStr(asr.provider ?? "")}`);
    fm.push(`transcript_status: ${yamlStr(asr.status)}`);
  } else {
    fm.push(`transcript_status: ${item.type === "video" ? "not_requested" : "not_applicable"}`);
  }
  fm.push(`tags:`, `  - 抖音`, `  - ${sourceLabel}`, "---", "");

  // 正文
  fm.push(`# ${item.title}`, "");
  const meta: string[] = [];
  if (item.author) meta.push(`作者：**${item.author}**`);
  meta.push(`来源：${sourceLabel}${item.source === "collection" && folder ? `（${folder}）` : ""}`);
  meta.push(`[原视频链接](${shareUrl})`);
  fm.push(meta.join(" ｜ "), "");
  if (item.desc && item.desc !== item.title) {
    fm.push(item.desc, "");
  }

  // 图片（图文笔记）
  if (item.type === "note" && imagesDownloaded.length > 0) {
    fm.push("## 图片", "");
    for (const p of imagesDownloaded) {
      fm.push(`![[${p}]]`, "");
    }
  }

  // 图片文字识别（折叠块）
  if (item.type === "note" && visionTexts.length > 0) {
    const lines: string[] = [];
    for (const v of visionTexts) {
      lines.push(`**图 ${v.index}**（${v.status}）`);
      lines.push("");
      lines.push(v.text || "（无文字）");
      lines.push("");
    }
    fm.push(callout(lines, "note", "图片文字", true), "");
  }

  // 逐字稿（折叠块）
  if (item.type === "video") {
    if (asr && asr.status === "success" && asr.transcript) {
      const lines: string[] = [];
      if (asr.segments && asr.segments.length > 0) {
        for (const seg of asr.segments) {
          lines.push(`\`${mmss(seg.beginSec)}\` ${seg.text}`);
        }
      } else {
        // 长文本按 800 字切段落，避免 callout 单行过长
        for (let i = 0; i < asr.transcript.length; i += 800) {
          lines.push(asr.transcript.slice(i, i + 800));
        }
      }
      fm.push(callout(lines, "quote", `逐字稿（${asr.provider ?? "ASR"}）`, true), "");
    } else if (asr && asr.status !== "success") {
      fm.push(callout([`转写未成功：${asr.error ?? asr.status}`, `可在设置中配置 ASR 后用命令「重试失败转写」重试。`], "warning", "逐字稿", true), "");
    } else {
      fm.push(callout(["未启用转写：在插件设置中选择 ASR 服务商并填入 Key。", "说明：以下为视频文案（非逐字稿）。"], "info", "逐字稿", true), "");
      if (item.desc) fm.push(item.desc, "");
    }
  }

  fm.push("---", "");
  fm.push(
    `*同步于 ${syncedAt} ｜ douyin-sync*`,
    "",
  );
  return fm.join("\n");
}
