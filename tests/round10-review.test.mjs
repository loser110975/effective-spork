// 第十轮复审批测试（2026-09-27，独立复核会话）：
// 覆盖复审批新增的加固项——
// 1) F7 供应商前缀补全：paraformer 通道成功结果 provider 是子模型名（paraformer-v2 / fun-asr-mtl），
//    缺前缀规则时 B3 暂存保护对该通道整体失效（暂存条目每次被 F7 删、下轮重新计费）；
// 2) F2 needFrames 抑制：撞库 + 既有 v3 摘要被保护跳过时，帧没有消费方——不抑制的话
//    无帧笔记会白跑一次全片下载 + ffmpeg（重置台账重同步 403 条的常态场景全是白付 IO）；
// 3) F2 复用源统一：B3 暂存命中 + 撞库到已有 v3 摘要的完整笔记同样跳过摘要重出
//    （原实现只保护「转录来自笔记旧稿」一条路）。
// 桥接 parked 恢复校验与 F4 备份原子化分别在 douyin-bridge.js / main.ts，不在测试 bundle 内。
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const nodeRequireReal = createRequire(import.meta.url);

// ---------- 引擎级测试替身（与 tests/round10-adversarial.test.mjs 同款 MiniVault） ----------

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

function makeEngine(m, vault, settingsOver = {}) {
  const settings = makeSettings(m.DEFAULT_SETTINGS, settingsOver);
  const calls = { pullAssets: [], saveImage: [] };
  const engine = new m.SyncEngine(
    { vault },
    settings,
    async () => {},
    () => {},
  );
  engine.media = {
    saveImage: async (url, rel) => {
      calls.saveImage.push(rel);
      return `抖音/Media/${rel}.jpg`;
    },
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
    cleanup: () => {},
  };
  return { engine, calls, settings };
}

export function runTests(m) {
  let pass = 0,
    fail = 0;
  const t = (name, ok) => {
    if (ok) {
      pass++;
      console.log("  ✓ " + name);
    } else {
      fail++;
      console.log("  ✗ " + name);
    }
  };
  const noNet = () =>
    m.setRequestUrlMock(async () => {
      throw new Error("requestUrl 不应在单测中被调用（需先 setRequestUrlMock 注入行为）");
    });

  const asyncChecks = async () => {
    // =====================================================================
    console.log("— F7 复审批：paraformer 通道子模型名前缀识别（B3 暂存保护不再被 F7 击穿）—");
    {
      const engine = makeEngine(m, null, { asrProvider: "dashscope_paraformer" }).engine;
      engine.state.transcriptCache = {
        p2: { transcript: "paraformer 主模型转录", provider: "paraformer-v2", at: "2026-09-27T01:00:00.000Z" },
        fa: { transcript: "fun-asr 兜底转录", provider: "fun-asr-mtl", at: "2026-09-27T01:00:00.000Z" },
        sf: { transcript: "跨通道脏数据", provider: "siliconflow_sensevoice", at: "2026-09-27T01:00:00.000Z" },
      };
      const hitMain = engine.peekStashedTranscript("p2");
      t("主模型子名 paraformer-v2 命中 dashscope_paraformer 暂存", hitMain?.transcript === "paraformer 主模型转录");
      const hitFallback = engine.peekStashedTranscript("fa");
      t("兜底链子名 fun-asr-mtl 命中 dashscope_paraformer 暂存", hitFallback?.transcript === "fun-asr 兜底转录");
      const miss = engine.peekStashedTranscript("sf");
      t("跨通道 provider（siliconflow）仍判不匹配并删除", miss === null && !engine.state.transcriptCache.sf);

      const engine2 = makeEngine(m, null, { asrProvider: "siliconflow_sensevoice" }).engine;
      engine2.state.transcriptCache = {
        pv: { transcript: "x", provider: "paraformer-v2", at: "2026-09-27T01:00:00.000Z" },
      };
      t("对侧：want=siliconflow 时 paraformer 子名不误命中", engine2.peekStashedTranscript("pv") === null);

      const engine3 = makeEngine(m, null, { asrProvider: "dashscope_qwen3" }).engine;
      engine3.state.transcriptCache = {
        q3: { transcript: "qwen3 转录", provider: "qwen3-asr-flash", at: "2026-09-27T01:00:00.000Z" },
      };
      t("原规则回归：qwen3 子名前缀仍命中 dashscope_qwen3", engine3.peekStashedTranscript("q3")?.transcript === "qwen3 转录");
    }

    // =====================================================================
    console.log("— F2 复审批：摘要被保护时 needFrames 同步抑制（无帧笔记不再白跑全片下载）—");
    {
      const vault = new MiniVault(m.TFile, m.TFolder);
      const { engine, calls } = makeEngine(m, vault, {
        videoSummaryEnabled: true,
        videoSummaryBaseUrl: "https://r10.example/v1",
        videoSummaryApiKey: "k",
        asrProvider: "siliconflow_sensevoice",
        siliconflowKey: "k",
      });
      const id = "9130000000000001";
      const p = `抖音/收藏/夹/note [${id}].md`;
      await vault.create(p, [
        "---", "type: 视频", "category: 投资理财",
        "transcript_status: success", "transcript_provider: siliconflow_sensevoice",
        "summary_v: 3", "---", "",
        "> [!quote]- 逐字稿（siliconflow_sensevoice）", "> 笔记里已有的付费转录内容", "",
        "> [!abstract]- 摘要", "> 精修摘要内容", "",
      ].join("\n"));
      setRequestUrlMockGuard();
      const item = m.DouyinClient.normalize(rawVideo(id), "collection");
      const ok = await engine.processItem(item, "夹", blankSummary(), undefined);
      noNet();
      t("撞库 + v3 摘要保护：pullAssets 未被调用（免全片下载与抽帧）", ok === true && calls.pullAssets.length === 0);
      t("笔记逐字稿仍原样保留", (vault.files.get(p)?.data ?? "").includes("笔记里已有的付费转录内容"));

      // 对侧：v2 旧格式摘要不保护 → 摘要要重出 → 帧有消费方 → pullAssets 必须照常拉
      const id2 = "9130000000000002";
      const p2 = `抖音/收藏/夹/note [${id2}].md`;
      await vault.create(p2, [
        "---", "type: 视频", "transcript_status: success", "transcript_provider: siliconflow_sensevoice",
        "summary_v: 2", "---", "",
        "> [!quote]- 逐字稿（siliconflow_sensevoice）", "> 转录内容", "",
        "> [!abstract]- 摘要", "> v2 旧格式摘要", "",
      ].join("\n"));
      m.setRequestUrlMock(async (req) => {
        if (!/\/chat\/completions$/.test(req.url)) throw new Error("意外请求 " + req.url);
        const payload = { choices: [{ message: { content: "主题:新摘要\n\n## AI 总结\n升级。" }, finish_reason: "stop" }] };
        return { status: 200, text: JSON.stringify(payload), json: payload };
      });
      const item2 = m.DouyinClient.normalize(rawVideo(id2), "collection");
      await engine.processItem(item2, "夹", blankSummary(), undefined);
      noNet();
      t("对侧：v2 摘要重出时帧路照常拉取（摘要升级不被抑制误伤）", calls.pullAssets.some((c) => c.id === id2));
    }

    // =====================================================================
    console.log("— F2 复审批：B3 暂存命中 + 撞库到 v3 摘要笔记 → 摘要同样不重出 —");
    {
      const vault = new MiniVault(m.TFile, m.TFolder);
      const { engine, calls } = makeEngine(m, vault, {
        videoSummaryEnabled: true,
        videoSummaryBaseUrl: "https://r10b.example/v1",
        videoSummaryApiKey: "k",
        asrProvider: "siliconflow_sensevoice",
        siliconflowKey: "k",
      });
      const id = "9140000000000001";
      const p = `抖音/收藏/夹/note [${id}].md`;
      await vault.create(p, [
        "---", "type: 视频", "category: 投资理财",
        "transcript_status: success", "transcript_provider: siliconflow_sensevoice",
        "summary_v: 3", "---", "",
        "> [!quote]- 逐字稿（siliconflow_sensevoice）", "> 笔记里已有的付费转录内容", "",
        "> [!abstract]- 摘要", "> 精修摘要内容", "",
      ].join("\n"));
      // 转写成功但写笔记失败留下的暂存（第九轮 B3）——转录内容与笔记一致
      engine.state.transcriptCache = {
        [id]: { transcript: "暂存的已付费转录", provider: "siliconflow_sensevoice", at: "2026-09-27T01:00:00.000Z" },
      };
      let summaryCalls = 0;
      m.setRequestUrlMock(async (req) => {
        if (/\/chat\/completions$/.test(req.url)) {
          summaryCalls++;
          throw new Error("暂存命中 + v3 摘要不应重出");
        }
        throw new Error("意外请求 " + req.url);
      });
      const item = m.DouyinClient.normalize(rawVideo(id), "collection");
      const ok = await engine.processItem(item, "夹", blankSummary(), undefined);
      noNet();
      t("暂存命中 + v3 摘要：零摘要请求、零帧路拉取", ok === true && summaryCalls === 0 && calls.pullAssets.length === 0);
      t("落账后暂存清除（finalizeProcessed 语义保持）", !engine.state.transcriptCache?.[id]);
      t("精修摘要原样保留", (vault.files.get(p)?.data ?? "").includes("精修摘要内容"));
    }
  };

  function setRequestUrlMockGuard() {
    m.setRequestUrlMock(async () => {
      throw new Error("v3 摘要保护路径不应有任何网络请求");
    });
  }

  return { get pass() { return pass; }, get fail() { return fail; }, async: asyncChecks };
}
