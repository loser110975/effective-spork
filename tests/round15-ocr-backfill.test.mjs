// round15（2026-10-16 批次一）：OCR 补录链——
// ① upsertOcrRowsToCallout 纯函数（失败段替换/成功段保留/占位替换/幂等/无块新建/status 压行）
// ② backfillVision 引擎级（缺口判定/回写/失败计数/防死循环/enableVision 门）
// ③ backfillVideos zeroAsrBudget 静默语义（自动重试链无缺口时返回空串）
import assert from "node:assert/strict";

// ---------- 测试替身（与 round10 同款 MiniVault） ----------

class MiniVault {
  constructor(TFile, TFolder) {
    this.TFile = TFile;
    this.TFolder = TFolder;
    this.files = new Map();
    this.folders = new Set();
    this.adapter = {
      exists: async (p) => this.files.has(this.norm(p)),
      readBinary: async (p) => {
        const f = this.files.get(this.norm(p));
        if (!f) throw new Error(`readBinary: 不存在 ${p}`);
        return Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, "utf8");
      },
    };
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
  async modify(file, content) {
    const path = this.norm(file.path ?? file);
    if (!this.files.has(path)) throw new Error(`modify: 不存在 ${path}`);
    this.files.set(path, { data: content, size: Buffer.byteLength(content, "utf8"), mtime: 0 });
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

const rawNote = (id, n = 2, over = {}) => ({
  aweme_id: id,
  desc: `图文标题${id}`,
  create_time: 1700000000,
  author: { nickname: "作者" },
  aweme_type: 68,
  images: Array.from({ length: n }, (_, i) => ({ url_list: [`https://cdn.example/${id}/p${i}.jpg`] })),
  statistics: {},
  ...over,
});

function makeEngine(m, vault, settingsOver = {}) {
  const settings = makeSettings(m.DEFAULT_SETTINGS, settingsOver);
  const calls = { onStateChange: 0 };
  const engine = new m.SyncEngine(
    { vault },
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

// ---------- 笔记样例 ----------

/** 图文笔记：图 1 识别失败（空段），图 2 识别成功 */
const ocrNoteWithFail = (id) => `---
type: 图文
douyin_id: ${id}
---

![[img_01.jpg]]

## 图片

![[img_01.jpg]]

> [!note]- 图片文字
> **图 1**（识别失败：HTTP 503）
> 
> **图 2**（识别成功）
> 成功的图片文字
`;

/** 图文笔记：完全无图片文字块（历史遗留形态） */
const ocrNoteNoBlock = (id) => `---
type: 图文
douyin_id: ${id}
---

## 图片

![[img_01.jpg]]

正文内容
`;

export function runTests(m) {
  const { DEFAULT_SETTINGS, TFile, TFolder, setRequestUrlMock, DouyinClient, MediaStore } = m;
  let pass = 0, fail = 0;
  const t = (name, ok) => {
    if (ok) { pass++; console.log("  ✓ " + name); }
    else { fail++; console.log("  ✗ " + name); }
  };
  const noNet = () => setRequestUrlMock(async () => {
    throw new Error("requestUrl 不应在单测中被调用（需先 setRequestUrlMock 注入行为）");
  });
  // backfillVision 开头的 refreshClients() 会重建 engine.client / engine.media（真实实例），
  // 实例级 mock 会被覆盖 —— 引擎方法 mock 一律打在 prototype 上（与 round10 同款手法），用完即删
  const mockDetail = (fn) => { DouyinClient.prototype.getAwemeDetail = fn; };
  const mockMedia = () => {
    MediaStore.prototype.dataUrlFromFile = async () => "";
    MediaStore.prototype.toDataUrl = async () => "data:image/jpeg;base64,ZmFrZQ==";
  };
  const unmock = () => {
    delete DouyinClient.prototype.getAwemeDetail;
    delete MediaStore.prototype.dataUrlFromFile;
    delete MediaStore.prototype.toDataUrl;
  };

  const asyncChecks = async () => {
    // =====================================================================
    console.log("— upsertOcrRowsToCallout：纯函数行为 —");
    const upsert = m.upsertOcrRowsToCallout;
    {
      const md = ocrNoteWithFail("9300000000000001");
      const out = upsert(md, [{ index: 1, text: "补录出的新文字", status: "识别成功" }]);
      t("失败段被替换为新结果", out.includes("**图 1**（识别成功）") && out.includes("补录出的新文字"));
      t("失败段旧 status 不残留", !out.includes("识别失败"));
      t("成功段逐字保留", out.includes("**图 2**（识别成功）") && out.includes("成功的图片文字"));
      // 幂等：同 rows 再跑一遍输出不变
      const out2 = upsert(out, [{ index: 1, text: "补录出的新文字", status: "识别成功" }]);
      t("重复补录幂等（输出逐字相同）", out2 === out);
    }
    {
      const md = ocrNoteWithFail("9300000000000002");
      // 只提供图 2 的新结果：图 1 失败段不在 rows 里 → 原样保留（不误删失败记录）
      const out = upsert(md, [{ index: 2, text: "图2的新文字", status: "识别成功" }]);
      t("不在 rows 中的失败段原样保留", out.includes("**图 1**（识别失败：HTTP 503）"));
      t("健康段即使给了新结果也不重打（幂等防重复计费）", out.includes("成功的图片文字") && !out.includes("图2的新文字"));
    }
    {
      const md = `---
type: 图文
---

> [!note]- 图片文字
> **图 1**（未识别）
> （无文字）
`;
      const out = upsert(md, [{ index: 1, text: "迟到的识别结果", status: "识别成功" }]);
      t("「（无文字）」占位段被替换", out.includes("迟到的识别结果") && !out.includes("（无文字）"));
    }
    {
      const md = `---
type: 图文
---

> [!note]- 图片文字
> **图 1**（识别成功）
> 原文
`;
      const o = upsert(md, [{ index: 1, text: "x", status: "识别失败：第一行\n第二行" }]);
      t("健康段即使 status 多行也不重打（所有权判定先于重写）", o.includes("原文") && !o.includes("第一行"));
      const o2 = upsert(`---
type: 图文
---

> [!note]- 图片文字
> **图 1**（识别失败：HTTP 503）
> 
`, [{ index: 1, text: "y", status: "失败一\n失败二" }]);
      t("重写时 status 多行压成单行", o2.includes("失败一 失败二") && !/\n失败二/.test(o2));
    }
    {
      const md = ocrNoteNoBlock("9300000000000003");
      const out = upsert(md, [
        { index: 1, text: "整块新建的文字", status: "识别成功" },
        { index: 2, text: "", status: "未识别" },
      ]);
      t("无块时整块新建", out.includes("> [!note]- 图片文字") && out.includes("整块新建的文字"));
      t("新建时空文本落「（无文字）」占位", out.split("**图 2**")[1]?.includes("（无文字）"));
      // 逐字稿等其余内容不受影响
      t("原正文逐字保留", out.includes("正文内容") && out.includes("![[img_01.jpg]]"));
    }

    // =====================================================================
    console.log("— backfillVision：引擎级补录链 —");
    {
      const vault = new MiniVault(TFile, TFolder);
      const id = "9400000000000001";
      const p = `抖音/收藏/夹/图文 [${id}].md`;
      await vault.create(p, ocrNoteWithFail(id));
      const { engine } = makeEngine(m, vault, {
        enableVision: true,
        visionBaseUrl: "https://v.example/v1",
        visionApiKey: "k-v",
      });
      mockDetail(async () => rawNote(id));
      mockMedia();
      engine.state.processed[id] = { path: p, syncedAt: "t", folder: "夹", source: "collection" };
      let ocrCalls = 0;
      setRequestUrlMock(async (req) => {
        if (!/\/chat\/completions$/.test(req.url)) throw new Error("意外端点 " + req.url);
        ocrCalls++;
        const payload = { choices: [{ message: { content: "补录的图片文字" }, finish_reason: "stop" }] };
        return { status: 200, text: JSON.stringify(payload), json: payload };
      });
      const msg = await engine.backfillVision();
      noNet();
      unmock();
      t("补录完成：处理 1 且失败 0", /处理 1/.test(msg) && /失败 0/.test(msg));
      t("只识别缺口图（健康图 2 不重复请求）", ocrCalls === 1);
      const after = await vault.read(vault.getAbstractFileByPath(p));
      t("失败段回写为新文本", after.includes("补录的图片文字") && !after.includes("识别失败"));
      t("成功段未被重打", after.includes("成功的图片文字"));
      t("成功后无失败计数", !engine.state.backfillFails?.[id]);
    }
    {
      const vault = new MiniVault(TFile, TFolder);
      const id = "9400000000000002";
      const p = `抖音/收藏/夹/图文 [${id}].md`;
      await vault.create(p, ocrNoteNoBlock(id));
      const { engine } = makeEngine(m, vault, {
        enableVision: true,
        visionBaseUrl: "https://v.example/v1",
        visionApiKey: "k-v",
      });
      mockDetail(async () => rawNote(id, 1));
      mockMedia();
      engine.state.processed[id] = { path: p, syncedAt: "t", folder: "夹", source: "collection" };
      setRequestUrlMock(async (req) => {
        if (!/\/chat\/completions$/.test(req.url)) throw new Error("意外端点 " + req.url);
        const payload = { choices: [{ message: { content: "无块补录文字" }, finish_reason: "stop" }] };
        return { status: 200, text: JSON.stringify(payload), json: payload };
      });
      const msg = await engine.backfillVision();
      noNet();
      unmock();
      const after = await vault.read(vault.getAbstractFileByPath(p));
      t("无块历史遗留被整块新建", after.includes("> [!note]- 图片文字") && after.includes("无块补录文字"));
      t("报告含处理 1", /处理 1/.test(msg));
    }
    {
      const vault = new MiniVault(TFile, TFolder);
      const id = "9400000000000003";
      const p = `抖音/收藏/夹/图文 [${id}].md`;
      await vault.create(p, ocrNoteWithFail(id));
      const { engine } = makeEngine(m, vault, {
        enableVision: true,
        visionBaseUrl: "https://v.example/v1",
        visionApiKey: "k-v",
      });
      mockDetail(async () => rawNote(id));
      mockMedia();
      engine.state.processed[id] = { path: p, syncedAt: "t", folder: "夹", source: "collection" };
      // 400 = 非 5xx，不走 AiClient 退避，直接抛 → 全部图记识别失败
      setRequestUrlMock(async () => ({ status: 400, text: '{"error":{"message":"bad input"}}' }));
      const msg = await engine.backfillVision();
      noNet();
      unmock();
      t("全部识别失败 → 失败 1", /失败 1/.test(msg));
      t("失败计数入 backfillFails", engine.state.backfillFails?.[id] === 1);
      const after = await vault.read(vault.getAbstractFileByPath(p));
      t("失败不破坏既有块（图 2 成功段保留）", after.includes("成功的图片文字"));
    }
    {
      const vault = new MiniVault(TFile, TFolder);
      const id = "9400000000000004";
      const p = `抖音/收藏/夹/图文 [${id}].md`;
      await vault.create(p, ocrNoteWithFail(id));
      const { engine } = makeEngine(m, vault, {
        enableVision: true,
        visionBaseUrl: "https://v.example/v1",
        visionApiKey: "k-v",
      });
      engine.state.backfillFails = { [id]: 3 };
      engine.client = { getAwemeDetail: async () => { throw new Error("不应发起详情请求"); } };
      noNet();
      const msg = await engine.backfillVision();
      t("连续失败 ≥3 的条目跳过（防死循环）", msg === "" );
      const after = await vault.read(vault.getAbstractFileByPath(p));
      t("跳过条目笔记未被改动", after.includes("识别失败"));
    }
    {
      const vault = new MiniVault(TFile, TFolder);
      const { engine } = makeEngine(m, vault, { enableVision: false });
      await vault.create("抖音/收藏/夹/图文 [9400000000000005].md", ocrNoteWithFail("9400000000000005"));
      engine.state.processed["9400000000000005"] = {
        path: "抖音/收藏/夹/图文 [9400000000000005].md", syncedAt: "t", folder: "夹", source: "collection",
      };
      noNet();
      const msg = await engine.backfillVision();
      t("enableVision 关闭 → 静默空串", msg === "");
    }
    {
      const vault = new MiniVault(TFile, TFolder);
      const id = "9400000000000006";
      // 视频类笔记：不进 OCR 补录候选
      await vault.create(`抖音/收藏/夹/视频 [${id}].md`, `---\ntype: 视频\ndouyin_id: ${id}\n---\n\n正文`);
      const { engine } = makeEngine(m, vault, {
        enableVision: true,
        visionBaseUrl: "https://v.example/v1",
        visionApiKey: "k-v",
      });
      engine.client = { getAwemeDetail: async () => { throw new Error("视频不应发起详情请求"); } };
      noNet();
      const msg = await engine.backfillVision();
      t("视频类不进候选 → 静默", msg === "");
    }

    // =====================================================================
    console.log("— backfillVideos zeroAsrBudget：自动重试链静默语义 —");
    {
      const vault = new MiniVault(TFile, TFolder);
      const { engine } = makeEngine(m, vault, {});
      // 全健康视频笔记：转录 success + 有摘要 + 帧达标 + summary_v 3 → 补跑 skip
      const id = "9500000000000001";
      const p = `抖音/收藏/夹/视频 [${id}].md`;
      await vault.create(p, `---\ntype: 视频\ntranscript_status: success\ntranscript_provider: test\nframe_interval: 10\nsummary_v: 3\n---\n\n> [!quote]- 逐字稿（test）\n> 转录内容\n\n> [!abstract]- 摘要\n> 已有摘要\n`);
      engine.state.processed[id] = { path: p, syncedAt: "t", folder: "夹", source: "collection" };
      engine.client = { getAwemeDetail: async () => { throw new Error("健康库不应发起详情请求"); } };
      noNet();
      const msg = await engine.backfillVideos(() => {}, { zeroAsrBudget: true });
      t("全健康库 + zeroAsrBudget → 静默空串（不弹 Notice）", msg === "");
    }
    {
      const vault = new MiniVault(TFile, TFolder);
      const { engine } = makeEngine(m, vault, {});
      // 缺摘要但转录可复用：zeroAsrBudget 候选命中（这里只验候选派发，不 mock 全链路——
      // getAwemeDetail 抛错走 failed 分支，证明候选确实入选而非静默跳过）
      const id = "9500000000000002";
      const p = `抖音/收藏/夹/视频 [${id}].md`;
      await vault.create(p, `---\ntype: 视频\ntranscript_status: success\ntranscript_provider: test\n---\n\n> [!quote]- 逐字稿（test）\n> 转录内容\n`);
      engine.state.processed[id] = { path: p, syncedAt: "t", folder: "夹", source: "collection" };
      engine.client = { getAwemeDetail: async () => { throw new Error("detail down"); } };
      noNet();
      const msg = await engine.backfillVideos(() => {}, { zeroAsrBudget: true });
      t("缺摘要候选入选并失败上报（而非被静默跳过）", /失败 1/.test(msg));
      t("zeroAsrBudget 失败也计数防死循环", engine.state.backfillFails?.[id] === 1);
    }
  };

  return { get pass() { return pass; }, get fail() { return fail; }, async: asyncChecks };
}
