// 对抗性测试盲区补强（2026-09-27 第十轮）：第九轮修复项中缺测的 A8/A11/A7/C3/C5、
// 第六轮 loadState 消毒与 BOM 修复、B1 降档端到端、OCR 通道、收藏夹模式 syncAll、
// processManager（项目内首个 PM 用例）与 noteBuilder 特殊字符往返。
// PM 用例依赖 util.nodeRequireFn 的 window.require 约定（src/util.ts），用例内 save/restore，不影响其他套件。
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const nodeRequireReal = createRequire(import.meta.url);

// ---------- 引擎级测试替身（与 tests/sync-engine.test.mjs 同款 MiniVault） ----------

class MiniVault {
  constructor(TFile, TFolder) {
    this.TFile = TFile;
    this.TFolder = TFolder;
    this.files = new Map(); // path -> { data: string|Buffer, size, mtime }
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
  async createBinary(path, buf) {
    path = this.norm(path);
    if (this.files.has(path)) throw new Error(`createBinary: 已存在 ${path}`);
    this.files.set(path, { data: buf, size: buf.byteLength, mtime: 0 });
    return this.makeFile(path, buf);
  }
  async modifyBinary(file, buf) {
    const path = this.norm(file.path ?? file);
    if (!this.files.has(path)) throw new Error(`modifyBinary: 不存在 ${path}`);
    this.files.set(path, { data: buf, size: buf.byteLength, mtime: 0 });
  }
  async createFolder(path) {
    path = this.norm(path);
    if (this.folders.has(path) || this.files.has(path)) throw new Error(`createFolder: 已存在 ${path}`);
    this.folders.add(path);
    return null;
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
  async modify(file, content) {
    const path = this.norm(file.path ?? file);
    if (!this.files.has(path)) throw new Error(`modify: 不存在 ${path}`);
    this.files.set(path, { data: content, size: Buffer.byteLength(content, "utf8"), mtime: 0 });
  }
  getFiles() {
    return [...this.files.keys()].map((k) => this.makeFile(k, this.files.get(k).data));
  }
  getMarkdownFiles() {
    return this.getFiles();
  }
  async delete(file) {
    this.files.delete(this.norm(file.path ?? file));
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

function blankSummary() {
  return {
    total: 0, created: 0, skipped: 0, transcribed: 0, asrFailed: 0, asrSkipped: 0,
    visionOk: 0, videoSummaries: 0, errors: [], notices: [], startedAt: "", finishedAt: "",
  };
}

const rawVideo = (id, over = {}) => ({
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
  ...over,
});

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
  const calls = { onStateChange: 0, saveImage: [], pullAssets: [], cleanup: [] };
  const engine = new m.SyncEngine(
    { vault },
    settings,
    async () => { calls.onStateChange++; },
    () => {},
  );
  engine.media = {
    saveImage: async (url, rel) => { calls.saveImage.push(rel); return `抖音/Media/${rel}.jpg`; },
    dataUrlFromFile: async () => "",
    toDataUrl: async () => "",
  };
  engine.videoMedia = {
    updateClient() {},
    checkFfmpeg: async () => null,
    pullAssets: async (item, opts) => {
      calls.pullAssets.push({ id: item.id, opts });
      return { assets: { audioPath: "", framePaths: [] }, error: "", errorKind: "none" };
    },
    cleanup: (id) => calls.cleanup.push(id),
  };
  return { engine, calls, settings };
}

// ---------- 用例 ----------

export function runTests(m) {
  const { DEFAULT_SETTINGS, DouyinClient, ProcessManager, TFile, TFolder, setRequestUrlMock } = m;
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
    console.log("— backfillVideos：预算 0 = 只补「可复用转录」候选且上限 50（A11）—");
    {
      const vault = new MiniVault(TFile, TFolder);
      const { engine } = makeEngine(m, vault, { maxTranscribePerSync: 0 });
      const mkNote = (withTranscript) => {
        const lines = ["---", "type: 视频", withTranscript ? "transcript_status: success" : "transcript_status: failed", "transcript_provider: test", "---", ""];
        if (withTranscript) lines.push("> [!quote]- 逐字稿（test）", "> 可复用的转录内容", "");
        return lines.join("\n");
      };
      for (let i = 0; i < 52; i++) {
        const id = "910" + String(i).padStart(13, "0"); // 16 位数字 id：保持对象键插入序 + 通过 normalize 校验
        const p = `抖音/收藏/夹/note [${id}].md`;
        await vault.create(p, mkNote(true));
        engine.state.processed[id] = { path: p, syncedAt: "t", folder: "夹", source: "collection" };
      }
      const paidId = "9200000000000001";
      const paidPath = `抖音/收藏/夹/note [${paidId}].md`;
      await vault.create(paidPath, mkNote(false));
      engine.state.processed[paidId] = { path: paidPath, syncedAt: "t", folder: "夹", source: "collection" };
      const captured = [];
      engine.processItem = async (...args) => { captured.push(args); return true; };
      let detailCalls = 0;
      DouyinClient.prototype.getAwemeDetail = async (id) => { detailCalls++; return rawVideo(id); };
      const report = await engine.backfillVideos();
      delete DouyinClient.prototype.getAwemeDetail;
      t("预算 0：52 条免费候选只跑前 50（REUSE_ONLY_CAP）", captured.length === 50 && report.includes("处理 50"));
      t("每条候选都带 asrOverride（零 ASR 计费）", captured.every((a) => a[5] && a[5].status === "success" && String(a[5].transcript).includes("可复用")));
      t("付费候选（transcript_status=failed）不在本轮", !captured.some((a) => a[0].id === paidId));
      t("详情调用同样只 50 次", detailCalls === 50);

      // budget > 0 时行为不变：免费候选占预算，付费候选按预算排除
      const vault2 = new MiniVault(TFile, TFolder);
      const { engine: e2 } = makeEngine(m, vault2, { maxTranscribePerSync: 1 });
      const free2 = "9300000000000001";
      const paid2 = "9400000000000001";
      await vault2.create(`抖音/收藏/夹/note [${free2}].md`, mkNote(true));
      await vault2.create(`抖音/收藏/夹/note [${paid2}].md`, mkNote(false));
      e2.state.processed[free2] = { path: `抖音/收藏/夹/note [${free2}].md`, syncedAt: "t", folder: "夹", source: "collection" };
      e2.state.processed[paid2] = { path: `抖音/收藏/夹/note [${paid2}].md`, syncedAt: "t", folder: "夹", source: "collection" };
      const captured2 = [];
      e2.processItem = async (...args) => { captured2.push(args); return true; };
      DouyinClient.prototype.getAwemeDetail = async (id) => rawVideo(id);
      await e2.backfillVideos();
      delete DouyinClient.prototype.getAwemeDetail;
      t("预算 1：只补一条且带可复用转录（budget>0 语义不变）", captured2.length === 1 && !!captured2[0][5]);
    }

    // =====================================================================
    console.log("— backfillVideos：transcript_status=success 但逐字稿为空 → 不伪造 asrOverride（A8）—");
    {
      const vault = new MiniVault(TFile, TFolder);
      const { engine } = makeEngine(m, vault, { maxTranscribePerSync: 5 });
      const id = "9500000000000001";
      const p = `抖音/收藏/夹/note [${id}].md`;
      // frontmatter 盖章 success，但逐字稿块只有头没有内容（历史矛盾笔记形态）
      await vault.create(p, ["---", "type: 视频", "transcript_status: success", "transcript_provider: test", "---", "", "> [!quote]- 逐字稿（test）", ""].join("\n"));
      engine.state.processed[id] = { path: p, syncedAt: "t", folder: "夹", source: "collection" };
      const captured = [];
      engine.processItem = async (...args) => { captured.push(args); return true; };
      DouyinClient.prototype.getAwemeDetail = async () => rawVideo(id);
      await engine.backfillVideos();
      delete DouyinClient.prototype.getAwemeDetail;
      t("空逐字稿条目仍是补跑候选（矛盾状态不跳过）", captured.length === 1 && captured[0][0].id === id);
      t("A8：asrOverride=undefined（回退正常转写自愈，而非拿空转录盖章 success）", captured[0][5] === undefined);
      t("A8：帧网格未达标 → 明确重抽意图 reextract=true", captured[0][7] === true);
    }

    // =====================================================================
    console.log("— loadState：asrRetry 台账形状消毒（第六轮 #8 回归锁：旧 bug 中止整轮重试）—");
    {
      const vault = new MiniVault(TFile, TFolder);
      const { engine } = makeEngine(m, vault, {});
      await engine.loadState({ processed: {}, pendingAsr: [], asrRetry: {
        bad: { attempts: "abc", nextRetryAt: "不是日期", lastError: 42 },
        neg: { attempts: -5, nextRetryAt: "2026-01-01T00:00:00.000Z" },
        frac: { attempts: 2.9, nextRetryAt: "2026-01-02T00:00:00.000Z" },
      } });
      const r = engine.state.asrRetry;
      t("非数字/负数 attempts → 0", r.bad.attempts === 0 && r.neg.attempts === 0);
      t("小数 attempts → floor（2.9 → 2）", r.frac.attempts === 2);
      t("非法 nextRetryAt → epoch（立即可试，不 NaN）", Date.parse(r.bad.nextRetryAt) === 0);
      t("合法 nextRetryAt 原样保留", r.neg.nextRetryAt === "2026-01-01T00:00:00.000Z");
      t("lastError 非字符串 → String 化且截断安全", r.bad.lastError === "42");
      let noThrow = true, attemptsAfter = -1;
      try {
        engine.bumpAsrRetry("bad", "boom");
        attemptsAfter = engine.state.asrRetry.bad.attempts;
      } catch { noThrow = false; }
      t("消毒后 bump 不再抛 RangeError（旧 bug：attempts+1 字符串拼接 → new Date(NaN).toISOString()）", noThrow && attemptsAfter === 1);
      t("bump 后进入正常退避", engine.asrRetryReady("bad") === false);
    }

    // =====================================================================
    console.log("— 转写暂存 FIFO：>20 淘汰最旧、无效 at 优先淘汰（B3 补强）—");
    {
      const vault = new MiniVault(TFile, TFolder);
      const { engine } = makeEngine(m, vault, {});
      engine.state.transcriptCache = {};
      for (let i = 0; i < 20; i++) {
        engine.state.transcriptCache[`k${i}`] = { transcript: "t", provider: "p", at: new Date(1700000000000 + i * 1000).toISOString() };
      }
      engine.stashTranscript("new1", { status: "success", transcript: "x", provider: "p" });
      let keys = Object.keys(engine.state.transcriptCache);
      t("第 21 条入暂存：最旧的 k0 被淘汰、暂存恒 20 条", keys.length === 20 && !keys.includes("k0") && keys.includes("new1") && keys.includes("k19"));
      engine.state.transcriptCache["broken"] = { transcript: "t", provider: "", at: "not-a-date" };
      engine.stashTranscript("new2", { status: "success", transcript: "y", provider: "p" });
      keys = Object.keys(engine.state.transcriptCache);
      t("at 非法（Date.parse 失败按 0）的条目优先淘汰", keys.length === 20 && !keys.includes("broken") && keys.includes("new2"));
    }

    // =====================================================================
    console.log("— BOM 笔记：stripBom 统一去字节序标记（第四轮修复回归锁，Bases 全过滤的病根）—");
    {
      const body = [
        "---", 'title: "示例"', 'type: "视频"', "category: 投资理财",
        'cover: "抖音/Media/cover/x.jpg"', "frame_interval: 10", "---", "",
        "> [!quote]- 逐字稿（test）", "> 转录内容",
      ].join("\n");
      const bom = "\uFEFF" + body;
      t("frontmatterBlock：BOM 不再让 fm 判定失配", m.frontmatterBlock(bom).includes('type: "视频"'));
      const a = m.collectExistingAssets(bom);
      t("collectExistingAssets：BOM 笔记资产正常回收（cover/category/frame_interval）",
        a.category === "投资理财" && a.coverPath === "抖音/Media/cover/x.jpg" && a.frameInterval === "10");
      t("extractSummarySources：BOM 笔记逐字稿可读回（摘要输入源不丢）", m.extractSummarySources(bom).transcript.includes("转录内容"));
      const out = m.applySummaryToNote(bom, "新摘要", 3);
      const fm = m.frontmatterBlock(out);
      t("applySummaryToNote：summary 写进既有 frontmatter（而非新建第二围栏）", fm.includes('summary: "新摘要"') && /^summary_v: 3$/m.test(fm));
      t("写入后正文逐字稿逐字保留", out.includes("> 转录内容"));
    }

    // =====================================================================
    console.log("— 视频摘要降档端到端：图片数超限 → 降档重试 → 成功落盘（B1 集成，纯函数外的消费链；2026-10-16 帧减量后首档 3）—");
    {
      const vault = new MiniVault(TFile, TFolder);
      const framePaths = Array.from({ length: 6 }, (_, i) => `抖音/Media/frames/b1000001/frame_0${i + 1}.jpg`);
      for (const p of framePaths) vault.files.set(p, { data: "fakejpeg", size: 8, mtime: 0 });
      const notePath = "抖音/收藏/夹/B1 [b1000001].md";
      const file = await vault.create(notePath, "---\ntype: 视频\n---\n\n正文");
      const settings = makeSettings(DEFAULT_SETTINGS, {
        videoSummaryEnabled: true,
        videoSummaryBaseUrl: "https://b1-e2e.example/v1",
        videoSummaryApiKey: "k-b1",
        summaryMaxTokens: 500,
        keyframeIntervalSec: 10,
      });
      const seenImageCounts = [];
      let call = 0;
      setRequestUrlMock(async (p) => {
        if (!/\/chat\/completions$/.test(p.url)) throw new Error("意外端点 " + p.url);
        call++;
        const body = JSON.parse(p.body);
        seenImageCounts.push(body.messages[0].content.filter((c) => c.type === "image_url").length);
        if (call === 1) {
          // 6 帧 × 上限 2 张的模型：首档 3 命中图片数超限（不得包含 max_tokens 字样，避开钳制分支）
          return { status: 400, text: '{"error":{"message":"input image count exceeds the model limit"}}' };
        }
        const payload = { choices: [{ message: { content: "主题:测试主题\n\n## 引言\n核心问题：测试。\n\n## AI 总结\n测试摘要。" }, finish_reason: "stop" }] };
        return { status: 200, text: JSON.stringify(payload), json: payload };
      });
      const r = await m.generateAndWriteVideoSummary({ vault }, file, settings, {
        title: "测试视频", desc: "", transcript: "口播内容", framePaths,
      });
      noNet();
      t("首档 3 帧请求实际送出 3 张（6 帧均匀抽样）", seenImageCounts[0] === 3);
      t("400 图片超限 → 降档 2 张重试（B1 旧判定在此 break，摘要永久失败）", seenImageCounts[1] === 2);
      t("降档后成功且 framesUsed=2（可反推降档发生）", r.ok === true && r.record?.framesUsed === 2);
      const content = vault.files.get(notePath).data;
      // 批次二 v4：SUMMARY_V 3 → 4，写盘版本号随常量同步升级
      t("summary_v: 4 与 summary_style 落盘", /^summary_v: 4$/m.test(content) && content.includes('summary_style: "hierarchy"'));
      t("摘要块写入且版本门生效", content.includes("> [!abstract]- 摘要") && content.includes("测试摘要"));
    }

    // =====================================================================
    console.log("— processItem：可重试类素材失败（network）入重试队列（确定性失败不入队的对侧）—");
    {
      const vault = new MiniVault(TFile, TFolder);
      const { engine, calls } = makeEngine(m, vault, {
        asrProvider: "siliconflow_sensevoice",
        siliconflowKey: "k",
      });
      engine.videoMedia.pullAssets = async () => ({ assets: null, error: "网络抖动", errorKind: "network" });
      const item = DouyinClient.normalize(rawVideo("970001"), "collection");
      const summary = blankSummary();
      const ok = await engine.processItem(item, "夹", summary, undefined);
      t("笔记仍落盘、cleanup 幂等执行", ok === true && !!engine.state.processed["970001"] && calls.cleanup.includes("970001"));
      t("network 类素材失败入重试队列（attempts=0 立即可试）", engine.state.pendingAsr.includes("970001") && engine.state.asrRetry["970001"]?.attempts === 0 && engine.asrRetryReady("970001") === true);
      t("素材拉取失败原因可见", summary.errors.some((e) => e.includes("视频素材拉取失败")));
      t("不误标「素材侧，不重试」（瞬时网络失败必须可重试）", !summary.errors.some((e) => e.includes("素材侧，不重试")));
      t("asrFailed 计数 1", summary.asrFailed === 1);
    }

    // =====================================================================
    console.log("— assertCookie：桥接模式跳过 Cookie 校验（C3）/ 直连仍强制 —");
    {
      setRequestUrlMock(async (p) => {
        if (p.url === "http://127.0.0.1:8765/req") {
          const inner = JSON.stringify({ status_code: 0, has_more: false, cursor: 0, aweme_list: [] });
          return { status: 200, text: JSON.stringify({ status: 200, text: inner }) };
        }
        throw new Error("意外请求 " + p.url);
      });
      const bridgeClient = new DouyinClient("", "http://127.0.0.1:8765");
      let page = null;
      try { page = await bridgeClient.listCollection(0, 20); } catch { /* C3 回归会在此抛缺 sessionid */ }
      t("桥接模式 + 空 Cookie：listCollection 正常（照设置页文案不填 Cookie 不再硬报错）", !!page && page.ok === true && page.items.length === 0);
      const direct = new DouyinClient("", undefined);
      let threw = "";
      try { await direct.listCollection(0, 20); } catch (e) { threw = String(e?.message ?? e); }
      t("直连 + 空 Cookie：仍给出指向设置页的明确错误", threw.includes("sessionid"));
      noNet();
    }

    // =====================================================================
    console.log("— douyinClient.listFolders：循环翻页聚合 + collections/collection_list 双键回退 + 页数上限 —");
    {
      let page = 0;
      setRequestUrlMock(async (p) => {
        if (!p.url.includes("collection/list")) throw new Error("意外请求 " + p.url);
        page++;
        if (page === 1) {
          const collections = Array.from({ length: 20 }, (_, i) => ({ collection_id: `c${i}`, collect_name: `夹${i}` }));
          return { status: 200, text: JSON.stringify({ collections, has_more: true, cursor: 20 }), json: { collections, has_more: true, cursor: 20 } };
        }
        const collection_list = [{ id: "cX", name: "末页夹" }];
        return { status: 200, text: JSON.stringify({ collection_list, has_more: false }), json: { collection_list, has_more: false } };
      });
      const c = new DouyinClient("sessionid=x;");
      const folders = await c.listFolders(0, 20);
      t("两页聚合 21 个（旧实现单页截断静默丢第 21 个）", folders.length === 21 && folders[20].name === "末页夹");
      t("collections / collection_list 双键都能取到", folders[0].name === "夹0");
      let endless = 0;
      setRequestUrlMock(async () => {
        endless++;
        const list = [{ id: `e${endless}`, name: `夹${endless}` }];
        return { status: 200, text: JSON.stringify({ collections: list, has_more: true, cursor: endless }), json: { collections: list, has_more: true, cursor: endless } };
      });
      const c2 = new DouyinClient("sessionid=x;");
      const folders2 = await c2.listFolders(0, 20);
      t("has_more 永真：50 页上限兜底（不无限翻页）", folders2.length === 50);
      noNet();
    }

    // =====================================================================
    console.log("— recognizeImageTexts：OCR 通道集成（成功/失败行、visionOk、不炸主流程）—");
    {
      const vault = new MiniVault(TFile, TFolder);
      const { engine, calls } = makeEngine(m, vault, {
        enableVision: true,
        aiKey: "k-ocr",
        downloadImages: false,
      });
      let call = 0;
      setRequestUrlMock(async (p) => {
        if (!/\/chat\/completions$/.test(p.url)) throw new Error("意外请求 " + p.url);
        call++;
        if (call === 1) {
          const payload = { choices: [{ message: { content: "画面里的文字甲" }, finish_reason: "stop" }] };
          return { status: 200, text: JSON.stringify(payload), json: payload };
        }
        throw new Error("网络断开");
      });
      const item = DouyinClient.normalize(rawNote("980001", 2), "collection");
      const summary = blankSummary();
      const ok = await engine.processItem(item, "夹", summary, undefined);
      noNet();
      t("单图 OCR 失败不炸整条 processItem", ok === true && !!engine.state.processed["980001"]);
      t("识别成功计数 visionOk=1", summary.visionOk === 1);
      const path = engine.state.processed["980001"]?.path ?? "";
      const content = path ? vault.files.get(path).data : "";
      t("图 1 成功行与文字落笔记", content.includes("**图 1**（识别成功）") && content.includes("> 画面里的文字甲"));
      t("图 2 失败行带原因落笔记（不静默丢图）", content.includes("**图 2**（识别失败：网络断开）"));
      t("图文条目不走视频素材拉取", calls.pullAssets.length === 0);
    }

    // =====================================================================
    console.log("— syncAll 收藏夹模式：白名单过滤 + folderOk 语义（flat 不该被触发）—");
    {
      const vault = new MiniVault(TFile, TFolder);
      const { engine } = makeEngine(m, vault, {
        syncCollection: true,
        useFolderMode: true,
        folderWhitelist: "甲",
      });
      const itemCalls = [];
      DouyinClient.prototype.listFolders = async () => [{ id: "f1", name: "甲" }, { id: "f2", name: "乙" }];
      DouyinClient.prototype.listFolderItems = async (id) => {
        itemCalls.push(id);
        return { ok: true, hasMore: false, cursor: 20, items: [rawNote("990001")] };
      };
      DouyinClient.prototype.listCollection = async () => { throw new Error("扁平兜底不应被调用"); };
      const summary = await engine.syncAll();
      delete DouyinClient.prototype.listFolders;
      delete DouyinClient.prototype.listFolderItems;
      delete DouyinClient.prototype.listCollection;
      t("白名单命中收藏夹同步：created=1", summary.created === 1);
      t("白名单外收藏夹不拉取", itemCalls.length === 1 && itemCalls[0] === "f1");
      t("folderOk=true：扁平兜底未触发（listCollection 零调用）", !summary.errors.some((e) => e.includes("扁平兜底")));
      t("台账 folder=甲", engine.state.processed["990001"]?.folder === "甲");
    }

    // =====================================================================
    console.log("— writeAsrErrorNote：多行错误压行（A7）+ 块尾 --- 边界 + 无块不动 —");
    {
      const vault = new MiniVault(TFile, TFolder);
      const { engine } = makeEngine(m, vault, {});
      const p = "抖音/收藏/夹/WE [we0001].md";
      await vault.create(p, [
        "---", "type: 视频", "transcript_status: failed", "---", "",
        "> [!warning]- 逐字稿", "> 转写未成功：旧错误", "> 可用命令「重试失败转写」重试。",
        "---", "", "*同步于 2026-09-27T00:00:00.000Z ｜ douyin-sync*", "",
      ].join("\n"));
      await engine.writeAsrErrorNote(p, "第一行错误\n第二行错误\n第三行错误");
      const content = vault.files.get(p).data;
      t("多行错误压成单行（多行直接嵌入会破 callout 结构与块尾判定）", content.includes("> 转写未成功：第一行错误 第二行错误 第三行错误"));
      t("块尾 --- 与尾注保留（\\n--- 边界生效）", content.includes("---\n\n*同步于 2026-09-27T00:00:00.000Z ｜ douyin-sync*"));
      t("旧错误被替换", !content.includes("旧错误"));
      const p2 = "抖音/收藏/夹/WE [we0002].md";
      const successNote = ["---", "type: 视频", "transcript_status: success", "---", "", "> [!quote]- 逐字稿", "> 转录内容"].join("\n");
      await vault.create(p2, successNote);
      await engine.writeAsrErrorNote(p2, "不应写入");
      t("无 warning 块（已成功）的笔记原样不动", vault.files.get(p2).data === successNote);
    }

    // =====================================================================
    console.log("— buildNote 特殊字符标题：YAML 标量 / 文件名 / 生态解析往返 —");
    {
      const nastyTitle = '标题:带冒号 "引号" 与\\反斜杠 🎬 #话题';
      const item = {
        id: "7301234567890123456", type: "video", source: "collection",
        title: nastyTitle, desc: nastyTitle + "\n第二行", author: "作者",
        authorId: "sec", createTime: 1758900000,
        playUrl: "https://www.douyin.com/video/x", coverUrl: "", imageUrls: [],
        durationSec: 23, awemeType: 0, mediaType: 0,
        stats: { likes: 1, comments: 0, collects: 0, shares: 0 },
      };
      const title = m.noteTitleFor(item.title, item.id);
      const path = m.planNotePath("抖音", item, '夹名:含"引号"', title);
      const base = path.split("/").pop().replace(/\.md$/, "");
      t("文件名无非法字符且保留 [id] 后缀（findNotePath 的 suffix 判据不被标题污染）",
        !/[\\/:*?"<>|#]/.test(base) && path.endsWith("[7301234567890123456].md"));
      const note = m.buildNote({
        item, folder: "夹", category: "投资理财", coverPath: "", imagesDownloaded: [],
        visionTexts: [], asr: null, framePaths: [], keyframeIntervalSec: 10,
        syncedAt: "2026-09-27T00:00:00.000Z",
      });
      const fm = m.frontmatterBlock(note);
      t("frontmatter 围栏完整且 type/douyin_id 判定命中（YAML 注入不破围栏）",
        /^type:\s*"?(视频)"?\s*$/m.test(fm) && /^douyin_id: "7301234567890123456"$/m.test(fm) && (fm.match(/---/g) || []).length === 2);
      t("标题经 JSON 双引号标量保真（冒号/引号/反斜杠/emoji）", fm.includes("🎬") && fm.includes('douyin_id: "7301234567890123456"'));
      const assets = m.collectExistingAssets(note);
      t("重建回收：category 引号无关可解析", assets.category === "投资理财");
      const withSummary = m.applySummaryToNote(note, "新摘要", 3);
      t("特殊标题笔记上可安全写摘要（仍落 fm 区）", m.frontmatterBlock(withSummary).includes('summary: "新摘要"') && withSummary.includes("> [!abstract]- 摘要"));
      t("emoji 标题逐字保留在正文 H1", note.includes("# " + nastyTitle));
    }

    // =====================================================================
    console.log("— processManager：C5 双拉起败者 PID 不盖台账 / 正常拉起写入台账 —");
    {
      const savedWindow = globalThis.window;
      const execLog = [];
      const taskkillLog = [];
      let netstatOut = "";
      let tasklistOut = "";
      let cimOut = "";
      const fakeChild = { pid: 4242, unref() {}, stderr: { on() {} }, on() {} };
      let onSpawn = () => {};
      const fakeCp = {
        exec(cmd, opts, cb) {
          execLog.push(cmd);
          const out = cmd.startsWith("netstat")
            ? netstatOut
            : cmd.includes("tasklist")
              ? tasklistOut
              : cmd.includes("Get-CimInstance")
                ? cimOut
                : cmd.includes("taskkill")
                  ? (taskkillLog.push(cmd), "SUCCESS")
                  : "";
          cb(null, out);
        },
        spawn() { onSpawn(); return fakeChild; },
      };
      // util.nodeRequireFn 走 (window as any).require：注入 window shim 让 PM 拿到 fake child_process
      globalThis.window = { require: (id) => (id === "child_process" ? fakeCp : nodeRequireReal(id)) };
      try {
        const mkPm = (shutdownStatus) => {
          const pmState = { bridgePid: -1, panelPid: -1, treePids: [], lastStartAt: null, lastStopAt: null, lastCommandKey: null, lastErrorCode: null, updatedAt: null };
          const settings = { ...DEFAULT_SETTINGS, bridgeUrl: "http://127.0.0.1:8765", bridgeNodePath: "node", bridgeNodeModules: "" };
          let bridgeUp = false;
          const notifies = [];
          const states = [];
          const pm = new ProcessManager({
            getSettings: () => settings,
            getPmState: () => pmState,
            persist: async () => {},
            notify: (level, code, msg) => notifies.push({ level, code, msg }),
            onProcessState: (ps) => states.push(ps),
            bridgeScriptPath: () => "C:/fake/douyin-bridge.js",
            pluginDir: () => "C:/fake",
          });
          setRequestUrlMock(async (p) => {
            if (p.url === "http://127.0.0.1:8765/ping") {
              if (!bridgeUp) throw new Error("ECONNREFUSED");
              return { status: 200, json: { ok: true, ready: true, kernel: "playwright" }, text: "" };
            }
            if (p.url === "http://127.0.0.1:8765/shutdown") return { status: shutdownStatus, text: "" };
            throw new Error("意外请求 " + p.url);
          });
          return { pm, pmState, notifies, states, setBridgeUp: (v) => { bridgeUp = v; } };
        };

        // 场景 A：与引擎路径并发双拉起，外部胜者先就绪（netstat 监听者 999 ≠ 本子进程 4242）
        netstatOut = "  TCP    127.0.0.1:8765     0.0.0.0:0    LISTENING    999\r\n";
        const A = mkPm(404);
        onSpawn = () => A.setBridgeUp(true);
        const rA = await A.pm.start();
        t("双拉起：胜者就绪 → start 成功、状态 running", rA.ok === true && A.states.includes("running"));
        t("C5：败者子进程 PID(4242) 不盖 bridgePid / treePids（台账不被死 PID 污染）", A.pmState.bridgePid === -1 && A.pmState.treePids.length === 0);
        t("无 P0 通知", !A.notifies.some((n) => n.level === "P0"));

        // 场景 B：端口监听者就是自己拉起的子进程 → 正常写台账
        netstatOut = "  TCP    127.0.0.1:8765     0.0.0.0:0    LISTENING    4242\r\n";
        const B = mkPm(404);
        onSpawn = () => B.setBridgeUp(true);
        const rB = await B.pm.start();
        t("正常拉起：bridgePid=4242 且 treePids 登记", rB.ok === true && B.pmState.bridgePid === 4242 && B.pmState.treePids.includes(4242));

        // ---- dispose：强杀前身份校验（防 Windows PID 复用误杀无关进程树）----
        console.log("— processManager.dispose：非 bridge node 进程不杀 / 命中指纹才杀 —");
        // 场景 C：持久化 PID 已被 chrome.exe 复用 → 不 taskkill
        netstatOut = "  TCP    127.0.0.1:8765     0.0.0.0:0    LISTENING    777\r\n";
        tasklistOut = '"chrome.exe","777","Chrome","1234",...';
        cimOut = "";
        const C = mkPm(404);
        C.pmState.bridgePid = 777;
        C.pmState.treePids = [777];
        C.setBridgeUp(true);
        await C.pm.dispose();
        t("PID 被 chrome.exe 复用：不执行 taskkill（宁可放过）", taskkillLog.length === 0);
        t("dispose 后台账清空", C.pmState.bridgePid === -1 && C.pmState.treePids.length === 0);

        // 场景 D：node.exe + 命令行含 douyin-bridge.js → 确认是自己的桥，整树终止
        tasklistOut = '"node.exe","777","Console","1234",...';
        cimOut = "node.exe  C:\\fake\\douyin-bridge.js 8765";
        const D = mkPm(404);
        D.pmState.bridgePid = 777;
        D.pmState.treePids = [777];
        D.setBridgeUp(true);
        await D.pm.dispose();
        t("命中 douyin-bridge.js 指纹：taskkill /F /T 执行", taskkillLog.some((c) => c.includes("taskkill /F /T /PID 777")));
      } finally {
        if (savedWindow === undefined) delete globalThis.window;
        else globalThis.window = savedWindow;
        noNet();
      }
    }

    // =====================================================================
    console.log("— 第十轮 F1：撞库路径复用笔记既有逐字稿（台账丢失重同步不重复计费、不降级重写）—");
    {
      const vault = new MiniVault(TFile, TFolder);
      const { engine } = makeEngine(m, vault, { videoSummaryEnabled: false });
      // 台账为空（重置状态后重同步），但笔记已在库：success 逐字稿 + v3 摘要
      const id = "9110000000000001";
      const p = `抖音/收藏/夹/note [${id}].md`;
      await vault.create(p, [
        "---", "type: 视频", "category: 投资理财",
        "transcript_status: success", "transcript_provider: siliconflow_sensevoice",
        "frame_interval: 10", "summary_v: 3", "---", "",
        "> [!quote]- 逐字稿（siliconflow_sensevoice）", "> 笔记里已有的付费转录内容", "",
        "> [!abstract]- 摘要", "> 精修摘要内容", "",
      ].join("\n"));
      const item = DouyinClient.normalize(rawVideo(id), "collection");
      const summary = blankSummary();
      const ok = await engine.processItem(item, "夹", summary, undefined);
      const content = vault.files.get(p)?.data ?? "";
      t("F1：重建笔记保留既有逐字稿（不再重新下载转写）", ok === true && content.includes("笔记里已有的付费转录内容"));
      t("F1：transcript_status 保持 success（不被 asr=null 的重写降级）", /^transcript_status:\s*"?success"?/m.test(content));
      t("F1：不入重试队列（逐字稿复用后无转写失败）", !engine.state.pendingAsr.includes(id));
      t("F1：台账重建成功", !!engine.state.processed[id]);

      // 对侧：transcript_status=failed 的撞库条目不构造 asrOverride（不得把旧稿伪造成 success）
      const id2 = "9110000000000002";
      const p2 = `抖音/收藏/夹/note [${id2}].md`;
      await vault.create(p2, ["---", "type: 视频", "transcript_status: failed", "transcript_provider: siliconflow_sensevoice", "---", "", "> [!warning]- 逐字稿", "> 转写未成功：旧错误", ""].join("\n"));
      const item2 = DouyinClient.normalize(rawVideo(id2), "collection");
      const ok2 = await engine.processItem(item2, "夹", blankSummary(), undefined);
      const content2 = vault.files.get(p2)?.data ?? "";
      t("对侧：failed 旧稿不被复用（重建后 transcript_status 不伪造 success）", ok2 === true && !/^transcript_status:\s*"?success"?/m.test(content2));
      t("对侧：failed 旧稿的正文内容不冒充逐字稿", !content2.includes("转写未成功：旧错误\n> 笔记里已有的") && !engine.state.processed[id2]?.asrStatus);

      // 对侧 2：配置了 ASR 的撞库条目（failed 旧稿）走真实转写路——预算耗尽 → 顺延 pendingAsr
      const id3 = "9110000000000003";
      const p3 = `抖音/收藏/夹/note [${id3}].md`;
      await vault.create(p3, ["---", "type: 视频", "transcript_status: failed", "transcript_provider: siliconflow_sensevoice", "---", "", "> [!warning]- 逐字稿", "> 转写未成功：旧错误", ""].join("\n"));
      const { engine: e3 } = makeEngine(m, vault, {
        asrProvider: "siliconflow_sensevoice",
        siliconflowKey: "k",
        videoSummaryEnabled: false,
      });
      // 预算置 0：transcribeVideo 走 defer 分支（不真调 ASR），断言 failed 撞库条目进入顺延队列
      e3.asrBudgetLeft = 0;
      const item3 = DouyinClient.normalize(rawVideo(id3), "collection");
      await e3.processItem(item3, "夹", blankSummary(), undefined);
      t("对侧 2：failed 逐字稿条目按转写路顺延（不入 dead、不伪造 success）", e3.state.pendingAsr.includes(id3) && !/^transcript_status:\s*"?success"?/m.test(vault.files.get(p3)?.data ?? ""));
    }

    // =====================================================================
    console.log("— 第十轮 F2：撞库 + 已有当前版本摘要 → 阶段 9 重出被跳过 —");
    {
      const vault = new MiniVault(TFile, TFolder);
      const { engine } = makeEngine(m, vault, {
        videoSummaryEnabled: true,
        videoSummaryBaseUrl: "https://f2.example/v1",
        videoSummaryApiKey: "k-f2",
        summaryMaxTokens: 500,
        keyframeIntervalSec: 10,
      });
      const id = "9120000000000001";
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
      t("F2：已有 v3 摘要的撞库条目零摘要请求（精修摘要不被批量覆盖）", ok === true && summaryCalls === 0);
      t("F2：精修摘要原样保留", vault.files.get(p)?.data.includes("精修摘要内容") === true);

      // 对侧：旧格式摘要（summary_v: 2）不被保护——仍按补跑口径升级重出
      const id2 = "9120000000000002";
      const p2 = `抖音/收藏/夹/note [${id2}].md`;
      await vault.create(p2, [
        "---", "type: 视频", "transcript_status: success", "transcript_provider: siliconflow_sensevoice",
        "frame_interval: 10", "summary_v: 2", "---", "",
        "> [!quote]- 逐字稿（siliconflow_sensevoice）", "> 转录内容", "",
        "> [!abstract]- 摘要", "> v2 旧格式摘要", "",
      ].join("\n"));
      setRequestUrlMock(async (req) => {
        if (!/\/chat\/completions$/.test(req.url)) throw new Error("意外请求 " + req.url);
        summaryCalls++;
        const payload = { choices: [{ message: { content: "主题:新摘要\n\n## AI 总结\n新版本。" }, finish_reason: "stop" }] };
        return { status: 200, text: JSON.stringify(payload), json: payload };
      });
      const item2 = DouyinClient.normalize(rawVideo(id2), "collection");
      await engine.processItem(item2, "夹", blankSummary(), undefined);
      noNet();
      t("对侧：summary_v=2 的撞库条目仍重出升级（摘要保护不锁死格式升级）", summaryCalls === 1);
      t("对侧：重出后摘要为 v3 新内容", vault.files.get(p2)?.data.includes("新版本。") === true);
    }
  };

  return { get pass() { return pass; }, get fail() { return fail; }, async: asyncChecks };
}
