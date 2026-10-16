// round16（2026-10-16 批次二）：摘要质量改造 + 维护命令——
// ① splitOneLiner 纯函数（哨兵拆分 / 无哨兵回退 / 60 码点截断不劈 emoji 代理对）
// ② applySummaryToNote 分层写入（fm=短、块=全文；旧三参调用兼容；幂等）
// ③ buildPrompt v4 四条硬要求（一行式哨兵 / 禁叠层 / 禁复述 / ≤600 字，三风格全生效）
// ④ summary_v >= 3 存量保护（v3/v4 健康笔记不进补跑候选；无摘要块进候选）
// ⑤ F2 撞库摘要保护对 v3 存量生效（升 v4 后不重出）
// ⑥ aiCategories 默认词表含 4 个新分类
// ⑦ recategorizeUncategorized 引擎级（回填 + 移动 + 台账同步 / 「其他」不动 / 上限 50 / 门）
// ⑧ fixFolderMismatch 引擎级（fm + 来源行 + 台账三处修正；无错位静默）
import assert from "node:assert/strict";

// ---------- 测试替身（与 round15 同款 MiniVault，补 createFolder / fileManager.renameFile） ----------

class MiniVault {
  constructor(TFile, TFolder) {
    this.TFile = TFile;
    this.TFolder = TFolder;
    this.files = new Map();
    this.folders = new Set();
    this.adapter = { exists: async (p) => this.files.has(this.norm(p)) };
  }
  norm(p) {
    return String(p ?? "").replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "");
  }
  makeFile(path, data) {
    const f = new this.TFile();
    f.path = path;
    f.name = path.slice(path.lastIndexOf("/") + 1);
    f.basename = f.name.replace(/\.[^.]+$/, "");
    const size = Buffer.isBuffer(data) ? data.length : Buffer.byteLength(data, "utf8");
    f.stat = { size, mtime: 0 };
    return f;
  }
  getAbstractFileByPath(p) {
    const path = this.norm(p);
    const rec = this.files.get(path);
    if (rec) return this.makeFile(path, rec.data);
    if (this.folders.has(path)) {
      const dir = new this.TFolder();
      dir.path = path;
      dir.name = path.slice(path.lastIndexOf("/") + 1);
      dir.children = [...this.files.keys()]
        .filter((k) => k.startsWith(path + "/") && !k.slice(path.length + 1).includes("/"))
        .map((k) => this.makeFile(k, this.files.get(k).data));
      return dir;
    }
    return null;
  }
  async read(file) {
    const rec = this.files.get(this.norm(file.path ?? file));
    if (!rec) throw new Error(`read: 不存在 ${file.path ?? file}`);
    return Buffer.isBuffer(rec.data) ? rec.data.toString("utf8") : rec.data;
  }
  async create(path, content) {
    path = this.norm(path);
    if (this.files.has(path)) throw new Error(`create: 已存在 ${path}`);
    this.files.set(path, { data: content, size: Buffer.byteLength(content, "utf8"), mtime: 0 });
    return this.makeFile(path, content);
  }
  async createFolder(path) {
    path = this.norm(path);
    if (this.folders.has(path) || this.files.has(path)) throw new Error(`createFolder: 已存在 ${path}`);
    this.folders.add(path);
  }
  async process(file, fn) {
    const path = this.norm(file.path ?? file);
    const rec = this.files.get(path);
    if (!rec) throw new Error(`process: 不存在 ${path}`);
    const cur = Buffer.isBuffer(rec.data) ? rec.data.toString("utf8") : rec.data;
    const next = await fn(cur);
    const out = typeof next === "string" ? next : cur;
    this.files.set(path, { data: out, size: Buffer.byteLength(out, "utf8"), mtime: 0 });
    return out;
  }
  /** Obsidian fileManager.renameFile 等价物：内容随动，旧路径失效。 */
  async renameFile(file, newPath) {
    newPath = this.norm(newPath);
    const path = this.norm(file.path ?? file);
    const rec = this.files.get(path);
    if (!rec) throw new Error(`renameFile: 不存在 ${path}`);
    this.files.delete(path);
    this.files.set(newPath, rec);
  }
  getFiles() {
    return [...this.files.keys()].map((k) => this.makeFile(k, this.files.get(k).data));
  }
  getMarkdownFiles() {
    return this.getFiles();
  }
}

function makeSettings(DEFAULT_SETTINGS, over = {}) {
  return {
    ...DEFAULT_SETTINGS,
    cookie: "sessionid=test;",
    syncCollection: true,
    useFolderMode: false,
    syncLike: false,
    syncPost: false,
    generateBases: false,
    downloadCover: false,
    downloadImages: false,
    enableCategory: false,
    enableVision: false,
    relatedNotesEnabled: false,
    asrProvider: "none",
    videoSummaryEnabled: false,
    aiKey: "",
    dashscopeKey: "",
    siliconflowKey: "",
    syncConcurrency: 3,
    scanStopAfterProcessed: 100,
    maxTranscribePerSync: 20,
    rootFolder: "抖音",
    mediaFolder: "抖音/Media",
    ...over,
  };
}

function makeEngine(m, vault, settingsOver = {}, appOver = {}) {
  const settings = makeSettings(m.DEFAULT_SETTINGS, settingsOver);
  const calls = { onStateChange: 0 };
  const app = {
    vault,
    fileManager: {
      renameFile: async (file, newPath) => vault.renameFile(file, newPath),
    },
    ...appOver,
  };
  const engine = new m.SyncEngine(
    app,
    settings,
    async () => { calls.onStateChange++; },
    () => {},
  );
  engine.media = {
    saveImage: async (url, rel) => `抖音/Media/${rel}.jpg`,
    dataUrlFromFile: async () => "",
    toDataUrl: async () => "",
  };
  engine.videoMedia = {
    updateClient() {},
    checkFfmpeg: async () => null,
    pullAssets: async () => ({ assets: { audioPath: "", framePaths: [] }, error: "", errorKind: "none" }),
    cleanup: () => {},
  };
  return { engine, calls, settings };
}

/** processItem 用的 SyncSummary 空白对象（与 syncEngine.newSyncSummary 同形状）。 */
const blankSummary = () => ({
  total: 0, created: 0, skipped: 0, transcribed: 0, asrFailed: 0, asrSkipped: 0,
  visionOk: 0, videoSummaries: 0, forcedFrameResync: 0, errors: [], notices: [],
  startedAt: "", finishedAt: "",
});

const rawVideo = (id) => ({
  aweme_id: id,
  desc: `视频标题${id}`,
  create_time: 1700000000,
  author: { nickname: "作者" },
  aweme_type: 0,
  video: {
    play_addr: { url_list: [`https://cdn.example/${id}/video`] },
    cover: { url_list: [`https://cdn.example/${id}/cover.jpg`] },
    duration: 23000,
  },
  statistics: { digg_count: 10 },
});

// ---------- 笔记样例 ----------

const healthyVideoNote = (id, summaryV) => `---
type: 视频
douyin_id: ${id}
transcript_status: success
transcript_provider: test
frame_interval: 10
summary_v: ${summaryV}
---

> [!quote]- 逐字稿（test）
> 转录内容

> [!abstract]- 摘要
> 已有摘要
`;

const unclassifiedNote = (id, over = {}) => `---
type: 图文
douyin_id: ${id}
title: "图文标题${id}"
category: ${over.category ?? '""'}
---

正文内容

> [!note]- 图片文字
> OCR 提取的文字内容
`;

export function runTests(m) {
  const { DEFAULT_SETTINGS, TFile, TFolder, setRequestUrlMock, DouyinClient, AiClient } = m;
  let pass = 0, fail = 0;
  const t = (name, ok) => {
    if (ok) { pass++; console.log("  ✓ " + name); }
    else { fail++; console.log("  ✗ " + name); }
  };
  const noNet = () => setRequestUrlMock(async () => {
    throw new Error("requestUrl 不应在单测中被调用（需先 setRequestUrlMock 注入行为）");
  });

  const asyncChecks = async () => {
    // =====================================================================
    console.log("— splitOneLiner：一行式哨兵拆分 —");
    {
      const { splitOneLiner } = m;
      const r1 = splitOneLiner("一行式：抖音带货的三个核心指标\n\n## 引言\n正文从这里开始");
      t("哨兵首行拆出 oneLiner", r1.oneLiner === "抖音带货的三个核心指标");
      t("哨兵后的全文进入 body（空行被 trim）", r1.body === "## 引言\n正文从这里开始");

      const r2 = splitOneLiner("\n\n一行式：  前置空行与首尾空格  \n正文");
      t("前置空行不干扰哨兵识别，值被 trim", r2.oneLiner === "前置空行与首尾空格" && r2.body === "正文");

      const r3 = splitOneLiner("主题:普通标题\n一行式：混在正文中不算哨兵");
      t("哨兵不在首个非空行 → 走无哨兵回退", r3.oneLiner === "主题:普通标题" && r3.body.includes("一行式：混在正文中不算哨兵"));

      // 60 码点截断：emoji（代理对）不劈
      const emojiLine = "😀".repeat(80) + "结尾";
      const r4 = splitOneLiner(emojiLine);
      t("无哨兵回退按码点截 60（emoji 不劈代理对）", r4.oneLiner === "😀".repeat(60));
      t("回退 body 仍为全文", r4.body === emojiLine);

      const r5 = splitOneLiner("");
      t("空输入返回空串", r5.oneLiner === "" && r5.body === "");

      const r6 = splitOneLiner("一行式：");
      t("哨兵后无内容 → oneLiner 为空串", r6.oneLiner === "" && r6.body === "");
    }

    // =====================================================================
    console.log("— applySummaryToNote：fm=短、块=全文 分层写入 —");
    {
      const base = "---\ntype: 视频\ntitle: t\n---\n\n> [!quote]- 逐字稿\n> 内容";
      const raw = "一行式：单行结论\n\n正文第一段\n- 要点一\n- 要点二";
      const out1 = m.applySummaryToNote(base, raw, 4);
      t("fm summary 写一行短摘要（不含全文）", /^summary: "单行结论"$/m.test(out1) && !out1.includes('summary: "正文第一段'));
      t("summary_v 写入 4", /^summary_v: 4$/m.test(out1));
      t("摘要块写全文摘要（多行都在块内）", out1.includes("> 正文第一段") && out1.includes("> - 要点一") && out1.includes("> - 要点二"));
      t("既有内容逐字保留", out1.includes("> [!quote]- 逐字稿\n> 内容"));

      // 旧三参调用兼容：无哨兵的 v3 全文摘要回填 → fm=首行短摘要、块=全文
      const v3Text = "主题:旧版摘要\n\n## 总结与意义\nv3 全文摘要正文";
      const out2 = m.applySummaryToNote(base, v3Text, 3);
      t("旧三参调用（无哨兵）：fm 取首个非空行", /^summary: "主题:旧版摘要"$/m.test(out2));
      t("旧三参调用：块仍是全文（v3 内容不丢）", out2.includes("> ## 总结与意义") && out2.includes("> v3 全文摘要正文"));
      t("旧三参调用：summary_v 原样写回", /^summary_v: 3$/m.test(out2));

      // 只有哨兵行（body 空）→ 块保底不空
      const out3 = m.applySummaryToNote(base, "一行式：只有一行", 4);
      t("仅一行式时块保底写同一行", out3.includes("> 一行式：只有一行") || out3.includes("> 只有一行"));

      // 幂等：同输入两次输出一致
      const once = m.applySummaryToNote(base, raw, 4);
      const twice = m.applySummaryToNote(once, raw, 4);
      t("连续两次 apply 输出不变（幂等）", once === twice);
    }

    // =====================================================================
    console.log("— buildPrompt：v4 四条硬要求对三风格生效 —");
    {
      const base = { title: "T", transcript: "稿", frameCount: 0, intervalSec: 10 };
      for (const style of ["hierarchy", "outline", "qa"]) {
        const p = m.buildPrompt({ ...base, style });
        t(`[${style}] 输出格式含一行式哨兵要求`, p.includes("一行式："));
        t(`[${style}] 禁叠层`, p.includes("禁叠层"));
        t(`[${style}] 禁复述（禁时间线逐段改写）`, p.includes("禁复述") && p.includes("时间线"));
        t(`[${style}] 控长度 ≤600 字`, p.includes("600 字"));
      }
      const hierarchy = m.buildPrompt({ ...base, style: "hierarchy" });
      t("[hierarchy] 不再要求「## AI 总结」独立收尾节", !hierarchy.includes("## AI 总结」"));
      t("[hierarchy] 保留总结与意义节（唯一总结层）", hierarchy.includes("## 总结与意义"));
    }

    // =====================================================================
    console.log("— summary_v >= 3 存量保护：v3/v4 健康笔记不进补跑候选 —");
    {
      const vault = new MiniVault(TFile, TFolder);
      const { engine } = makeEngine(m, vault, {});
      const idV3 = "9600000000000001";
      const idV4 = "9600000000000002";
      const pV3 = `抖音/收藏/夹/视频 [${idV3}].md`;
      const pV4 = `抖音/收藏/夹/视频 [${idV4}].md`;
      await vault.create(pV3, healthyVideoNote(idV3, 3));
      await vault.create(pV4, healthyVideoNote(idV4, 4));
      engine.state.processed[idV3] = { path: pV3, syncedAt: "t", folder: "夹", source: "collection" };
      engine.state.processed[idV4] = { path: pV4, syncedAt: "t", folder: "夹", source: "collection" };
      engine.client = { getAwemeDetail: async () => { throw new Error("健康库不应发起详情请求"); } };
      noNet();
      const msg = await engine.backfillVideos(() => {}, { zeroAsrBudget: true });
      t("v3 + v4 健康笔记均不进候选（zeroAsrBudget 静默空串）", msg === "");
      t("v3 笔记未被改写", (await vault.read(vault.getAbstractFileByPath(pV3))).includes("已有摘要"));
    }
    {
      // 无摘要块的笔记（summary_v 缺失）仍进候选：detail 抛错走失败分支证明入选
      const vault = new MiniVault(TFile, TFolder);
      const { engine } = makeEngine(m, vault, {});
      const id = "9600000000000003";
      const p = `抖音/收藏/夹/视频 [${id}].md`;
      await vault.create(p, `---\ntype: 视频\ndouyin_id: ${id}\ntranscript_status: success\ntranscript_provider: test\nframe_interval: 10\n---\n\n> [!quote]- 逐字稿（test）\n> 转录内容\n`);
      engine.state.processed[id] = { path: p, syncedAt: "t", folder: "夹", source: "collection" };
      engine.client = { getAwemeDetail: async () => { throw new Error("detail down"); } };
      noNet();
      const msg = await engine.backfillVideos(() => {}, { zeroAsrBudget: true });
      t("无摘要块笔记进候选并失败上报", /失败 1/.test(msg));
      t("失败计数入 backfillFails", engine.state.backfillFails?.[id] === 1);
    }

    // =====================================================================
    console.log("— F2 撞库摘要保护对 v3 生效（升 v4 后不重出）—");
    {
      const vault = new MiniVault(TFile, TFolder);
      const { engine } = makeEngine(m, vault, {
        videoSummaryEnabled: true,
        videoSummaryBaseUrl: "https://f2.example/v1",
        videoSummaryApiKey: "k-f2",
        summaryMaxTokens: 500,
      });
      const id = "9700000000000001";
      const p = `抖音/收藏/夹/note [${id}].md`;
      await vault.create(p, [
        "---", "type: 视频", "category: 投资理财",
        "transcript_status: success", "transcript_provider: siliconflow_sensevoice",
        "frame_interval: 10", "summary_v: 3", "---", "",
        "> [!quote]- 逐字稿（siliconflow_sensevoice）", "> 转录内容", "",
        "> [!abstract]- 摘要", "> 精修摘要内容", "",
      ].join("\n"));
      let summaryCalls = 0;
      setRequestUrlMock(async (req) => {
        if (/\/chat\/completions$/.test(req.url)) { summaryCalls++; throw new Error("F2：不应重出摘要"); }
        throw new Error("意外请求 " + req.url);
      });
      const item = DouyinClient.normalize(rawVideo(id), "collection");
      const ok = await engine.processItem(item, "夹", blankSummary(), undefined);
      noNet();
      t("撞库条目已有 v3 摘要 → 零摘要请求（升 v4 不触发重出）", ok === true && summaryCalls === 0);
      t("v3 精修摘要原样保留", (vault.files.get(p)?.data ?? "").includes("精修摘要内容"));
    }

    // =====================================================================
    console.log("— aiCategories：默认词表含 4 个新分类 —");
    {
      const cats = m.DEFAULT_SETTINGS.aiCategories;
      t("含「副业搞钱」", cats.includes("副业搞钱"));
      t("含「自媒体创作」", cats.includes("自媒体创作"));
      t("含「两性恋爱」", cats.includes("两性恋爱"));
      t("含「AI 实战应用」", cats.includes("AI 实战应用"));
      t("既有 7 词保留", ["成长学习", "投资理财", "AI编程", "心理情感", "职场商业", "娱乐生活", "运动健康"].every((c) => cats.includes(c)));
    }

    // =====================================================================
    console.log("— recategorizeUncategorized：未分类补跑 AI 分类 —");
    {
      // 门 1：enableCategory 关闭 → 说明文案
      const vault = new MiniVault(TFile, TFolder);
      const { engine } = makeEngine(m, vault, { enableCategory: false });
      noNet();
      const gateMsg = await engine.recategorizeUncategorized();
      t("enableCategory 关闭 → 返回说明文案（非空、非汇总）", typeof gateMsg === "string" && gateMsg.includes("分类") && !/处理 \d/.test(gateMsg));
    }
    {
      // 主链：未分类 → AI 分类 → fm 回填 + 移动 + 台账同步
      const vault = new MiniVault(TFile, TFolder);
      const { engine } = makeEngine(m, vault, {
        enableCategory: true,
        aiBaseUrl: "https://a.example/v1",
        aiKey: "k-cat",
      });
      const id = "9800000000000001";
      const p = `抖音/未分类/图文 [${id}].md`;
      await vault.create(p, unclassifiedNote(id));
      engine.state.processed[id] = { path: p, syncedAt: "t", folder: "未分类", source: "collection" };
      const catCalls = [];
      AiClient.prototype.categorize = async (cats, title, desc, excerpt) => {
        catCalls.push({ cats, title, desc, excerpt });
        return "投资理财";
      };
      noNet();
      const msg = await engine.recategorizeUncategorized();
      delete AiClient.prototype.categorize;
      const target = `抖音/投资理财/图文 [${id}].md`;
      t("报告：处理 1，失败 0", /处理 1/.test(msg) && /失败 0/.test(msg));
      t("文件已移动到分类目录", vault.files.has(target) && !vault.files.has(p));
      const after = await vault.read(vault.getAbstractFileByPath(target));
      t("fm category 已回填", /^category: "投资理财"$/m.test(after));
      t("台账 path 已同步到新路径", engine.state.processed[id].path === target);
      // 反向索引（engine.ledger 私有成员，运行时可达）：findNotePath 首选索引，不同步会在旧路径重建重复笔记
      t("反向索引同步更新到新路径", engine.ledger.noteIndexGet().get(id) === target);
      t("分类输入含标题与 OCR 文本", catCalls.length === 1 && catCalls[0].title.includes(`图文标题${id}`) && catCalls[0].desc.includes("OCR 提取的文字内容"));
    }
    {
      // 「其他（不好分类）」：fm 不动、不计失败；AI 抛错：计失败 + backfillFails
      const vault = new MiniVault(TFile, TFolder);
      const { engine } = makeEngine(m, vault, {
        enableCategory: true,
        aiBaseUrl: "https://a.example/v1",
        aiKey: "k-cat",
      });
      const idA = "9800000000000002";
      const idB = "9800000000000003";
      const pA = `抖音/未分类/a [${idA}].md`;
      const pB = `抖音/未分类/b [${idB}].md`;
      await vault.create(pA, unclassifiedNote(idA));
      await vault.create(pB, unclassifiedNote(idB));
      engine.state.processed[idA] = { path: pA, syncedAt: "t", folder: "未分类", source: "collection" };
      engine.state.processed[idB] = { path: pB, syncedAt: "t", folder: "未分类", source: "collection" };
      let calls = 0;
      AiClient.prototype.categorize = async (_cats, title) => {
        calls++;
        if (title.includes(idA)) return "其他（不好分类）";
        throw new Error("AI 超时");
      };
      noNet();
      const msg = await engine.recategorizeUncategorized();
      delete AiClient.prototype.categorize;
      t("报告：失败 1（AI 抛错计入）", /失败 1/.test(msg));
      t("「其他」笔记原地不动、fm 保持未分类", vault.files.has(pA) && /^category: ""$/m.test(await vault.read(vault.getAbstractFileByPath(pA))));
      t("「其他」不计失败（backfillFails 不含该 id）", !engine.state.backfillFails?.[idA]);
      t("抛错笔记计入 backfillFails", engine.state.backfillFails?.[idB] === 1);
    }
    {
      // 上限 50 条/轮
      const vault = new MiniVault(TFile, TFolder);
      const { engine } = makeEngine(m, vault, {
        enableCategory: true,
        aiBaseUrl: "https://a.example/v1",
        aiKey: "k-cat",
      });
      const ids = [];
      for (let i = 0; i < 55; i++) {
        const id = "990" + String(i).padStart(13, "0");
        ids.push(id);
        const p = `抖音/未分类/n [${id}].md`;
        await vault.create(p, unclassifiedNote(id));
        engine.state.processed[id] = { path: p, syncedAt: "t", folder: "未分类", source: "collection" };
      }
      AiClient.prototype.categorize = async () => "副业搞钱";
      noNet();
      const msg = await engine.recategorizeUncategorized();
      delete AiClient.prototype.categorize;
      t("55 条候选只跑前 50（上限 50/轮）", /处理 50/.test(msg));
      t("前 50 条已移动、后 5 条留在原地", vault.files.has(`抖音/副业搞钱/n [${ids[0]}].md`) && vault.files.has(`抖音/未分类/n [${ids[54]}].md`));
    }
    {
      // backfillFails >= 3 跳过（防死循环）
      const vault = new MiniVault(TFile, TFolder);
      const { engine } = makeEngine(m, vault, {
        enableCategory: true,
        aiBaseUrl: "https://a.example/v1",
        aiKey: "k-cat",
      });
      const id = "9900000000000001";
      const p = `抖音/未分类/x [${id}].md`;
      await vault.create(p, unclassifiedNote(id));
      engine.state.processed[id] = { path: p, syncedAt: "t", folder: "未分类", source: "collection" };
      engine.state.backfillFails = { [id]: 3 };
      AiClient.prototype.categorize = async () => { throw new Error("不应被调用"); };
      noNet();
      const msg = await engine.recategorizeUncategorized();
      delete AiClient.prototype.categorize;
      t("连续失败 ≥3 的条目跳过且不计候选", msg.includes("无未分类笔记"));
      t("跳过条目未被改写", vault.files.has(p));
    }

    // =====================================================================
    console.log("— fixFolderMismatch：folder 错位修复 —");
    {
      // 主链：目录 AI编程、fm folder 未分类 → fm + 来源行 + 台账三处修正
      const vault = new MiniVault(TFile, TFolder);
      const { engine } = makeEngine(m, vault, {});
      const id = "9910000000000001";
      const p = `抖音/收藏/AI编程/图文 [${id}].md`;
      await vault.create(p, [
        "---", "type: 图文", `douyin_id: ${id}`, 'folder: "未分类"', "---", "",
        "作者：**作者** ｜ 来源：收藏（未分类） ｜ [原视频链接](https://www.douyin.com/note/1)", "",
        "正文",
      ].join("\n"));
      engine.state.processed[id] = { path: p, syncedAt: "t", folder: "未分类", source: "collection" };
      noNet();
      const msg = await engine.fixFolderMismatch();
      const after = await vault.read(vault.getAbstractFileByPath(p));
      t("报告修正 1 条", /修正 1/.test(msg));
      t("fm folder 回填为实际目录名", /^folder: "AI编程"$/m.test(after));
      t("来源行内（未分类）被替换、其余文案逐字保留", after.includes("来源：收藏（AI编程）") && after.includes("作者：**作者**"));
      t("台账 folder 同步修正", engine.state.processed[id].folder === "AI编程");
      t("文件未被移动", vault.files.has(p));
    }
    {
      // 无错位 + 台账 folder 与实际目录不符时以实际目录为准
      const vault = new MiniVault(TFile, TFolder);
      const { engine } = makeEngine(m, vault, {});
      const idOk = "9910000000000002";
      const idStale = "9910000000000003";
      const pOk = `抖音/收藏/投资理财/图文 [${idOk}].md`;
      const pStale = `抖音/收藏/自媒体创作/图文 [${idStale}].md`;
      await vault.create(pOk, `---\ntype: 图文\nfolder: "投资理财"\n---\n来源：收藏（投资理财）\n正文`);
      await vault.create(pStale, `---\ntype: 图文\nfolder: "旧夹名"\n---\n来源：收藏（旧夹名）\n正文`);
      engine.state.processed[idOk] = { path: pOk, syncedAt: "t", folder: "投资理财", source: "collection" };
      engine.state.processed[idStale] = { path: pStale, syncedAt: "t", folder: "旧夹名", source: "collection" };
      noNet();
      const msg = await engine.fixFolderMismatch();
      const stale = await vault.read(vault.getAbstractFileByPath(pStale));
      t("一致条目不动（报告只修 1）", /修正 1/.test(msg));
      t("台账 folder 与实际不符：以实际目录为准修正", engine.state.processed[idStale].folder === "自媒体创作");
      t("fm folder 以实际目录为准修正", /^folder: "自媒体创作"$/m.test(stale));
      // 来源行只做（未分类）→（实际目录）的定点替换：本就无（未分类）括注的行逐字保留
      t("来源行无（未分类）括注时逐字保留", stale.includes("来源：收藏（旧夹名）"));
      const okNote = await vault.read(vault.getAbstractFileByPath(pOk));
      t("一致条目内容零改动", okNote.includes('folder: "投资理财"') && okNote.includes("来源：收藏（投资理财）"));
    }
    {
      // 库外路径与「未分类」目录不碰
      const vault = new MiniVault(TFile, TFolder);
      const { engine } = makeEngine(m, vault, {});
      const idOut = "9910000000000004";
      const idUnc = "9910000000000005";
      const pOut = `其他目录/图文 [${idOut}].md`;
      const pUnc = `抖音/未分类/图文 [${idUnc}].md`;
      await vault.create(pOut, `---\ntype: 图文\nfolder: "未分类"\n---\n来源：收藏（未分类）\n`);
      await vault.create(pUnc, `---\ntype: 图文\nfolder: "未分类"\n---\n来源：收藏（未分类）\n`);
      engine.state.processed[idOut] = { path: pOut, syncedAt: "t", folder: "未分类", source: "collection" };
      engine.state.processed[idUnc] = { path: pUnc, syncedAt: "t", folder: "未分类", source: "collection" };
      noNet();
      const msg = await engine.fixFolderMismatch();
      t("库外笔记与「未分类」实际目录均不碰 → 无 folder 错位", msg === "无 folder 错位");
      t("库外笔记未被改写", /^folder: "未分类"$/m.test(await vault.read(vault.getAbstractFileByPath(pOut))));
    }

    // =====================================================================
    console.log("— backfillAll：全量补录执行器（批次二 G）—");
    // 两链直接以实例属性替换（实例方法可被同名属性遮蔽；backfillAll 不调 refreshClients，替换稳定）。
    // stub 签名与真实方法一致：(onProgress?, out?) => string，计数写入 out。
    const stubChain = (engine, visionFn, videosFn) => {
      engine.backfillVision = async (_onProgress, out) => {
        engine.running = true; // 模拟真实链同步前缀自行夺回互斥（backfillAll 只在同步前缀瞬间放行）
        const r = visionFn();
        if (out) { out.done = r.done; out.failed = r.failed ?? 0; }
        return r.msg ?? "ocr";
      };
      engine.backfillVideos = async (_onProgress, _opts, out) => {
        engine.running = true;
        const r = videosFn();
        if (out) { out.done = r.done; out.failed = r.failed ?? 0; }
        return r.msg ?? "sum";
      };
    };
    {
      // 零产出提前终止：两链零工作量 → 第 1 轮即收尾
      const vault = new MiniVault(TFile, TFolder);
      const { engine } = makeEngine(m, vault, {});
      stubChain(engine, () => ({ done: 0 }), () => ({ done: 0 }));
      noNet();
      const msg = await engine.backfillAll();
      t("两链零产出 → 第 1 轮收尾，总数 0", msg.includes("OCR 0 条") && msg.includes("摘要 0 条") && msg.includes("总轮数 1"));
      t("收尾后 running 互斥释放", engine.running === false);
    }
    {
      // 循环终止 + 累计计数正确（vision 每轮先执行并递增 round，videos 据此区分轮次）
      const vault = new MiniVault(TFile, TFolder);
      const { engine } = makeEngine(m, vault, {});
      let round = 0;
      let sawRunningTrue = false;
      engine.backfillVision = async (_onProgress, out) => {
        engine.running = true; // 模拟真实链同步前缀自行夺回互斥
        const done = round === 0 ? 2 : 0; // OCR 第 1 轮补 2 条，第 2 轮零
        if (out) { out.done = done; out.failed = 0; }
        round++;
        return "ocr";
      };
      engine.backfillVideos = async (_onProgress, _opts, out) => {
        engine.running = true;
        sawRunningTrue = sawRunningTrue || engine.running === true; // backfillAll 循环期间互斥在手
        const done = round === 1 ? 1 : 0; // 摘要第 1 轮 1 成 1 败，第 2 轮零
        const failed = round === 1 ? 1 : 0;
        if (out) { out.done = done; out.failed = failed; }
        return "sum";
      };
      noNet();
      const msg = await engine.backfillAll();
      t("第 2 轮两链零产出 → 总轮数 2", msg.includes("总轮数 2"));
      t("累计计数：OCR 2 / 摘要 1（失败不计入累计）", msg.includes("OCR 2 条") && msg.includes("摘要 1 条"));
      t("执行期间 running 互斥被 backfillAll 持有", sawRunningTrue);
      t("正常收尾无配额/上限附注", !msg.includes("配额") && !msg.includes("上限"));
    }
    {
      // 60 轮硬顶
      const vault = new MiniVault(TFile, TFolder);
      const { engine } = makeEngine(m, vault, {});
      let visionCalls = 0;
      let videoCalls = 0;
      stubChain(
        engine,
        () => { visionCalls++; return { done: 3 }; },
        () => { videoCalls++; return { done: 2 }; },
      );
      noNet();
      const msg = await engine.backfillAll();
      t("两链持续有产出 → 跑满 60 轮硬顶", visionCalls === 60 && videoCalls === 60 && msg.includes("总轮数 60"));
      t("累计计数 = 60 轮之和", msg.includes("OCR 180 条") && msg.includes("摘要 120 条"));
      t("附注达上限提示", msg.includes("上限"));
    }
    {
      // 配额熔断自愈：摘要链连续 3 轮 quotaDead 零产出 → 提前终止并注明
      const vault = new MiniVault(TFile, TFolder);
      const { engine } = makeEngine(m, vault, {});
      stubChain(
        engine,
        () => ({ done: 1 }), // OCR 链持续有产出（配额不影响 OCR）
        () => {
          engine.videoSummaryQuotaDead = true; // 模拟每轮配额熔断置位（真实链每轮复位后重新探测仍死）
          return { done: 0 };
        },
      );
      noNet();
      const msg = await engine.backfillAll();
      t("连续 3 轮配额熔断 → 第 3 轮提前终止", msg.includes("总轮数 3"));
      t("附注疑似配额耗尽", msg.includes("疑似配额耗尽"));
      t("终止后配额熔断标志可见（诊断口径）", engine.videoSummaryQuotaDead === true);
    }
    {
      // out 参数向后兼容：真实链路在门未通时 out 保持 0/0、返回字符串形态不变
      const vault = new MiniVault(TFile, TFolder);
      const { engine } = makeEngine(m, vault, { enableVision: false });
      noNet();
      const out = { done: -1, failed: -1 }; // 哨兵初值：门未通时应被重置为 0/0
      const msg = await engine.backfillVision(undefined, out);
      t("门未通：返回空串 + out 归零（向后兼容）", msg === "" && out.done === 0 && out.failed === 0);
    }
  };

  return { get pass() { return pass; }, get fail() { return fail; }, async: asyncChecks };
}
