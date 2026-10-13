// relatedNotes.ts — 同分类 / 同作者「相关笔记」双链互链（2026-09-27 第八轮，借鉴 Learning-Vault-Skills）。
// 纯函数三件套：候选打分（pickRelatedLinks）、块渲染（buildRelatedBlock）、幂等 upsert
// （applyRelatedToNote），供 SyncEngine 阶段接线与「重建相关笔记链接」命令共用。
// 块用 HTML 注释标记包裹，读写都只动标记区间——与摘要折叠块同一零覆盖纪律：
// 标记之外的用户内容一个字节都不动。
// HTML 注释（而非 callout）的原因：块内容是 wikilink 列表，不需要折叠渲染，
// 注释标记在阅读视图不可见、实时预览里也只占一行，对笔记观感干扰最小。

/** 互链块标记（全仓库唯一；trim 后整行匹配）。 */
export const RELATED_MARK_START = "<!-- douyin-sync:related:start -->";
export const RELATED_MARK_END = "<!-- douyin-sync:related:end -->";

/** 块标题（buildRelatedBlock 渲染、applyRelatedToNote 不感知）。 */
export const RELATED_HEAD = "## 相关笔记";

/** 互链候选：来自 metadataCache 的 frontmatter（collectRelatedCandidates 组装）。 */
export interface RelatedCandidate {
  path: string; // vault 相对路径（含 .md）
  id: string; // douyin_id
  category: string;
  author: string;
  title: string; // 链接别名
  likes: number;
}

/** 一条互链：sameCategory / sameAuthor 用于展示标签（两真则「同分类 · 同作者」）。 */
export interface RelatedLink {
  path: string;
  title: string;
  sameCategory: boolean;
  sameAuthor: boolean;
}

/**
 * 相关度打分：同分类 +2、同作者 +1，两者皆同 = 3。
 * 任一维度相同才入选（得分 0 = 不相关，直接排除）；自身按 id 与 path 双重排除
 * （改名后的旧笔记 id 相同、重建时传入的 cand 与目标可能是同一文件）。
 */
export function relatedScore(current: RelatedCandidate, cand: RelatedCandidate): number {
  if (!cand.id || cand.id === current.id || cand.path === current.path) return 0;
  const sameCategory = !!current.category && !!cand.category && current.category === cand.category;
  const sameAuthor = !!current.author && !!cand.author && current.author === cand.author;
  if (!sameCategory && !sameAuthor) return 0;
  return (sameCategory ? 2 : 0) + (sameAuthor ? 1 : 0);
}

/**
 * 选出相关笔记：得分降序 → 点赞数降序（同分时爆款优先）→ 路径字典序（确定性尾序，
 * 保证同一候选集下重复执行产出完全相同的块——幂等的前提）。
 */
export function pickRelatedLinks(
  current: RelatedCandidate,
  candidates: RelatedCandidate[],
  max: number,
): RelatedLink[] {
  const cap = Math.max(1, Math.floor(Number(max) || 0));
  return candidates
    .map((c) => ({ c, score: relatedScore(current, c) }))
    .filter((x) => x.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        (Number(b.c.likes) || 0) - (Number(a.c.likes) || 0) ||
        (a.c.path < b.c.path ? -1 : a.c.path > b.c.path ? 1 : 0),
    )
    .slice(0, cap)
    .map(({ c, score }) => ({
      path: c.path,
      title: c.title,
      sameCategory: score >= 2,
      sameAuthor: score % 2 === 1,
    }));
}

/** wikilink 别名清理：别名文本里残留 `]]` 会提前终止链接（标题来自用户内容，不可信）。 */
function safeAlias(title: string, path: string): string {
  const cleaned = String(title ?? "").replace(/[[\]]/g, "").trim();
  if (cleaned) return cleaned;
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.md$/i, "") || path;
}

/** 渲染互链块；links 为空返回空串（调用方据此移除既有块，不让空块占地方）。 */
export function buildRelatedBlock(links: RelatedLink[]): string {
  if (!links || links.length === 0) return "";
  const lines: string[] = [RELATED_MARK_START, RELATED_HEAD];
  for (const l of links) {
    const label = l.sameCategory && l.sameAuthor ? "同分类 · 同作者" : l.sameCategory ? "同分类" : "同作者";
    // 链接目标去掉 .md 扩展名（Obsidian 两种都解析，裸路径更整洁）
    lines.push(`- [[${l.path.replace(/\.md$/i, "")}|${safeAlias(l.title, l.path)}]]（${label}）`);
  }
  lines.push(RELATED_MARK_END);
  return lines.join("\n");
}

/**
 * 幂等 upsert 互链块：有标记区间则原位替换（block 为空串 = 移除整块）；
 * 无标记则插入到尾注「*同步于 … douyin-sync*」的 `---` 分隔线之前（找不到尾注则追加文件尾）。
 * 块与两侧内容之间恒为恰好一个空行——同一输入重复应用输出逐字节一致（测试守护）。
 */
export function applyRelatedToNote(markdownRaw: string, block: string): string {
  const lines = markdownRaw.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === RELATED_MARK_START);
  if (start >= 0) {
    let end = -1;
    for (let i = start + 1; i < lines.length; i++) {
      if (lines[i].trim() === RELATED_MARK_END) {
        end = i;
        break;
      }
    }
    if (end >= 0) {
      const before = lines.slice(0, start);
      const after = lines.slice(end + 1);
      // 剥掉块后紧跟的空行再统一补一个，防止重复应用时空行累加
      let k = 0;
      while (k < after.length && after[k].trim() === "") k++;
      const tail = after.slice(k);
      if (block) return [...before, ...block.split("\n"), "", ...tail].join("\n");
      // 移除：before 若以空行结尾（插入路径必然如此）正好作为与后文的分隔
      return [...before, ...tail].join("\n");
    }
    // 有头无尾（用户误删闭合标记）：块内容形态固定为「标记行 + 标题 + 连续的 - [[…]] 列表行」，
    // 残留边界按此形态保守识别——遇到第一个既非空行也非链接列表行的内容即止，其后的用户
    // 内容原样保留（第九轮 A5：旧实现从标记行清到 EOF，是全仓唯一会吞用户正文的路径）。
    // 代价：紧邻块尾的用户自建 wikilink 列表会被并入块区（罕见，可接受）。
    let stop = start + 1;
    if (lines[stop] === RELATED_HEAD) stop++;
    while (stop < lines.length && (lines[stop].trim() === "" || /^-\s*\[\[/.test(lines[stop].trim()))) stop++;
    const before = lines.slice(0, start);
    const after = lines.slice(stop);
    // 剥掉块后紧跟的空行再统一补一个，防止重复应用时空行累加（与「有头有尾」分支同口径）
    let k = 0;
    while (k < after.length && after[k].trim() === "") k++;
    const tail = after.slice(k);
    if (block) return [...before, ...block.split("\n"), "", ...tail].join("\n");
    // 移除：before 若以空行结尾（插入路径必然如此）正好作为与后文的分隔
    return [...before, ...tail].join("\n");
  }
  if (!block) return markdownRaw;

  // 插入：定位尾注行，向前吞掉紧邻空行与其上的 `---` 分隔线，插到分隔线之前
  const FOOTER_RE = /^\*同步于 .*douyin-sync\*$/;
  let cut = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (FOOTER_RE.test(lines[i].trim())) {
      let j = i - 1;
      while (j >= 0 && lines[j].trim() === "") j--;
      if (j >= 0 && lines[j].trim() === "---") {
        j--;
        while (j >= 0 && lines[j].trim() === "") j--;
        cut = j + 1;
      }
      break;
    }
  }
  const head = cut >= 0 ? lines.slice(0, cut) : [...lines];
  while (head.length > 0 && head[head.length - 1].trim() === "") head.pop();
  const tail = cut >= 0 ? lines.slice(cut) : [];
  let s = 0;
  while (s < tail.length && tail[s].trim() === "") s++;
  const tail2 = tail.slice(s);
  return [...head, "", ...block.split("\n"), "", ...tail2].join("\n");
}
