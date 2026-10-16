// round17（2026-10-16 批次三）：embedding 语义检索 + 向量互链 + QA 三观察项加固——
// ① splitOneLiner 缩进哨兵加固（半角/全角空格缩进命中，哨兵字样不泄漏进 fm summary）
// ② applySummaryToNote 空白 summary 保护（不清空既有摘要块）
// ③ recategorize 移动失败补偿回滚（fm category 不留中间态）
// ④ cosineSim / cosineTopK / contentHash / f32↔b64 纯函数
// ⑤ EmbeddingClient（requestUrl mock：切批 / index 归位 / 条数不匹配报错 / embedOne 软失败）
// ⑥ VectorStore（内存 KvAdapter：persist/load 往返 / pruneExcept / resetForModel / 损坏降级）
// ⑦ buildSemanticIndex 引擎级（门 / 增量 hash 跳过 / 单篇重算 / 换模型全量 / 孤儿清理）
// ⑧ semanticSearch 引擎级（命中排序 / 索引空返回 null）
// ⑨ 向量互链接线（refreshAllRelatedNotes 走 topK 选链；索引缺席回落同分类打分）
import assert from "node:assert/strict";

// ---------- 测试替身（round16 同款 MiniVault，adapter 补全为完整 KvAdapter） ----------

function normK(p) {
  return String(p ?? "").replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "");
}

class MiniVault {
  constructor(TFile, TFolder) {
    this.TFile = TFile;
    this.TFolder = TFolder;
    this.files = new Map();
    this.folders = new Set();
    // 完整 KvAdapter（VectorStore 的 read/write/rename/remove 都用得上；normalizePath 归一口径一致）
    this.adapter = {
      exists: async (p) => this.files.has(normK(p)) || this.kv.has(normK(p)),
      read: async (p) => {
        const k = normK(p);
        if (this.kv.has(k)) return this.kv.get(k);
        if (this.files.has(k)) return this.files.get(k).data;
        throw new Error(`adapter.read: 不存在 ${p}`);
      },
      write: async (p, data) => {
        this.kv.set(normK(p), data);
      },
      remove: async (p) => {
        this.kv.delete(normK(p));
      },
      rename: async (a, b) => {
        const ka = normK(a);
        const kb = normK(b);
        if (this.kv.has(ka)) {
          this.kv.set(kb, this.kv.get(ka));
          this.kv.delete(ka);
          return;
        }
        if (this.files.has(ka)) {
          this.files.set(kb, this.files.get(ka));
          this.files.delete(ka);
          return;
        }
        throw new Error(`adapter.rename: 源不存在 ${a}`);
      },
    };
    this.kv = new Map(); // adapter 直写的非 vault 文件（vectors.json / .tmp）
  }
  norm(p) {
    return normK(p);
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
    relatedNotesEnabled: true,
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
    async () => {
      calls.onStateChange++;
    },
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

/** 三篇语义测试笔记：n1 与 n2 内容近义（向量接近），n3 无关。 */
const NOTES = {
  n1: {
    id: "n1",
    title: "如何调试异步竞态",
    body: "异步竞态调试技巧：用日志时间戳定位时序问题，检查 Promise 的完成顺序与共享状态写入的交错。",
  },
  n2: {
    id: "n2",
    title: "异步时序问题排查",
    body: "排查异步时序问题：给事件回调加时间戳日志，观察 Promise 链完成顺序，注意共享变量被并发写入。",
  },
  n3: {
    id: "n3",
    title: "红烧肉做法",
    body: "五花肉焯水后炒糖色，加料酒生抽老抽，小火炖四十分钟，大火收汁。",
  },
};

function noteMarkdown(n, category = "AI 编程") {
  return [
    "---",
    `douyin_id: "${n.id}"`,
    `title: "${n.title}"`,
    `author: "作者甲"`,
    `category: "${category}"`,
    `likes: 10`,
    "---",
    "",
    n.body,
    "",
    "*同步于 2026-10-16 douyin-sync*",
  ].join("\n");
}

/** 文本 → 向量映射（EmbeddingClient.prototype.embed 按输入文本查表；查询文本未命中时默认 n1 向量）。 */
const TEXT2VEC = () => ({
  [NOTES.n1.body]: [1, 0],
  [NOTES.n2.body]: [0.99, 0.1],
  [NOTES.n3.body]: [0, 1],
});

function installEmbedMock(m, table, counter) {
  // embed 与 embedBatch 都 mock：buildSemanticIndex 走 embed、pickLinksForCurrent 的 embedOne 走
  // embedBatch——漏 mock embedBatch 会让互链块打真 requestUrl（全局 stub 的 endpoint 断言被污染）。
  // 匹配用「包含」：noteTextForEmbed 的输出 = 正文压缩 + 尾注行，特征文本是其子串。
  const impl = async (inputs) => {
    if (counter) counter.calls++;
    return inputs.map((t) => {
      for (const [k, v] of Object.entries(table)) {
        if (t.includes(k)) return v;
      }
      return [1, 0];
    });
  };
  m.EmbeddingClient.prototype.embed = impl;
  m.EmbeddingClient.prototype.embedBatch = impl;
}

function seedVault(vault) {
  for (const n of Object.values(NOTES)) {
    vault.files.set(`抖音/收藏/AI 编程/${n.id}.md`, { data: noteMarkdown(n), size: 0, mtime: 0 });
  }
}

function seedCache(app) {
  app.metadataCache = {
    getFileCache: (f) => {
      const rec = app.vault.files.get(f.path);
      if (!rec) return null;
      const m = /douyin_id: "([^"]+)"/.exec(rec.data);
      if (!m) return null;
      const t = /title: "([^"]+)"/.exec(rec.data);
      return {
        frontmatter: {
          douyin_id: m[1],
          title: t ? t[1] : f.basename,
          category: /category: "([^"]+)"/.exec(rec.data)?.[1] ?? "",
          author: "作者甲",
          likes: 10,
        },
      };
    },
  };
}

export function runTests(m) {
  const tests = [];
  const t = (name, cond) => {
    tests.push([name, cond]);
    if (!cond) console.log(`  ✗ [round17] ${name}`);
  };
  const asyncChecks = []; // async 用例函数（runTests 返回的 async 包装器逐个 await）

  // ---------- ①③ noteText 加固（纯函数） ----------
  {
    const { splitOneLiner, applySummaryToNote } = m;
    const r1 = splitOneLiner(" 一行式：异步调试三招\n\n正文从这里开始");
    t("半角空格缩进哨兵命中拆分", r1.oneLiner === "异步调试三招" && r1.body.startsWith("正文"));
    const r2 = splitOneLiner("　一行式：全角缩进也能拆\n\n正文内容");
    t("全角空格缩进哨兵命中拆分", r2.oneLiner === "全角缩进也能拆" && r2.body.startsWith("正文"));
    const r3 = splitOneLiner("一行式：正常无缩进\n\n正文");
    t("无缩进哨兵回归（批次二行为不变）", r3.oneLiner === "正常无缩进");
    const r4 = splitOneLiner("没有哨兵的第一行\n第二行");
    t("无哨兵回退：首个非空行截 60", r4.oneLiner === "没有哨兵的第一行" && r4.body.includes("第二行"));
    // 泄漏断言：缩进变体下 fm summary 不得含哨兵字样
    const raw = [
      "---",
      'douyin_id: "x1"',
      'title: "测试"',
      "---",
      "",
      "> [!abstract] 摘要",
      "> 旧摘要内容（不应被清掉）",
    ].join("\n");
    const out = applySummaryToNote(raw, " 一行式：缩进哨兵\n\n新正文");
    t("缩进哨兵不泄漏进 fm summary", !/一行式/.test(out) && /summary: "缩进哨兵"/.test(out));
    // ② 空白 summary 保护：既有摘要块与 fm summary 保持原样
    const blank = applySummaryToNote(raw, "   \n\t ");
    t("空白 summary 原文返回（不清空既有块）", blank === raw);
    const blank2 = applySummaryToNote("---\ntitle: a\n---\n正文", "");
    t("空白 summary 对无块文件也不新建", blank2 === "---\ntitle: a\n---\n正文");
  }

  // ---------- ④ 向量纯函数 ----------
  {
    const { cosineSim, cosineTopK, contentHash, f32ToB64, b64ToF32 } = m;
    t("cosineSim 自反≈1", Math.abs(cosineSim([1, 2, 3], [1, 2, 3]) - 1) < 1e-9);
    t("cosineSim 正交=0", Math.abs(cosineSim([1, 0], [0, 1])) < 1e-9);
    t("cosineSim 零向量=0（无 NaN）", cosineSim([0, 0], [1, 2]) === 0);
    const table = new Map([
      ["b", [1, 0]],
      ["a", [0.99, 0.1]],
      ["c", [0, 1]],
    ]);
    const hits = cosineTopK([1, 0], table, 2, 0.3);
    t("topK 排序：最高相似在前", hits[0].id === "b" && hits[1].id === "a");
    t("topK 门槛：低于 minScore 被过滤", !hits.some((h) => h.id === "c"));
    t("topK 截断：k=2 只返回两条", hits.length === 2);
    const tie = cosineTopK([1, 0], new Map([["y", [1, 0]], ["x", [1, 0]]]), 5, 0.3);
    t("topK 同分按 id 字典序尾序（确定性）", tie[0].id === "x" && tie[1].id === "y");
    t("contentHash 稳定", contentHash("abc") === contentHash("abc"));
    t("contentHash 区分不同文本", contentHash("abc") !== contentHash("abd"));
    t("contentHash 16 位十六进制", /^[0-9a-f]{16}$/.test(contentHash("任意中文文本")));
    const v = new Float32Array([0.123456789, -3.25, 1e-8]);
    const back = b64ToF32(f32ToB64(v));
    t("Float32 ↔ base64 往返无损", Math.abs(back[0] - v[0]) < 1e-6 && back[1] === -3.25 && Math.abs(back[2] - v[2]) < 1e-12);
  }

  // ---------- ⑤ EmbeddingClient（requestUrl mock） ----------
  {
    const seen = [];
    m.setRequestUrlMock(async (p) => {
      seen.push(p);
      const body = JSON.parse(p.body);
      const rows = body.input.map((txt, i) => ({ index: i, embedding: txt === "乙" ? [0, 1] : [1, 0] }));
      return { status: 200, text: "{}", json: { data: rows } };
    });
    const client = new m.EmbeddingClient("https://api.test/v1/", "sk-test", "text-embedding-v4");
    asyncChecks.push(async () => {
      const vecs = await client.embed(["甲", "乙", "丙", "丁", "戊", "己", "庚", "辛", "壬", "癸", "子", "丑", "寅"]);
      t("embed 切批：13 条 → 2 次请求（10+3）", seen.length === 2 && JSON.parse(seen[1].body).input.length === 3);
      t("embed 结果顺序与输入一一对应", vecs[1][0] === 0 && vecs[0][0] === 1 && vecs[12][0] === 1);
      // index 乱序归位：服务端按乱序 index 返回
      m.setRequestUrlMock(async (p) => {
        const body = JSON.parse(p.body);
        const rows = body.input.map((txt, i) => ({ index: body.input.length - 1 - i, embedding: txt === "低" ? [0, 1] : [1, 0] }));
        return { status: 200, text: "{}", json: { data: rows } };
      });
      const out2 = await client.embed(["高", "低"]);
      t("index 乱序时按 index 对位（而非按数组序）", out2[0][0] === 0 && out2[1][0] === 1);
      // 条数不匹配报错
      m.setRequestUrlMock(async () => ({ status: 200, text: "{}", json: { data: [{ index: 0, embedding: [1] }] } }));
      let threw = "";
      try {
        await client.embed(["一", "二"]);
      } catch (e) {
        threw = String(e.message ?? e);
      }
      t("返回条数不匹配抛明确错误", threw.includes("条数不匹配"));
      // embedOne 软失败：400 立即抛 → null
      m.setRequestUrlMock(async () => ({ status: 400, text: "bad request", json: null }));
      const one = await client.embedOne("任意");
      t("embedOne 失败返回 null（不抛）", one === null);
      // endpoint 拼接：尾斜杠 base → /v1/embeddings
      m.setRequestUrlMock(async (p) => {
        if (p.url !== "https://api.test/v1/embeddings") console.log(`  [round17 debug] endpoint 实际 URL: ${p.url}`);
        t("endpoint 拼接正确（尾斜杠 base 不重复斜杠）", p.url === "https://api.test/v1/embeddings");
        return { status: 200, text: "{}", json: { data: [{ index: 0, embedding: [1] }] } };
      });
      await client.embedBatch(["x"]);
    });
  }

  // ---------- ⑥ VectorStore（内存 KvAdapter） ----------
  {
    const vs = new m.VectorStore({
      exists: async () => false,
      read: async () => {
        throw new Error("not found");
      },
      write: async () => {},
      remove: async () => {},
      rename: async () => {},
    }, "plugdir");
    t("空库起步：size 0 / isModel false", vs.size() === 0 && vs.isModel("text-embedding-v4") === false);
    vs.resetForModel("text-embedding-v4");
    t("resetForModel 后 isModel true", vs.isModel("text-embedding-v4"));
    asyncChecks.push(async () => {
      // persist/load 往返（MiniVault 完整 KvAdapter）
      const kv = new MiniVault(m.TFile, m.TFolder);
      const s1 = new m.VectorStore(kv.adapter, "plugdir");
      await s1.ensureLoaded();
      s1.resetForModel("text-embedding-v4");
      s1.set("a", "hash-a", new Float32Array([0.1234567, 2.5]));
      s1.set("b", "hash-b", new Float32Array([0, 1]));
      await s1.persist();
      t("persist 落盘 vectors.json", kv.kv.has("plugdir/vectors.json"));
      const s2 = new m.VectorStore(kv.adapter, "plugdir");
      await s2.ensureLoaded();
      t("load 往返：size 与 model 保持", s2.size() === 2 && s2.isModel("text-embedding-v4"));
      const rec = s2.get("a");
      t("load 往返：Float32 精度保持", Math.abs(rec.v[0] - 0.1234567) < 1e-6 && rec.h === "hash-a");
      t("pruneExcept 返回删除数", s2.pruneExcept(new Set(["a"])) === 1 && s2.size() === 1);
      // 损坏 JSON → 空库降级不抛
      const kv2 = new MiniVault(m.TFile, m.TFolder);
      kv2.kv.set("plugdir/vectors.json", "{这不是JSON");
      const s3 = new m.VectorStore(kv2.adapter, "plugdir");
      await s3.ensureLoaded();
      t("损坏 vectors.json 空库降级", s3.size() === 0);
    });
  }

  // ---------- ⑦⑧⑨ 引擎级：索引 / 搜索 / 向量互链 ----------
  {
    asyncChecks.push(async () => {
      // 门：通道未配置
      {
        const vault = new MiniVault(m.TFile, m.TFolder);
        seedVault(vault);
        const { engine } = makeEngine(m, vault, { embeddingApiKey: "" });
        engine.attachVectorStore(new m.VectorStore(vault.adapter, "plugdir"));
        const msg = await engine.buildSemanticIndex();
        t("通道未配置：返回不可用文案", msg.includes("不可用") && msg.includes("embedding"));
      }
      // 正常构建 + 增量 + 单篇重算 + 换模型全量 + 孤儿清理
      {
        const vault = new MiniVault(m.TFile, m.TFolder);
        seedVault(vault);
        const { engine, settings } = makeEngine(m, vault, { embeddingApiKey: "sk-test" });
        const app = { vault };
        seedCache(app);
        engine.app = app; // collectRelatedCandidates 读 metadataCache（测试直换 app 引用）
        const vs = new m.VectorStore(vault.adapter, "plugdir");
        engine.attachVectorStore(vs);
        const counter = { calls: 0 };
        installEmbedMock(m, TEXT2VEC(), counter);
        const progresses = [];
        let msg = await engine.buildSemanticIndex((x) => progresses.push(x));
        t("首建：3 篇全部向量化", msg.includes("新增/更新 3") && msg.includes("总 3 篇"));
        t("首建落盘 vectors.json", vault.kv.has("plugdir/vectors.json"));
        const callsAfterFirst = counter.calls;
        // 增量：正文没变 → 零调用
        msg = await engine.buildSemanticIndex();
        t("增量：hash 未变零重算", msg.includes("已是最新") && counter.calls === callsAfterFirst);
        // 单篇重算：只改 n3 正文
        vault.files.set("抖音/收藏/AI 编程/n3.md", {
          data: noteMarkdown({ ...NOTES.n3, body: NOTES.n3.body + "（补充：加点八角桂皮更香。）" }),
          size: 0,
          mtime: 0,
        });
        msg = await engine.buildSemanticIndex();
        t("单篇变化：只重算 1 篇", msg.includes("新增/更新 1") && counter.calls === callsAfterFirst + 1);
        // 换模型全量重算
        settings.embeddingModel = "text-embedding-v1";
        counter.calls = 0;
        msg = await engine.buildSemanticIndex();
        t("换模型：全量重算 3 篇", msg.includes("新增/更新 3") && counter.calls === 1 && vs.isModel("text-embedding-v1"));
        // 孤儿清理：n3 失去 douyin_id → 不再是候选 → 被清掉
        vault.files.set("抖音/收藏/AI 编程/n3.md", {
          data: noteMarkdown(NOTES.n3).replace('douyin_id: "n3"', 'douyin_id: ""'),
          size: 0,
          mtime: 0,
        });
        msg = await engine.buildSemanticIndex();
        t("孤儿清理：候选集外的向量被清", msg.includes("清理孤儿 1 条") && vs.size() === 2);
        // silent 模式（同步收尾自动链）：无缺口/未配置静默空串，有增量才提示
        msg = await engine.buildSemanticIndex(undefined, { silent: true });
        t("silent 无缺口：空串不弹「已是最新」", msg === "");
        vault.files.set("抖音/收藏/AI 编程/n1.md", {
          data: noteMarkdown({ ...NOTES.n1, body: NOTES.n1.body + "（新追加的增量内容。）" }),
          size: 0,
          mtime: 0,
        });
        msg = await engine.buildSemanticIndex(undefined, { silent: true });
        t("silent 有增量：返回增量完成文案", msg.includes("语义索引增量") && msg.includes("新增/更新 1"));
      }
      // semanticSearch：命中排序 + 索引空 null
      {
        const vault = new MiniVault(m.TFile, m.TFolder);
        seedVault(vault);
        const { engine } = makeEngine(m, vault, { embeddingApiKey: "sk-test" });
        const app = { vault };
        seedCache(app);
        engine.app = app; // collectRelatedCandidates 读 metadataCache（测试直换 app 引用）
        const vs = new m.VectorStore(vault.adapter, "plugdir");
        engine.attachVectorStore(vs);
        installEmbedMock(m, TEXT2VEC());
        t("索引空：semanticSearch 返回 null", (await engine.semanticSearch("异步调试")) === null);
        await engine.buildSemanticIndex();
        const res = await engine.semanticSearch("讲异步竞态调试的笔记");
        t("搜索命中：相似度降序", Array.isArray(res) && res.length >= 1 && res[0].score >= (res[1]?.score ?? 1));
        t("搜索命中：n1/n2 排在 n3 前", res.findIndex((r) => r.path.includes("n3")) === -1 || res.findIndex((r) => r.path.includes("n3")) > res.findIndex((r) => r.path.includes("n1")));
        t("搜索命中：携带 path/title/category", typeof res[0].path === "string" && typeof res[0].title === "string");
      }
      // ⑨ 向量互链接线：refreshAllRelatedNotes 走 topK（n1↔n2 相似互链，n3 被门槛过滤）；回落路径
      {
        const vault = new MiniVault(m.TFile, m.TFolder);
        seedVault(vault);
        const { engine } = makeEngine(m, vault, { embeddingApiKey: "sk-test" });
        const app = { vault };
        seedCache(app);
        engine.app = app;
        const vs = new m.VectorStore(vault.adapter, "plugdir");
        engine.attachVectorStore(vs);
        installEmbedMock(m, TEXT2VEC());
        await engine.buildSemanticIndex();
        const r = await engine.refreshAllRelatedNotes();
        t("向量互链重建：3 篇全部扫描、n3 无过门槛候选不写块（宁缺毋滥）", r.scanned === 3 && r.updated === 2);
        const n1md = await vault.read(vault.getAbstractFileByPath("抖音/收藏/AI 编程/n1.md"));
        t("n1 互链 n2（向量相似）", /相关笔记/.test(n1md) && n1md.includes("n2"));
        t("n1 不链 n3（低于相似度门槛）", !/n3\.md|n3\]\]/.test(n1md.split("相关笔记")[1] ?? ""));
        const n3md = await vault.read(vault.getAbstractFileByPath("抖音/收藏/AI 编程/n3.md"));
        t("n3 无过门槛候选 → 块被移除（宁缺毋滥）", !/相关笔记/.test(n3md));
        // 回落：索引清空后重建 → 同分类打分路径（n2/n3 同分类仍互链）
        vs.resetForModel("nonexistent-model");
        const r2 = await engine.refreshAllRelatedNotes();
        const n1md2 = await vault.read(vault.getAbstractFileByPath("抖音/收藏/AI 编程/n1.md"));
        t("索引缺席回落同分类打分：n1 链回 n2/n3", r2.updated === 3 && /n2/.test(n1md2) && /n3/.test(n1md2));
      }
      // ③ recategorize 移动失败补偿回滚
      {
        const vault = new MiniVault(m.TFile, m.TFolder);
        vault.files.set("抖音/收藏/未分类/n1.md", {
          data: noteMarkdown(NOTES.n1, "未分类"),
          size: 0,
          mtime: 0,
        });
        const { engine } = makeEngine(
          m,
          vault,
          { enableCategory: true, aiKey: "sk-test" },
          { fileManager: { renameFile: async () => { throw new Error("disk full"); } } },
        );
        engine.ai = { categorize: async () => "AI 编程" };
        engine.state.processed["n1"] = { path: "抖音/收藏/未分类/n1.md", folder: "未分类" };
        const msg = await engine.recategorizeUncategorized();
        t("移动失败：计入失败", msg.includes("失败 1"));
        t("移动失败：文件仍在原目录", vault.files.has("抖音/收藏/未分类/n1.md") && !vault.files.has("抖音/收藏/AI 编程/n1.md"));
        const md = await vault.read(vault.getAbstractFileByPath("抖音/收藏/未分类/n1.md"));
        t("移动失败：fm category 回滚不留中间态", /category: "?未分类"?/.test(md) && !/category: "?AI 编程"?/.test(md));
      }
      // ⑥' buildSemanticIndex 配额耗尽：友好文案 + 已成功批次落盘（不白付费）
      {
        const vault = new MiniVault(m.TFile, m.TFolder);
        for (let i = 0; i < 11; i++) {
          const n = { id: `q${i}`, title: `配额测试${i}`, body: `配额测试笔记${i}：语义索引配额耗尽场景内容块 ${i}` };
          vault.files.set(`抖音/收藏/AI 编程/q${i}.md`, { data: noteMarkdown(n), size: 0, mtime: 0 });
        }
        const { engine } = makeEngine(m, vault, { embeddingApiKey: "sk-test" });
        const app = { vault };
        seedCache(app);
        engine.app = app;
        const vs = new m.VectorStore(vault.adapter, "plugdir");
        engine.attachVectorStore(vs);
        let callN = 0;
        m.EmbeddingClient.prototype.embed = async (inputs) => {
          callN++;
          if (callN >= 2) throw new Error('embedding HTTP 400: {"error":{"message":"Free quota exhausted. To continue accessing the model on a paid basis, please add funds"}}');
          return inputs.map(() => [0.5, 0.5]);
        };
        let threw = "";
        try {
          await engine.buildSemanticIndex();
        } catch (e) {
          threw = String(e.message ?? e);
        }
        t("配额耗尽：友好中文文案含两条出路（充值/换 bge-m3）", threw.includes("额度已耗尽") && threw.includes("bge-m3"));
        t("配额耗尽：已成功批次（首批 10 条）向量已落盘", vs.size() === 10 && vault.kv.has("plugdir/vectors.json"));
      }
    });
  }

  return {
    get pass() {
      return tests.filter(([, c]) => c).length;
    },
    get fail() {
      return tests.filter(([, c]) => !c).length;
    },
    // runner 契约：async 是函数且被 await——逐个执行收集到的异步用例函数（断言先跑完再累计）
    async: async () => {
      for (const fn of asyncChecks) await fn();
    },
  };
}
