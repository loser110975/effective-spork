import { SyncItem, SOURCE_LABEL, AsrResult } from "./types";
import { isoFromUnix, localDate, mmss, yamlStr, fmtDuration, sanitizeFilename } from "./util";

export interface NoteContentInput {
  item: SyncItem;
  folder: string; // 收藏夹名 / ""
  category: string;
  coverPath: string; // vault 相对路径，空=未下载
  imagesDownloaded: string[]; // 已下载的 vault 相对路径
  visionTexts: { index: number; text: string; status: string }[];
  asr: AsrResult | null;
  framePaths: string[]; // 视频关键帧（vault 相对路径，时间顺序）；图文类为空
  keyframeIntervalSec: number; // 本次抽帧使用的间隔设置（写入 frontmatter frame_interval，供补跑判断）
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
    // 收藏夹名来自抖音 API，直接进文件系统路径（2026-09-27 修）：含 /\:*?" 等字符会让整条收藏夹同步报错
    parts.push("收藏", sanitizeFilename(folder, 40) || "未分类");
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
  // 行首 `[!` 全角化（2026-09-27 第四轮）：转录/OCR 文本行以 `[!` 开头时，写入会成为
  // 折叠块内嵌 callout 头，读取侧据此提前断块（重建时尾部内容丢失），与 statusCore 同策略。
  // 带缩进的变体同样要转（第六轮），判据口径见 statusCore.calloutLine
  const body = lines.map((l) => `> ${l.replace(/^>+\s*/, "＞ ").replace(/^(\s*)\[!/, "$1[！")}`);
  return [head, ...body].join("\n");
}

export function buildNote(input: NoteContentInput): string {
  const { item, folder, category, coverPath, imagesDownloaded, visionTexts, asr, framePaths, keyframeIntervalSec, syncedAt } = input;
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
  if (item.type === "video" && keyframeIntervalSec > 0) {
    fm.push(`frame_interval: ${keyframeIntervalSec}`);
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
      // status 含换行时单行正则失配（错误信息可能多行）：压成一行（2026-09-27 第四轮）
      lines.push(`**图 ${v.index}**（${String(v.status).replace(/\r?\n/g, " ")}）`);
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
          // 段内换行同样要拆行（复审 P2）：裸行无 `>` 前缀会让 extractCallout 提前断块，
          // 重试重建经 asrOverride 复用时该行之后的逐字稿全部丢失
          const segLines = String(seg.text ?? "").split(/\r?\n/);
          lines.push(`\`${mmss(seg.beginSec)}\` ${segLines[0]}`);
          for (let k = 1; k < segLines.length; k++) lines.push(segLines[k]);
        }
      } else {
        // 长文本按 800 字切段落，避免 callout 单行过长；
        // 2026-09-27：按码点切（Array.from）——原 slice 按 UTF-16 code unit 会把 emoji 代理对劈成乱码；
        // 切完再按换行拆行——转录文本内嵌的换行若留在同一物理行里，行首 `>` 会逃过 callout 的转义
        const chars = Array.from(asr.transcript);
        for (let i = 0; i < chars.length; i += 800) {
          lines.push(...chars.slice(i, i + 800).join("").split(/\r?\n/));
        }
      }
      fm.push(callout(lines, "quote", `逐字稿（${asr.provider ?? "ASR"}）`, true), "");
    } else if (asr && asr.status === "unavailable") {
      // 结构上无内容可转（无视频轨的音频类条目 / 无对白）：信息块，不提示重试（重试无意义）
      fm.push(
        callout([`未转写：${asr.error ?? "无可转写内容"}`, `该项在抖音侧没有可供转写的语音内容。`], "info", "逐字稿", true),
        "",
      );
    } else if (asr && asr.status !== "success") {
      fm.push(callout([`转写未成功：${asr.error ?? asr.status}`, `可在设置中配置 ASR 后用命令「重试失败转写」重试。`], "warning", "逐字稿", true), "");
    } else {
      fm.push(callout(["未启用转写：在插件设置中选择 ASR 服务商并填入 Key。", "说明：以下为视频文案（非逐字稿）。"], "info", "逐字稿", true), "");
      if (item.desc) fm.push(item.desc, "");
    }
  }

  // 关键帧（视频笔记）：抽帧成功时嵌入全部帧图，折叠避免干扰阅读；摘要未生成时帧也不丢失
  if (item.type === "video" && framePaths.length > 0) {
    fm.push(callout(framePaths.map((p) => `![[${p}]]`), "note", `关键帧（${framePaths.length} 张）`, true), "");
  }

  fm.push("---", "");
  fm.push(
    `*同步于 ${syncedAt} ｜ douyin-sync*`,
    "",
  );
  return fm.join("\n");
}
