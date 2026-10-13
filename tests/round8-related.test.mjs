// 第八轮纯函数 + 引擎级测试（2026-09-27）：相关笔记互链（relatedNotes / upsertFmScalar /
// 摘要风格预设 buildPrompt）+ SyncEngine.refreshAllRelatedNotes 全链路（MiniVault + metadataCache 替身）。
import assert from "node:assert/strict";

// ---------- 引擎级测试替身 ----------

/** 内存 Vault：仅 refreshAllRelatedNotes / collectRelatedCandidates 需要的最小面。 */
class MiniVault {
  constructor(TFile) {
    this.TFile = TFile;
    this.files = new Map(); // path -> string
  }
  makeFile(path) {
    const f = new this.TFile();
    f.path = path;
    f.name = path.slice(path.lastIndexOf("/") + 1);
    f.basename = f.name.replace(/\.[^.]+$/, "");
    f.stat = { size: 0, mtime: 0 };
    return f;
  }
  getAbstractFileByPath(p) {
    const path = String(p ?? "").replace(/\\/g, "/");
    return this.files.has(path) ? this.makeFile(path) : null;
  }
  getMarkdownFiles() {
    return [...this.files.keys()].map((k) => this.makeFile(k));
  }
  async read(file) {
    const p = file.path ?? file;
    if (!this.files.has(p)) throw new Error(`read: 不存在 ${p}`);
    return this.files.get(p);
  }
  async process(file, fn) {
    const p = file.path ?? file;
    if (!this.files.has(p)) throw new Error(`process: 不存在 ${p}`);
    const next = await fn(this.files.get(p));
    if (typeof next === "string") this.files.set(p, next);
    return this.files.get(p);
  }
}

function makeNote(id, { category, author, title, likes = 0, body = "正文" }) {
  return [
    "---",
    `douyin_id: ${JSON.stringify(id)}`,
    `title: ${JSON.stringify(title)}`,
    `category: ${JSON.stringify(category)}`,
    `author: ${JSON.stringify(author)}`,
    `likes: ${likes}`,
    "---",
    "",
    `# ${title}`,
    "",
    body,
    "",
    "---",
    "",
    "*同步于 2026-09-27T00:00:00.000Z ｜ douyin-sync*",
    "",
  ].join("\n");
}

function makeEngine(m, vault, fmByPath, settingsOver = {}) {
  const settings = {
    ...m.DEFAULT_SETTINGS,
    rootFolder: "抖音",
    relatedNotesEnabled: true,
    relatedNotesMax: 8,
    ...settingsOver,
  };
  const app = {
    vault,
    // 形状对齐真实 Obsidian：getFileCache(f).frontmatter 才是 frontmatter 对象
    metadataCache: { getFileCache: (f) => (fmByPath[f.path] ? { frontmatter: fmByPath[f.path] } : null) },
  };
  return new m.SyncEngine(app, settings, async () => {}, () => {});
}

// ---------- 用例 ----------

export function runTests(m) {
  let pass = 0;
  let fail = 0;
  const t = (name, ok) => {
    if (ok) {
      pass++;
      console.log("  ✓ " + name);
    } else {
      fail++;
      console.log("  ✗ " + name);
    }
  };

  const asyncChecks = async () => {
    const {
      applyRelatedToNote,
      buildRelatedBlock,
      pickRelatedLinks,
      relatedScore,
      upsertFmScalar,
      RELATED_MARK_START,
      RELATED_MARK_END,
      buildPrompt,
    } = m;

    console.log("— applyRelatedToNote：插入 / 幂等 / 替换 / 移除 —");
    {
      const note = makeNote("a1", { category: "成长学习", author: "张三", title: "笔记A" });
      const block = buildRelatedBlock([
        { path: "抖音/收藏/成长学习/笔记B.md", title: "笔记B", sameCategory: true, sameAuthor: false },
      ]);
      const once = applyRelatedToNote(note, block);
      t("无块笔记插入块（尾注分隔线之前）", once.includes(RELATED_MARK_START) && once.indexOf(RELATED_MARK_START) < once.lastIndexOf("---"));
      t("尾注仍在文件末尾", once.trimEnd().endsWith("*同步于 2026-09-27T00:00:00.000Z ｜ douyin-sync*"));
      const twice = applyRelatedToNote(once, block);
      t("重复应用逐字节一致（幂等）", twice === once);
      const prefix = once.slice(0, once.indexOf(RELATED_MARK_START)).trimEnd();
      const origHead = note.slice(0, note.lastIndexOf("\n---\n")).trimEnd();
      t("块之前的内容逐字节保留", prefix === origHead);

      const block2 = buildRelatedBlock([
        { path: "抖音/收藏/投资理财/笔记C.md", title: "笔记C", sameCategory: false, sameAuthor: true },
        { path: "抖音/收藏/成长学习/笔记B.md", title: "笔记B", sameCategory: true, sameAuthor: true },
      ]);
      const replaced = applyRelatedToNote(once, block2);
      t("替换：旧单标签链接移除、新链接就位且有序", !replaced.includes("笔记B]]（同分类）") && replaced.indexOf("笔记C") < replaced.indexOf("笔记B"));
      const removed = applyRelatedToNote(replaced, "");
      t("block 空串移除整块", !removed.includes(RELATED_MARK_START) && removed.includes("# 笔记A") && removed.includes("*同步于"));
      const reAdded = applyRelatedToNote(removed, block);
      t("移除后可再插入且与首次一致", reAdded === once);
    }

    console.log("— applyRelatedToNote：边界 —");
    {
      const noFooter = "# 标题\n\n正文内容\n";
      const block = buildRelatedBlock([{ path: "p/b.md", title: "b", sameCategory: true, sameAuthor: false }]);
      const out = applyRelatedToNote(noFooter, block);
      t("无尾注：块追加文件尾", out.trimEnd().endsWith(RELATED_MARK_END) && out.startsWith("# 标题"));

      const broken = `${makeNote("a1", { category: "成长学习", author: "张三", title: "笔记A" })}\n${RELATED_MARK_START}\n残留内容\n`;
      const fixed = applyRelatedToNote(broken, block);
      // 第九轮 A5：残留边界按块形态保守识别——「残留内容」不是链接列表行，视为用户正文保留，
      // 只把标记行重建为块（旧实现从标记行清到 EOF，会吞掉块后的用户正文）
      t("有头无尾：块重建且后续用户正文保留", fixed.includes(RELATED_MARK_END) && fixed.includes("残留内容"));

      // 块形态的残留（标题 + 链接列表行）仍视为块内容，重建时不残留旧链接
      const brokenLink = `${makeNote("a1", { category: "成长学习", author: "张三", title: "笔记A" })}\n${RELATED_MARK_START}\n## 相关笔记\n- [[旧笔记|旧]]（同分类）\n`;
      const fixedLink = applyRelatedToNote(brokenLink, block);
      t("有头无尾：块形态残留被重建且不残留旧链接", fixedLink.includes(RELATED_MARK_END) && !fixedLink.includes("旧笔记"));
      // 幂等：重建后的文件再应用一次逐字节一致
      t("有头无尾重建后幂等", applyRelatedToNote(fixedLink, block) === fixedLink);

      t("空文件可插入块", applyRelatedToNote("", block).includes(RELATED_MARK_START));
      t("空文件 + 空块 = 原样", applyRelatedToNote("", "") === "");

      const crlf = makeNote("a1", { category: "成长学习", author: "张三", title: "笔记A" }).replace(/\n/g, "\r\n");
      const crlfOut = applyRelatedToNote(crlf, block);
      t("CRLF 文件：块正常插入且无 \\r 残留", crlfOut.includes(RELATED_MARK_START) && !crlfOut.includes("\r"));
      t("空块且无标记：原样返回", applyRelatedToNote(noFooter, "") === noFooter);
    }

    console.log("— pickRelatedLinks / relatedScore：打分与排序 —");
    {
      const self = { path: "抖音/收藏/A.md", id: "a", category: "成长学习", author: "张三", title: "A", likes: 0 };
      const cands = [
        { path: "抖音/收藏/B.md", id: "b", category: "成长学习", author: "张三", title: "B", likes: 5 },
        { path: "抖音/收藏/C.md", id: "c", category: "成长学习", author: "李四", title: "C", likes: 100 },
        { path: "抖音/收藏/D.md", id: "d", category: "投资理财", author: "张三", title: "D", likes: 1 },
        { path: "抖音/收藏/E.md", id: "e", category: "投资理财", author: "王五", title: "E", likes: 999 },
        { path: "抖音/收藏/F.md", id: "a", category: "成长学习", author: "张三", title: "F重复ID", likes: 999 },
        { path: "抖音/收藏/A2.md", id: "a2", category: "成长学习", author: "张三", title: "A2", likes: 2 },
      ];
      t("relatedScore：同分类同作者=3", relatedScore(self, cands[0]) === 3);
      t("relatedScore：仅同分类=2", relatedScore(self, cands[1]) === 2);
      t("relatedScore：仅同作者=1", relatedScore(self, cands[2]) === 1);
      t("relatedScore：无交集=0", relatedScore(self, cands[3]) === 0);
      t("relatedScore：同 id 排除", relatedScore(self, cands[4]) === 0);
      t("relatedScore：同 path 排除", relatedScore(self, { ...self, id: "other" }) === 0);

      const links = pickRelatedLinks(self, cands, 8);
      // 排序：得分降序 → 点赞降序 → 路径字典序；B/A2 同 3 分，B 高赞在前
      t("排序：双同(高赞先) > 双同 > 同分类(高赞先) > 同作者", links.map((l) => l.path).join(",") === [cands[0], cands[5], cands[1], cands[2]].map((c) => c.path).join(","));
      t("标签：得分 3=双真、2=仅同分类、1=仅同作者", links[0].sameCategory && links[0].sameAuthor && links[2].sameCategory && !links[2].sameAuthor && !links[3].sameCategory && links[3].sameAuthor);
      const capped = pickRelatedLinks(self, cands, 2);
      t("max 截断", capped.length === 2);
      const deterministic = pickRelatedLinks(self, [...cands].reverse(), 8);
      t("候选顺序无关（结果确定）", JSON.stringify(deterministic.map((l) => l.path)) === JSON.stringify(links.map((l) => l.path)));
    }

    console.log("— buildRelatedBlock：渲染 —");
    {
      t("空链接 → 空串", buildRelatedBlock([]) === "");
      const b = buildRelatedBlock([
        { path: "抖音/收藏/成长学习/2026-09-27 标题 [123].md", title: "标题[带]括号", sameCategory: true, sameAuthor: true },
      ]);
      t("路径去 .md、别名剥括号、标签双同", b.includes("[[抖音/收藏/成长学习/2026-09-27 标题 [123]|标题带括号]]（同分类 · 同作者）"));
    }

    console.log("— upsertFmScalar —");
    {
      const fm = '---\ntitle: "x"\nsummary: "s"\nsummary_v: 3\n---\n正文';
      const added = upsertFmScalar(fm, "summary_style", "outline");
      t("新键追加到 frontmatter 末尾", added.includes('summary_style: "outline"\n---') && added.includes("summary_v: 3"));
      const replaced = upsertFmScalar(added, "summary_style", "hierarchy");
      t("已有键原位改值", (replaced.match(/summary_style:/g) || []).length === 1 && replaced.includes('summary_style: "hierarchy"'));
      const multiOld = '---\nsummary_style: |\n  多行\n  旧值\nsummary: "s"\n---\n正文';
      const replacedMulti = upsertFmScalar(multiOld, "summary_style", "qa");
      t("多行旧值整体移除", (replacedMulti.match(/summary_style:/g) || []).length === 1 && !replacedMulti.includes("多行"));
      t("畸形 frontmatter 原样返回", upsertFmScalar('---\ntitle: "x"\n正文', "k", "v") === '---\ntitle: "x"\n正文');
      t("无 frontmatter 原样返回", upsertFmScalar("正文", "k", "v") === "正文");
    }

    console.log("— buildPrompt：风格预设 —");
    {
      const base = { title: "T", transcript: "转录", frameCount: 2, intervalSec: 10 };
      const hierarchy = buildPrompt({ ...base, style: "hierarchy" });
      const outline = buildPrompt({ ...base, style: "outline" });
      const qa = buildPrompt({ ...base, style: "qa" });
      t("hierarchy 含 v3 结构标记（引言/AI 总结/总结与意义）", hierarchy.includes("## 引言") && hierarchy.includes("## AI 总结") && hierarchy.includes("## 总结与意义"));
      t("outline 含要点结构（核心观点/要点/值得记住）", outline.includes("## 核心观点") && outline.includes("## 要点") && outline.includes("## 值得记住"));
      t("qa 含问答结构（Q:/一句话总结）", qa.includes("**Q:") && qa.includes("## 一句话总结"));
      t("方法论四条对全风格生效", [hierarchy, outline, qa].every((p) => p.includes("画面信息挖掘") && p.includes("转录校正") && p.includes("诚实原则") && p.includes("时间脉络")));
      t("风格间格式段互斥", !outline.includes("## 引言") && !qa.includes("## 核心观点"));
    }

    console.log("— 引擎级：refreshAllRelatedNotes 全链路（MiniVault + metadataCache 替身）—");
    {
      const files = {
        "抖音/收藏/成长学习/A.md": makeNote("a", { category: "成长学习", author: "张三", title: "笔记A", likes: 3 }),
        "抖音/收藏/成长学习/B.md": makeNote("b", { category: "成长学习", author: "李四", title: "笔记B", likes: 9 }),
        "抖音/收藏/投资理财/C.md": makeNote("c", { category: "投资理财", author: "王五", title: "笔记C", likes: 1 }),
        "抖音/收藏/投资理财/D.md": makeNote("d", { category: "投资理财", author: "王五", title: "笔记D", likes: 1 }),
        "抖音/收藏/成长学习/E.md": makeNote("e", { category: "成长学习", author: "李四", title: "笔记E", likes: 5 }),
        "笔记库/其他.md": "# 不在 rootFolder 下的笔记不参与",
      };
      const fmByPath = {};
      for (const [p, content] of Object.entries(files)) {
        const fm = content.split("\n---\n")[0];
        const pick = (k) => {
          const match = fm.match(new RegExp(`^${k}: (.*)$`, "m"));
          return match ? JSON.parse(match[1]) : "";
        };
        const likesMatch = fm.match(/^likes: (.*)$/m);
        fmByPath[p] = {
          douyin_id: pick("douyin_id"),
          title: pick("title"),
          category: pick("category"),
          author: pick("author"),
          likes: likesMatch ? Number(likesMatch[1]) : 0,
        };
      }
      const vault = new MiniVault(m.TFile);
      for (const [p, content] of Object.entries(files)) vault.files.set(p, content);
      const engine = makeEngine(m, vault, fmByPath);

      const r1 = await engine.refreshAllRelatedNotes();
      t("首次重建：扫描 5 篇（rootFolder 之外的排除）", r1.scanned === 5);
      t("首次重建：5 篇更新（互链成对建立）", r1.updated === 5);
      const a = vault.files.get("抖音/收藏/成长学习/A.md");
      const b = vault.files.get("抖音/收藏/成长学习/B.md");
      const c = vault.files.get("抖音/收藏/投资理财/C.md");
      const d = vault.files.get("抖音/收藏/投资理财/D.md");
      t("A 链到同分类的 B", /\[\[抖音\/收藏\/成长学习\/B\|/.test(a));
      t("B 链到同分类的 E 与 A（E 高赞在前）", /\[\[抖音\/收藏\/成长学习\/E\|[\s\S]*\[\[抖音\/收藏\/成长学习\/A\|/.test(b));
      t("E 回链 B（互链成对）", /\[\[抖音\/收藏\/成长学习\/B\|/.test(vault.files.get("抖音/收藏/成长学习/E.md")));
      t("C 链到同分类同作者的 D（双同标签）", /\[\[抖音\/收藏\/投资理财\/D\|.*（同分类 · 同作者）/.test(c));
      t("D 回链 C", /\[\[抖音\/收藏\/投资理财\/C\|/.test(d));
      t("块已写入且在尾注之前", a.includes(RELATED_MARK_START) && a.indexOf(RELATED_MARK_START) < a.indexOf("*同步于"));
      t("frontmatter 未被触碰", a.startsWith('---\ndouyin_id: "a"'));
      t("rootFolder 之外的文件未被触碰", vault.files.get("笔记库/其他.md") === files["笔记库/其他.md"]);

      const r2 = await engine.refreshAllRelatedNotes();
      t("二次重建：0 篇更新（幂等 + 无变化不写盘）", r2.updated === 0);

      engine.settings = { ...engine.settings, relatedNotesMax: 1 };
      const r3 = await engine.refreshAllRelatedNotes();
      // A/B/E 三篇旧块各有 2 条互链，max=1 收紧为 1 条（各自留最高分/最高赞的 B 或 E）；C/D 本就只有 1 条
      t("max=1：多链笔记收紧为 1 条", r3.updated === 3 && (vault.files.get("抖音/收藏/成长学习/B.md").match(/\[\[/g) || []).length === 1 && /\[\[抖音\/收藏\/成长学习\/E\|/.test(vault.files.get("抖音/收藏/成长学习/B.md")) && !/\[\[抖音\/收藏\/成长学习\/A\|/.test(vault.files.get("抖音/收藏/成长学习/B.md")) && (vault.files.get("抖音/收藏/成长学习/A.md").match(/\[\[/g) || []).length === 1);

      const r4 = await engine.refreshAllRelatedNotes();
      t("max=1 稳定后不再更新（幂等）", r4.updated === 0);

      // metadataCache 缺失：整体静默跳过，不抛错
      const vault2 = new MiniVault(m.TFile);
      vault2.files.set("抖音/收藏/成长学习/A.md", makeNote("a", { category: "成长学习", author: "张三", title: "笔记A" }));
      const engine2 = new m.SyncEngine({ vault: vault2 }, { ...m.DEFAULT_SETTINGS, rootFolder: "抖音" }, async () => {}, () => {});
      const r5 = await engine2.refreshAllRelatedNotes();
      t("无 metadataCache：扫描 0、不抛错", r5.scanned === 0 && r5.updated === 0);
    }
  };

  return { get pass() { return pass; }, get fail() { return fail; }, async: asyncChecks };
}
