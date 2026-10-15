// 引擎级集成测试（2026-09-27 第四轮，补 09-14 明确延后的 syncAll/processItem 单测）：
// SyncEngine + MiniVault（内存 vault）+ 协作者注入（media/videoMedia 换替身、DouyinClient 打原型补丁），
// 全程不触网。重点保护：提前停止跨页累计（P0-5 回归）、确定性素材失败不入重试队列（P0-3）、
// 摘要失败不丢笔记、ASR 重试台账退避阶梯、落盘节流与失败重标脏。
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";

// ---------- 测试替身 ----------

/** 内存 Vault：实现 SyncEngine / MediaStore / videoSummaryService 用到的最小面。 */
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

function fakeMedia(calls, saveImageImpl) {
  return {
    saveImage:
      saveImageImpl ??
      (async (url, rel) => {
        calls.saveImage.push(rel);
        return `抖音/Media/${rel}.jpg`;
      }),
    dataUrlFromFile: async () => "",
    toDataUrl: async () => "",
  };
}

function fakeVideoMedia(calls, over = {}) {
  return {
    updateClient() {},
    checkFfmpeg: async () => null,
    pullAssets: async (item, opts) => {
      calls.pullAssets.push({ id: item.id, opts });
      return { assets: { audioPath: "", framePaths: [] }, error: "", errorKind: "none" };
    },
    cleanup: (id) => calls.cleanup.push(id),
    getAudio: async () => null,
    ...over,
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

async function makeEngine(m, settings, vault, calls) {
  const engine = new m.SyncEngine(
    { vault },
    settings,
    async () => {
      calls.onStateChange++;
    },
    () => {},
  );
  engine.media = fakeMedia(calls, settings.__saveImageImpl);
  engine.videoMedia = fakeVideoMedia(calls, settings.__videoMediaOver);
  return engine;
}

// ---------- 用例 ----------

export function runTests(m) {
  const { DEFAULT_SETTINGS, DouyinClient, planNotePath } = m;
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

  const asyncChecks = async () => {
    console.log("— 落盘节流（flushState / markStateDirty / flushNow）—");
    {
      const calls = { onStateChange: 0 };
      const vault = new MiniVault(m.TFile, m.TFolder);
      const engine = await makeEngine(m, makeSettings(DEFAULT_SETTINGS), vault, calls);
      for (let i = 0; i < 9; i++) engine.markStateDirty();
      await new Promise((r) => setTimeout(r, 5));
      t("9 次标脏不触发落盘（低于条数/时间阈值）", calls.onStateChange === 0);
      engine.markStateDirty(); // 第 10 次
      await new Promise((r) => setTimeout(r, 5));
      t("第 10 次标脏触发落盘", calls.onStateChange === 1);
      t("落盘后 dirty 复位", engine.dirty === false);
      await engine.flushNow();
      t("干净状态下 flushNow 强制落盘一次", calls.onStateChange === 2 && engine.dirty === false);

      // 落盘失败 → 重新标脏，下次补写
      let boom = true;
      engine.onStateChange = async () => {
        if (boom) throw new Error("磁盘满");
        calls.onStateChange++;
      };
      engine.markStateDirty();
      await engine.flushNow(); // 内部 catch 吞掉失败并重标脏
      t("落盘失败被吞掉且重新标脏", engine.dirty === true && calls.onStateChange === 2);
      boom = false;
      await engine.flushNow();
      t("恢复后下一次落盘成功补写", calls.onStateChange === 3 && engine.dirty === false);
    }

    console.log("— saveImage（真实 MediaStore + 内存 vault）—");
    {
      let netCalls = 0;
      m.setRequestUrlMock(async () => {
        netCalls++;
        return { status: 200, arrayBuffer: new Uint8Array(16).buffer, text: "" };
      });
      const vault = new MiniVault(m.TFile, m.TFolder);
      const store = new m.MediaStore(vault, "抖音/Media");
      const p1 = await store.saveImage("https://cdn.example/a.jpg", "cover/x1");
      t("下载成功返回 vault 路径并入库", p1 === "抖音/Media/cover/x1.jpg" && vault.files.has(p1) && netCalls === 1);
      const p2 = await store.saveImage("https://cdn.example/a.jpg", "cover/x1");
      t("幂等：命中已入库文件不再发请求", p2 === p1 && netCalls === 1);

      vault.files.set("抖音/Media/cover/x2.jpg", { data: "", size: 0, mtime: 0 });
      const p3 = await store.saveImage("https://cdn.example/b.jpg", "cover/x2");
      t("0 字节残档视为不存在并重新下载", p3 === "抖音/Media/cover/x2.jpg" && netCalls === 2);

      m.setRequestUrlMock(async () => {
        throw new Error("网络断开");
      });
      const p4 = await store.saveImage("https://cdn.example/c.jpg", "cover/x3");
      t("下载失败返回空串且不抛出", p4 === "");
      const p5 = await store.saveImage("https://cdn.example/a.jpg", "cover/x1");
      t("已有有效文件时断网也直接命中本地", p5 === "抖音/Media/cover/x1.jpg");
      m.setRequestUrlMock(async () => {
        throw new Error("requestUrl 不应在单测中被调用（需先 setRequestUrlMock 注入行为）");
      });
    }

    console.log("— processItem：图文全链路（无网络）—");
    {
      const calls = { onStateChange: 0, saveImage: [], pullAssets: [], cleanup: [] };
      const vault = new MiniVault(m.TFile, m.TFolder);
      const engine = await makeEngine(
        m,
        makeSettings(DEFAULT_SETTINGS, { downloadCover: true, downloadImages: true }),
        vault,
        calls,
      );
      const raw = rawNote("730001");
      const item = DouyinClient.normalize(raw, "collection");
      const summary = { visionOk: 0, errors: [], notices: [], created: 0, skipped: 0, asrFailed: 0, asrSkipped: 0, transcribed: 0, videoSummaries: 0 };
      const ok = await engine.processItem(item, "测试夹", summary, undefined);
      t("processItem 返回成功", ok === true);
      const expectedPath = planNotePath("抖音", item, "测试夹", item.title);
      t("笔记按 planNotePath 落盘", vault.files.has(expectedPath));
      t("台账登记 path/folder", engine.state.processed["730001"]?.path === expectedPath && engine.state.processed["730001"]?.folder === "测试夹");
      t("封面+两张图共 3 次 saveImage", calls.saveImage.length === 3);
      t("图文不走 pullAssets；cleanup 幂等无条件执行", calls.pullAssets.length === 0 && calls.cleanup.includes("730001"));
      t("埋点记录一条且 totalMs > 0", engine.state.metrics.length === 1 && engine.state.metrics[0].totalMs > 0 && engine.state.metrics[0].type === "note");
      t("节流窗口内未落盘", calls.onStateChange === 0);
      await engine.flushNow();
      t("flushNow 后落盘", calls.onStateChange === 1);
      const content = await vault.read(vault.getAbstractFileByPath(expectedPath));
      t("笔记含 frontmatter type 图文", /^type:\s*"?(图文)"?\s*$/m.test(content));
      t("笔记含收藏夹与图片块", content.includes("测试夹") && (content.includes("images/") || content.includes("图 1") || content.includes("Media")));
    }

    console.log("— processItem：确定性素材失败不入重试队列 —");
    {
      // 素材侧确定性失败（no_video_track）+ ASR 报「无法取得音频文件」→ 不入重试队列
      const calls = { onStateChange: 0, saveImage: [], pullAssets: [], cleanup: [] };
      const vault = new MiniVault(m.TFile, m.TFolder);
      const engine = await makeEngine(
        m,
        makeSettings(DEFAULT_SETTINGS, {
          asrProvider: "siliconflow_sensevoice",
          siliconflowKey: "k",
          siliconflowBaseUrl: "https://api.siliconflow.cn/v1",
        }),
        vault,
        calls,
      );
      engine.videoMedia = fakeVideoMedia(calls, {
        pullAssets: async () => ({ assets: null, error: "ffmpeg: Stream map '0:v:0' matches no streams", errorKind: "no_video_track" }),
        getAudio: async () => null,
      });
      const item = DouyinClient.normalize(rawVideo("730101"), "collection");
      const summary = { visionOk: 0, errors: [], notices: [], created: 0, skipped: 0, asrFailed: 0, asrSkipped: 0, transcribed: 0, videoSummaries: 0 };
      await engine.processItem(item, "夹", summary, undefined);
      t("确定性素材失败：重试队列为空", engine.state.pendingAsr.length === 0);
      t("确定性素材失败：错误含「素材侧，不重试」", summary.errors.some((e) => e.includes("素材侧，不重试")));
      t("失败路径也执行 cleanup（临时目录不泄漏）", calls.cleanup.includes("730101"));
      t("条目仍处理完成（带错误笔记）但重试队列为空", !!engine.state.processed["730101"] && engine.state.pendingAsr.length === 0);

      // 可重试失败（模拟 502）：入队，attempts=0
      engine.videoMedia = fakeVideoMedia(calls, {
        pullAssets: async () => ({ assets: { audioPath: "/tmp/fake.mp3", framePaths: [] }, error: "", errorKind: "none" }),
        getAudio: async () => realAudioPath,
      });
      const realAudioPath = join(tmpdir(), `ds-test-audio-${Date.now()}.mp3`);
      await writeFile(realAudioPath, Buffer.alloc(2048, 7)); // > MIN_AUDIO_BYTES，通过空壳短路
      m.setRequestUrlMock(async () => ({ status: 502, arrayBuffer: undefined, text: "Bad Gateway", json: null }));
      const item2 = DouyinClient.normalize(rawVideo("730102"), "collection");
      await engine.processItem(item2, "夹", summary, undefined);
      t("非确定性失败进入重试队列", engine.state.pendingAsr.includes("730102"));
      t("台账 attempts 从 0 起步", engine.state.asrRetry["730102"]?.attempts === 0);
      t("含 502 的错误不匹配确定性特征", !/不含视频轨|无法取得音频文件|未接入音频解析通道|音频抽取异常|无播放地址|空壳|未产出有效音轨|缺少 SiliconFlow API Key/.test(engine.state.asrRetry["730102"]?.lastError ?? ""));
      m.setRequestUrlMock(async () => {
        throw new Error("requestUrl 不应在单测中被调用（需先 setRequestUrlMock 注入行为）");
      });
    }

    console.log("— processItem：视频摘要失败不丢笔记 —");
    {
      const calls = { onStateChange: 0, saveImage: [], pullAssets: [], cleanup: [] };
      const vault = new MiniVault(m.TFile, m.TFolder);
      const engine = await makeEngine(
        m,
        makeSettings(DEFAULT_SETTINGS, {
          videoSummaryEnabled: true,
          aiKey: "k",
          aiBaseUrl: "https://ai.example/v1",
          aiModel: "test-model",
          summaryMaxTokens: 500,
          // 2026-10-15 通道独立化：多模态通道不再回退 aiKey，必须显式配置才可用
          videoSummaryBaseUrl: "https://ai.example/v1",
          videoSummaryApiKey: "k-vs",
        }),
        vault,
        calls,
      );
      engine.videoMedia = fakeVideoMedia(calls, {
        pullAssets: async () => ({
          assets: { audioPath: "", framePaths: ["抖音/Media/frames/730201/01.jpg"] },
          error: "",
          errorKind: "none",
        }),
      });
      // AI 端点直接失败（非超时 → 无重试退避，快速失败）
      m.setRequestUrlMock(async () => {
        throw new Error("模拟网络失败");
      });
      vault.adapter.readBinary = async () => Buffer.from("fakejpeg");
      const item = DouyinClient.normalize(rawVideo("730201"), "collection");
      const summary = { visionOk: 0, errors: [], notices: [], created: 0, skipped: 0, asrFailed: 0, asrSkipped: 0, transcribed: 0, videoSummaries: 0 };
      const ok = await engine.processItem(item, "夹", summary, undefined);
      m.setRequestUrlMock(async () => {
        throw new Error("requestUrl 不应在单测中被调用（需先 setRequestUrlMock 注入行为）");
      });
      const expectedPath = planNotePath("抖音", item, "夹", item.title);
      t("摘要失败但笔记仍落盘", ok === true && vault.files.has(expectedPath));
      t("台账仍登记（不因摘要失败丢进度）", !!engine.state.processed["730201"]);
      t("错误信息含「视频摘要」", summary.errors.some((e) => e.includes("视频摘要")));
      t("失败记录进摘要台账", (engine.state.summary ?? []).some((r) => r.notePath === expectedPath && r.status === "failed"));
    }

    console.log("— processItem：无视频轨音频类条目（aweme_type=163）—");
    {
      const calls = { onStateChange: 0, saveImage: [], pullAssets: [], cleanup: [] };
      const vault = new MiniVault(m.TFile, m.TFolder);
      const engine = await makeEngine(
        m,
        makeSettings(DEFAULT_SETTINGS, { asrProvider: "siliconflow_sensevoice", siliconflowKey: "k" }),
        vault,
        calls,
      );
      const item = DouyinClient.normalize(rawVideo("730301", { aweme_type: 163, media_type: 43 }), "collection");
      const summary = { visionOk: 0, errors: [], notices: [], created: 0, skipped: 0, asrFailed: 0, asrSkipped: 0, transcribed: 0, videoSummaries: 0 };
      await engine.processItem(item, "夹", summary, undefined);
      t("音频类条目记 unavailable 并计数 asrSkipped", summary.asrSkipped === 1);
      t("台账 asrStatus = unavailable", engine.state.processed["730301"]?.asrStatus === "unavailable");
      t("不进重试队列", engine.state.pendingAsr.length === 0);
      const path = engine.state.processed["730301"]?.path;
      const content = path ? await vault.read(vault.getAbstractFileByPath(path)) : "";
      t("笔记注明无视频轨原因", content.includes("无视频轨"));
    }

    console.log("— ASR 重试台账（退避阶梯 / dead-letter / 结清）—");
    {
      const calls = { onStateChange: 0, saveImage: [], pullAssets: [], cleanup: [] };
      const vault = new MiniVault(m.TFile, m.TFolder);
      const engine = await makeEngine(m, makeSettings(DEFAULT_SETTINGS), vault, calls);
      engine.enqueueAsrRetry("a", "第一次失败");
      t("入队：pending + attempts=0 + 立即可试", engine.state.pendingAsr.includes("a") && engine.state.asrRetry["a"].attempts === 0 && engine.asrRetryReady("a") === true);
      engine.bumpAsrRetry("a", "第二次失败");
      const e1 = engine.state.asrRetry["a"];
      t("第一次重试失败后进入 5 分钟退避", e1.attempts === 1 && Date.parse(e1.nextRetryAt) - Date.now() > 4 * 60_000 && engine.asrRetryReady("a") === false);
      for (let i = 0; i < 4; i++) engine.bumpAsrRetry("a", "持续失败");
      t("达到上限转 dead-letter", engine.state.asrRetry["a"].dead === true && engine.asrRetryReady("a") === false);
      engine.clearAsrRetry("a");
      t("结清：队列与台账同时移除", !engine.state.pendingAsr.includes("a") && !engine.state.asrRetry["a"]);

      t("retryQueueSummary 空队列文案", engine.retryQueueSummary().includes("共 0 条"));
      engine.state.pendingAsr = ["d1", "d2", "r1"];
      engine.state.asrRetry = {
        d1: { attempts: 5, lastError: "boom", nextRetryAt: new Date().toISOString(), dead: true },
        d2: { attempts: 1, lastError: "w", nextRetryAt: new Date(Date.now() + 3600_000).toISOString() },
        r1: { attempts: 0, lastError: "w", nextRetryAt: new Date(Date.now() - 1000).toISOString() },
      };
      const s = engine.retryQueueSummary();
      t("混合队列计数正确", s.includes("共 3 条") && s.includes("可立即试 1") && s.includes("退避中 1") && s.includes("已放弃(dead) 1"));
      t("dead 条目展示错误摘录", s.includes("d1"));
    }

    console.log("— retryPendingAsr（台账簿记，详情接口打桩）—");
    {
      // asrProvider 不能是 none：retryPendingAsr 对 none 提前返回（这正是要绕过的前置）
      const calls = { onStateChange: 0, saveImage: [], pullAssets: [], cleanup: [], detail: [] };
      const vault = new MiniVault(m.TFile, m.TFolder);
      const engine = await makeEngine(
        m,
        makeSettings(DEFAULT_SETTINGS, { asrProvider: "siliconflow_sensevoice", siliconflowKey: "k" }),
        vault,
        calls,
      );
      const summary = { visionOk: 0, errors: [], notices: [], created: 0, skipped: 0, asrFailed: 0, asrSkipped: 0, transcribed: 0, videoSummaries: 0 };
      const notice = new m.Notice("x", 0);

      // ① 无台账条目 → 结清，不发详情请求
      engine.state.pendingAsr = ["gone"];
      let budget = await engine.retryPendingAsr(5, summary, notice);
      t("无笔记路径的条目被结清", !engine.state.pendingAsr.includes("gone") && calls.detail.length === 0 && budget === 5);

      // ② dead 条目：跳过并提示（第九轮 A6：台账路径指向的笔记必须真实存在才进重试，先补建文件）
      await vault.create("抖音/收藏/x/笔记 [dead1].md", '---\ndouyin_id: "dead1"\n---\n正文');
      engine.state.processed["dead1"] = { path: "抖音/收藏/x/笔记 [dead1].md", syncedAt: "", folder: "x" };
      engine.state.pendingAsr = ["dead1"];
      engine.state.asrRetry = { dead1: { attempts: 5, lastError: "e", nextRetryAt: new Date().toISOString(), dead: true } };
      await engine.retryPendingAsr(5, summary, notice);
      t("dead 条目跳过且提示放弃", summary.errors.some((e) => e.includes("放弃自动重试")) && calls.detail.length === 0);

      // ③ 未到退避时间：不请求
      engine.state.asrRetry.dead1 = { attempts: 1, lastError: "e", nextRetryAt: new Date(Date.now() + 3600_000).toISOString() };
      const before = summary.notices.length;
      await engine.retryPendingAsr(5, summary, notice);
      t("退避未到的条目跳过并提示", summary.notices.length > before && calls.detail.length === 0);

      // ④ 详情接口失败 → bump（attempts+1）
      engine.state.asrRetry.dead1 = { attempts: 0, lastError: "e", nextRetryAt: new Date(Date.now() - 1000).toISOString() };
      DouyinClient.prototype.getAwemeDetail = async (id) => {
        calls.detail.push(id);
        return null;
      };
      await engine.retryPendingAsr(5, summary, notice);
      t("详情获取失败记一次退避（attempts 0→1）", engine.state.asrRetry["dead1"]?.attempts === 1 && calls.detail.length === 1);
      t("失败原因写进摘要 errors", summary.errors.some((e) => e.includes("无法获取详情")));

      // ⑤ 作品不可解析 → 结清（④ 的 bump 把条目推进了 5 分钟退避，先拨回可试）
      engine.state.asrRetry["dead1"].nextRetryAt = new Date(Date.now() - 1000).toISOString();
      DouyinClient.prototype.getAwemeDetail = async () => ({ aweme_id: "bad-id" });
      await engine.retryPendingAsr(5, summary, notice);
      t("不可解析的作品被结清", !engine.state.pendingAsr.includes("dead1"));

      // ⑥ 类型已非视频 → 结清（第九轮 A6：同样需真实笔记文件才进重试）
      await vault.create("抖音/收藏/x/笔记 [940003].md", '---\ndouyin_id: "940003"\n---\n正文');
      engine.state.processed["940003"] = { path: "抖音/收藏/x/笔记 [940003].md", syncedAt: "", folder: "x" };
      engine.state.pendingAsr = ["940003"];
      engine.state.asrRetry = { "940003": { attempts: 0, lastError: "e", nextRetryAt: new Date(Date.now() - 1000).toISOString() } };
      DouyinClient.prototype.getAwemeDetail = async () => rawNote("940003");
      await engine.retryPendingAsr(5, summary, notice);
      t("非视频类型条目被结清", !engine.state.pendingAsr.includes("940003"));

      // ⑦ 预算钳制：budget=1 只处理一条
      await vault.create("抖音/收藏/x/笔记 [p1].md", '---\ndouyin_id: "p1"\n---\n正文');
      await vault.create("抖音/收藏/x/笔记 [p2].md", '---\ndouyin_id: "p2"\n---\n正文');
      engine.state.processed["p1"] = { path: "抖音/收藏/x/笔记 [p1].md", syncedAt: "", folder: "x" };
      engine.state.processed["p2"] = { path: "抖音/收藏/x/笔记 [p2].md", syncedAt: "", folder: "x" };
      engine.state.pendingAsr = ["p1", "p2"];
      engine.state.asrRetry = {
        p1: { attempts: 0, lastError: "e", nextRetryAt: new Date(Date.now() - 1000).toISOString() },
        p2: { attempts: 0, lastError: "e", nextRetryAt: new Date(Date.now() - 1000).toISOString() },
      };
      calls.detail.length = 0;
      DouyinClient.prototype.getAwemeDetail = async (id) => {
        calls.detail.push(id);
        return null;
      };
      const b2 = await engine.retryPendingAsr(1, summary, notice);
      t("预算 1 只发一次详情请求", calls.detail.length === 1 && b2 === 1); // 「无法获取详情」分支 continue 不扣预算
      delete DouyinClient.prototype.getAwemeDetail; // 还原（后续用例不触网兜底）
    }

    console.log("— findNotePath（索引失效回退扫描 / 多副本偏好）—");
    {
      const calls = { onStateChange: 0, saveImage: [], pullAssets: [], cleanup: [] };
      const vault = new MiniVault(m.TFile, m.TFolder);
      const engine = await makeEngine(m, makeSettings(DEFAULT_SETTINGS), vault, calls);
      await vault.create("抖音/收藏/未分类/标题A [730401].md", "---\ntype: 视频\n---\n正文");
      await vault.create("抖音/收藏/好夹/标题A [730401].md", "---\ntype: 视频\n---\n正文");
      engine.state.processed["730401"] = { path: "抖音/收藏/旧位置/标题A [730401].md", syncedAt: "", folder: "旧位置" };
      const found = engine.findNotePath("730401");
      t("台账路径失效后按 ID 扫描找回", found === "抖音/收藏/好夹/标题A [730401].md");
      t("多副本优先非「未分类」目录", found !== "抖音/收藏/未分类/标题A [730401].md");
      t("扫描结果回填索引", engine.noteIndexGet().get("730401") === found);
      t("找不到时返回 null", engine.findNotePath("999999") === null);
    }

    console.log("— writeAsrErrorNote（只动 warning 块）—");
    {
      const calls = { onStateChange: 0, saveImage: [], pullAssets: [], cleanup: [] };
      const vault = new MiniVault(m.TFile, m.TFolder);
      const engine = await makeEngine(m, makeSettings(DEFAULT_SETTINGS), vault, calls);
      const notePath = "抖音/收藏/夹/笔记 [730501].md";
      await vault.create(notePath, ["---", "type: 视频", "---", "", "> [!warning]- 逐字稿", "> 转写未成功：旧错误", "> 可用命令「重试失败转写」重试。", "", "## 正文", "保留我"].join("\n"));
      await engine.writeAsrErrorNote(notePath, "新错误信息");
      const content = await vault.read(vault.getAbstractFileByPath(notePath));
      t("错误文本被替换", content.includes("新错误信息") && !content.includes("旧错误"));
      t("其余内容逐字保留", content.includes("## 正文") && content.includes("保留我"));
      await engine.writeAsrErrorNote(notePath, "带 > 前缀的错误");
      const content2 = await vault.read(vault.getAbstractFileByPath(notePath));
      t("错误文本剥离引用前缀后写入", content2.includes("带 ＞ 前缀的错误") || content2.includes("带 > 前缀的错误"));
    }

    console.log("— loadState / resetState —");
    {
      const calls = { onStateChange: 0, saveImage: [], pullAssets: [], cleanup: [] };
      const vault = new MiniVault(m.TFile, m.TFolder);
      const engine = await makeEngine(m, makeSettings(DEFAULT_SETTINGS), vault, calls);
      await engine.loadState({
        processed: { a: { path: "x.md", syncedAt: "t", folder: "f" } },
        pendingAsr: ["a"],
        metrics: [{ id: "a", type: "note", totalMs: 1, recordedAt: "t" }],
        processManager: { bridgePid: 123, panelPid: -1, treePids: [123], lastStartAt: null, lastStopAt: null, lastCommandKey: null, lastErrorCode: null, updatedAt: null },
      });
      t("loadState 补全省略字段", engine.state.asrRetry != null && engine.state.vision != null && engine.state.summary != null);
      t("loadState 后反向索引待重建", engine.noteIndexGet().get("a") === "x.md");
      engine.state.summary = [{ notePath: "x.md", sourceChars: 1, model: "m", status: "success", generatedAt: "t" }];
      engine.resetState();
      t("resetState 清空 processed/pendingAsr/asrRetry", Object.keys(engine.state.processed).length === 0 && engine.state.pendingAsr.length === 0);
      t("resetState 保留 metrics/summary/processManager", engine.state.metrics.length === 1 && engine.state.summary.length === 1 && engine.state.processManager.bridgePid === 123);
    }

    console.log("— 埋点环形上限 —");
    {
      const calls = { onStateChange: 0, saveImage: [], pullAssets: [], cleanup: [] };
      const vault = new MiniVault(m.TFile, m.TFolder);
      const engine = await makeEngine(m, makeSettings(DEFAULT_SETTINGS), vault, calls);
      for (let i = 0; i < 105; i++) engine.recordStageTimings({ id: `id${i}`, type: "note" }, { imagesMs: 1 }, 100 + i);
      t("保留最近 100 条", engine.state.metrics.length === 100);
      t("最新样本在尾部", engine.state.metrics[99].id === "id104");
    }

    console.log("— consumePage / syncAll：提前停止（P0-5 回归保护）—");
    {
      // 场景 1：全页已处理 → 跨页累计到阈值即停，不再翻后面 197 页
      const calls = { onStateChange: 0, saveImage: [], pullAssets: [], cleanup: [], listCollection: 0 };
      const vault = new MiniVault(m.TFile, m.TFolder);
      const engine = await makeEngine(m, makeSettings(DEFAULT_SETTINGS, { scanStopAfterProcessed: 50 }), vault, calls);
      const processedIds = [];
      for (let i = 0; i < 200; i++) {
        const id = String(900000 + i);
        processedIds.push(id);
        engine.state.processed[id] = { path: `抖音/收藏/夹/标题 [${id}].md`, syncedAt: "t", folder: "夹" };
      }
      let cursorSeq = 0;
      DouyinClient.prototype.listCollection = async () => {
        cursorSeq++;
        calls.listCollection = cursorSeq;
        return { ok: true, hasMore: true, cursor: cursorSeq * 20, items: processedIds.slice((cursorSeq - 1) * 20, cursorSeq * 20).map((id) => rawVideo(id)) };
      };
      const summary = await engine.syncAll();
      delete DouyinClient.prototype.listCollection;
      t("连续已处理达阈值后提前停止（3 页而非 10 页）", calls.listCollection === 3);
      t("提前停止时无新增", summary.created === 0 && summary.errors.length === 0);

      // 场景 2：页尾出现新条目 → streak 清零重算
      const calls2 = { onStateChange: 0, saveImage: [], pullAssets: [], cleanup: [], listCollection: 0 };
      const vault2 = new MiniVault(m.TFile, m.TFolder);
      const engine2 = await makeEngine(m, makeSettings(DEFAULT_SETTINGS, { scanStopAfterProcessed: 40 }), vault2, calls2);
      for (let i = 0; i < 100; i++) {
        const id = String(910000 + i);
        engine2.state.processed[id] = { path: `抖音/收藏/夹/标题 [${id}].md`, syncedAt: "t", folder: "夹" };
      }
      let page = 0;
      const pages = [
        [...Array.from({ length: 19 }, (_, i) => rawVideo(String(910000 + i))), rawVideo("920000")], // 页尾新条目
        Array.from({ length: 20 }, (_, i) => rawVideo(String(910020 + i))),
        Array.from({ length: 20 }, (_, i) => rawVideo(String(910040 + i))),
      ];
      DouyinClient.prototype.listCollection = async () => {
        page++;
        calls2.listCollection = page;
        return { ok: true, hasMore: true, cursor: page * 20, items: pages[page - 1] ?? [] };
      };
      const summary2 = await engine2.syncAll();
      delete DouyinClient.prototype.listCollection;
      t("页尾新条目清零 streak：第 3 页才停（共 60 条累计）", calls2.listCollection === 3);
      t("新条目被创建 1 条", summary2.created === 1 && !!engine2.state.processed["920000"]);
    }

    console.log("— syncAll 完整冒烟（无网络）—");
    {
      const calls = { onStateChange: 0, saveImage: [], pullAssets: [], cleanup: [], listCollection: 0 };
      const vault = new MiniVault(m.TFile, m.TFolder);
      const engine = await makeEngine(m, makeSettings(DEFAULT_SETTINGS), vault, calls);
      engine.state.processed["930000"] = { path: "抖音/收藏/未分类/标题 [930000].md", syncedAt: "t", folder: "未分类" };
      let page = 0;
      DouyinClient.prototype.listCollection = async () => {
        page++;
        calls.listCollection = page;
        return page === 1
          ? { ok: true, hasMore: false, cursor: 20, items: [rawNote("930001"), rawVideo("930002"), rawVideo("930000")] }
          : { ok: true, hasMore: false, cursor: 40, items: [] };
      };
      const summary = await engine.syncAll();
      delete DouyinClient.prototype.listCollection;
      t("新增 2 / 跳过 1", summary.created === 2 && summary.skipped === 1);
      t("无错误", summary.errors.length === 0);
      t("lastSyncAt / lastSyncSummary 更新", !!engine.state.lastSyncAt && (engine.state.lastSyncSummary ?? "").includes("新增 2"));
      t("onStatus 被调用（状态栏反馈）", engine.state.lastPerfSummary !== undefined);
      t("完成后强制落盘", calls.onStateChange >= 1);
    }

    console.log("— backfillVideos：候选筛选与复用（无网络）—");    {
      const calls = { onStateChange: 0, saveImage: [], pullAssets: [], cleanup: [], detail: [] };
      const vault = new MiniVault(m.TFile, m.TFolder);
      const engine = await makeEngine(m, makeSettings(DEFAULT_SETTINGS), vault, calls);
      // 待跳过：终态 + 有摘要 + 帧达标 + v3
      await vault.create("抖音/收藏/夹/完成 [940001].md", ["---", "type: 视频", "transcript_status: success", "transcript_provider: test", "frame_interval: 10", "summary_v: 3", "---", "", "> [!abstract]- 摘要", "> 完成摘要", "", "> [!quote]- 逐字稿", "> 转录内容"].join("\n"));
      // 待补跑：summary_v = 2
      await vault.create("抖音/收藏/夹/旧版 [940002].md", ["---", "type: 视频", "transcript_status: success", "transcript_provider: test", "frame_interval: 10", "summary_v: 2", "---", "", "> [!abstract]- 摘要", "> 旧摘要", "", "> [!quote]- 逐字稿", "> 转录内容"].join("\n"));
      engine.state.processed["940001"] = { path: "抖音/收藏/夹/完成 [940001].md", syncedAt: "t", folder: "夹" };
      engine.state.processed["940002"] = { path: "抖音/收藏/夹/旧版 [940002].md", syncedAt: "t", folder: "夹" };
      DouyinClient.prototype.getAwemeDetail = async (id) => {
        calls.detail.push(id);
        return rawVideo(id);
      };
      const report = await engine.backfillVideos();
      delete DouyinClient.prototype.getAwemeDetail;
      t("补跑完成：处理 1，跳过 1，失败 0", report.includes("处理 1") && report.includes("跳过 1") && report.includes("失败 0"));
      t("v3 完成笔记不再重写", vault.files.get("抖音/收藏/夹/完成 [940001].md").data.includes("完成摘要"));
      // 重跑摘要失败时既有摘要要被回填保留（含版本号 2 → 下轮补跑仍会命中，直到真正重出成功）
      t("旧版摘要回填保留（含 summary_v: 2）", vault.files.get("抖音/收藏/夹/旧版 [940002].md").data.includes("summary_v: 2") && vault.files.get("抖音/收藏/夹/旧版 [940002].md").data.includes("旧摘要"));
      t("补跑只对候选调详情接口", calls.detail.length === 1 && calls.detail[0] === "940002");
    }

    console.log("— keyframeIntervalSec 不追溯：间隔不一致不再自动重抽（2026-10 行为变更）—");    {
      const calls = { onStateChange: 0, saveImage: [], pullAssets: [], cleanup: [], detail: [] };
      const vault = new MiniVault(m.TFile, m.TFolder);
      const engine = await makeEngine(m, makeSettings(DEFAULT_SETTINGS, { keyframeIntervalSec: 10 }), vault, calls);
      // 已完成的视频笔记：存的 frame_interval=30 与当前设置 10 不一致 → 新语义下视为完成（不重抽）
      await vault.create("抖音/收藏/夹/旧间隔 [980002].md", ["---", "type: 视频", "transcript_status: success", "transcript_provider: test", "frame_interval: 30", "summary_v: 3", "---", "", "> [!abstract]- 摘要", "> 完成摘要", "", "> [!quote]- 逐字稿", "> 转录内容"].join("\n"));
      engine.state.processed["980002"] = { path: "抖音/收藏/夹/旧间隔 [980002].md", syncedAt: "t", folder: "夹" };
      DouyinClient.prototype.getAwemeDetail = async (id) => { calls.detail.push(id); return rawVideo(id); };
      const report = await engine.backfillVideos();
      delete DouyinClient.prototype.getAwemeDetail;
      t("间隔不一致（存 30 / 设 10）不再触发补抽：跳过 1、不调详情", report.includes("跳过 1") && calls.detail.length === 0);
      t("不报强制重抽条数（非强制轮）", !report.includes("强制重抽"));
      t("笔记内容未被重写（复用既有帧）", vault.files.get("抖音/收藏/夹/旧间隔 [980002].md").data.includes("完成摘要"));
    }

    console.log("— forceFrameResync：强制重抽一次性标志（置位→强制重抽→自动清除→报数）—");    {
      const calls = { onStateChange: 0, saveImage: [], pullAssets: [], cleanup: [], detail: [] };
      const vault = new MiniVault(m.TFile, m.TFolder);
      const engine = await makeEngine(m, makeSettings(DEFAULT_SETTINGS), vault, calls);
      // framesOk 达标 + 终态转录 + v3 摘要的「已完成」笔记：正常语义下必然跳过
      await vault.create("抖音/收藏/夹/完成 [980001].md", ["---", "type: 视频", "transcript_status: success", "transcript_provider: test", "frame_interval: 10", "summary_v: 3", "---", "", "> [!abstract]- 摘要", "> 完成摘要", "", "> [!quote]- 逐字稿", "> 转录内容"].join("\n"));
      engine.state.processed["980001"] = { path: "抖音/收藏/夹/完成 [980001].md", syncedAt: "t", folder: "夹" };
      engine.state.forceFrameResync = true;
      const captured = [];
      engine.processItem = async (...args) => { captured.push(args); return true; };
      DouyinClient.prototype.getAwemeDetail = async (id) => { calls.detail.push(id); return rawVideo(id); };
      const report = await engine.backfillVideos();
      delete DouyinClient.prototype.getAwemeDetail;
      t("置位后 framesOk 达标的笔记也进候选集", captured.length === 1 && captured[0][0].id === "980001");
      t("强制重抽意图：reextract=true（第 8 参）", captured[0][7] === true);
      t("强制重抽不传 frameHint（禁复用既有帧）", captured[0][6] === undefined);
      t("本轮完成后标志自动清除", engine.state.forceFrameResync === false);
      t("报告含强制重抽条数", report.includes("强制重抽 1 条"));
      // 标志清除后：恢复新语义，达标笔记回到跳过
      DouyinClient.prototype.getAwemeDetail = async (id) => { calls.detail.push(id); return rawVideo(id); };
      const report2 = await engine.backfillVideos();
      delete DouyinClient.prototype.getAwemeDetail;
      t("标志清除后恢复新语义：达标笔记回到跳过（不重复强制）", calls.detail.length === 1 && report2.includes("跳过 1") && !report2.includes("强制重抽"));
    }

    console.log("— pullAssets 缓存按需维度（复审 P1 回归保护）—");
    {
      const vault = new MiniVault(m.TFile, m.TFolder);
      const store = new m.VideoMediaStore(vault, "抖音/Media", makeSettings(DEFAULT_SETTINGS), null);
      const innerCalls = [];
      store.pullAssetsInner = async (item, opts) => {
        innerCalls.push({ id: item.id, opts });
        if (item.id === "vfail") return { assets: null, errorKind: "network", error: "网络失败" };
        if (item.id === "vdet") return { assets: null, errorKind: "no_video_track", error: "条目不含视频轨" };
        // 音频路成功、帧路空的「仅音频」结果（getAudio 的实际形态）
        return { assets: { audioPath: "/tmp/a.mp3", framePaths: [] }, errorKind: "none", error: "" };
      };
      await store.pullAssets({ id: "v1", playUrl: "u" }, { wantAudio: true, wantFrames: false });
      await store.pullAssets({ id: "v1", playUrl: "u" }, { wantAudio: true, wantFrames: false });
      t("相同需求的第二次调用命中缓存", innerCalls.length === 1);
      await store.pullAssets({ id: "v1", playUrl: "u" }, { wantAudio: false, wantFrames: true });
      t("缓存里没有调用方要的帧 → 视为未命中重拉（重试成功路径不再永久丢帧）", innerCalls.length === 2);
      await store.pullAssets({ id: "vfail", playUrl: "u" }, { wantAudio: true, wantFrames: false });
      await store.pullAssets({ id: "vfail", playUrl: "u" }, { wantAudio: true, wantFrames: false });
      t("可重试类失败不缓存：第二次重新拉取", innerCalls.filter((c) => c.id === "vfail").length === 2);
      await store.pullAssets({ id: "vdet", playUrl: "u" }, { wantAudio: true, wantFrames: false });
      await store.pullAssets({ id: "vdet", playUrl: "u" }, { wantAudio: true, wantFrames: false });
      t("确定性失败（no_video_track）仍缓存：不重复空跑", innerCalls.filter((c) => c.id === "vdet").length === 1);
      t("isDeterministicMediaError 分类正确", m.isDeterministicMediaError("no_video_track") && m.isDeterministicMediaError("no_media") && !m.isDeterministicMediaError("network") && !m.isDeterministicMediaError("none"));
    }

    console.log("— 转写预算：新条目受 maxTranscribePerSync 约束（第四轮声明、第六轮接线）—");
    {
      const calls = { onStateChange: 0, saveImage: [], pullAssets: [], cleanup: [] };
      const vault = new MiniVault(m.TFile, m.TFolder);
      const engine = await makeEngine(
        m,
        makeSettings(DEFAULT_SETTINGS, { asrProvider: "siliconflow_sensevoice", siliconflowKey: "k" }),
        vault,
        calls,
      );
      engine.videoMedia = fakeVideoMedia(calls, {
        pullAssets: async () => ({ assets: { audioPath: "C:/tmp/fake-budget.mp3", framePaths: [] }, error: "", errorKind: "none" }),
        getAudio: async () => null,
      });
      const mk = async (id) => {
        const s = { visionOk: 0, errors: [], notices: [], created: 0, skipped: 0, asrFailed: 0, asrSkipped: 0, transcribed: 0, videoSummaries: 0 };
        return engine.processItem(DouyinClient.normalize(rawVideo(id), "collection"), "夹", s, undefined);
      };
      engine.asrBudgetLeft = 0;
      await mk("750001");
      t("预算耗尽：条目顺延进 pendingAsr（笔记仍落盘、台账仍登记）", engine.state.pendingAsr.includes("750001") && !!engine.state.processed["750001"]);
      t("顺延不记失败（attempts=0、立即可试）", engine.state.asrRetry["750001"]?.attempts === 0 && engine.asrRetryReady("750001") === true);
      t("台账记录来源 source（第四轮字段接线）", engine.state.processed["750001"].source === "collection");

      m.setRequestUrlMock(async () => {
        throw new Error("网络断开");
      });
      engine.asrBudgetLeft = 1;
      await mk("750002");
      t("预算 1 被真实转写扣减为 0", engine.asrBudgetLeft === 0);
      engine.asrBudgetLeft = 0;
      await mk("750003");
      t("预算 0：新条目顺延而非调用转写", engine.state.pendingAsr.includes("750003"));
      t("失败条目与顺延条目同在队列", engine.state.pendingAsr.includes("750002") && engine.state.pendingAsr.includes("750003"));
      m.setRequestUrlMock(async () => {
        throw new Error("requestUrl 不应在单测中被调用（需先 setRequestUrlMock 注入行为）");
      });
    }

    console.log("— retryPendingAsr：来源还原（第四轮声明、第六轮接线）—");
    {
      const calls = { onStateChange: 0, saveImage: [], pullAssets: [], cleanup: [] };
      const vault = new MiniVault(m.TFile, m.TFolder);
      const engine = await makeEngine(
        m,
        makeSettings(DEFAULT_SETTINGS, { asrProvider: "siliconflow_sensevoice", siliconflowKey: "k" }),
        vault,
        calls,
      );
      const summary = { visionOk: 0, errors: [], notices: [], created: 0, skipped: 0, asrFailed: 0, asrSkipped: 0, transcribed: 0, videoSummaries: 0 };
      const notice = new m.Notice("x", 0);
      engine.state.processed["760001"] = { path: "抖音/收藏/x/笔记 [760001].md", syncedAt: "", folder: "x", source: "like" };
      await vault.create("抖音/收藏/x/笔记 [760001].md", "---\ntype: 视频\n---\n正文");
      engine.state.pendingAsr = ["760001"];
      engine.state.asrRetry = { "760001": { attempts: 0, lastError: "e", nextRetryAt: new Date(Date.now() - 1000).toISOString() } };
      // 音频类条目：重试直接记 unavailable 重写笔记（不触转写接口），可完整验证 source 还原链
      DouyinClient.prototype.getAwemeDetail = async () => rawVideo("760001", { aweme_type: 163, media_type: 43 });
      await engine.retryPendingAsr(5, summary, notice);
      delete DouyinClient.prototype.getAwemeDetail;
      t("重试重建保留台账 source（like 不再被改写为 collection）", engine.state.processed["760001"]?.source === "like");
      const content = await vault.read(vault.getAbstractFileByPath("抖音/收藏/x/笔记 [760001].md"));
      t("重建笔记 frontmatter 来源为点赞", content.includes("点赞"));
    }

    console.log("— retryPendingAsr：ASR 配置不全不再静默空转（第六轮）—");
    {
      const calls = { onStateChange: 0, saveImage: [], pullAssets: [], cleanup: [] };
      const vault = new MiniVault(m.TFile, m.TFolder);
      const engine = await makeEngine(m, makeSettings(DEFAULT_SETTINGS, { asrProvider: "mystery_provider" }), vault, calls);
      const summary = { visionOk: 0, errors: [], notices: [], created: 0, skipped: 0, asrFailed: 0, asrSkipped: 0, transcribed: 0, videoSummaries: 0 };
      const notice = new m.Notice("x", 0);
      // 第九轮 A6：台账路径指向的笔记必须真实存在才进重试，先补建文件
      await vault.create("抖音/收藏/x/笔记 [780001].md", '---\ndouyin_id: "780001"\n---\n正文');
      engine.state.processed["780001"] = { path: "抖音/收藏/x/笔记 [780001].md", syncedAt: "", folder: "x" };
      engine.state.pendingAsr = ["780001"];
      engine.state.asrRetry = { "780001": { attempts: 0, lastError: "e", nextRetryAt: new Date(Date.now() - 1000).toISOString() } };
      DouyinClient.prototype.getAwemeDetail = async () => rawVideo("780001");
      await engine.retryPendingAsr(5, summary, notice);
      delete DouyinClient.prototype.getAwemeDetail;
      t("provider 为 null：记一次退避而非什么都不做", engine.state.asrRetry["780001"]?.attempts === 1);
      t("错误文案带 provider 名可排查", (engine.state.asrRetry["780001"]?.lastError ?? "").includes("mystery_provider"));
    }

    console.log("— backfillVideos：连续失败跳过 + 失败计数接线（第四轮声明、第六轮接线）—");
    {
      const calls = { onStateChange: 0, saveImage: [], pullAssets: [], cleanup: [], detail: [] };
      const vault = new MiniVault(m.TFile, m.TFolder);
      const engine = await makeEngine(m, makeSettings(DEFAULT_SETTINGS), vault, calls);
      // 候选 A：summary_v=2（会被补跑），带 2 次失败历史（成功后应清除）
      await vault.create("抖音/收藏/夹/候选A [770001].md", ["---", "type: 视频", "transcript_status: success", "transcript_provider: test", "frame_interval: 10", "summary_v: 2", "---", "", "> [!abstract]- 摘要", "> 旧摘要"].join("\n"));
      // 候选 B：同样是候选（无摘要块），但已连续失败 3 次 → 本轮直接跳过
      await vault.create("抖音/收藏/夹/候选B [770002].md", ["---", "type: 视频", "transcript_status: failed", "frame_interval: 10", "summary_v: 2", "---", ""].join("\n"));
      engine.state.processed["770001"] = { path: "抖音/收藏/夹/候选A [770001].md", syncedAt: "", folder: "夹", source: "collection" };
      engine.state.processed["770002"] = { path: "抖音/收藏/夹/候选B [770002].md", syncedAt: "", folder: "夹" };
      engine.state.backfillFails = { "770001": 2, "770002": 3 };
      DouyinClient.prototype.getAwemeDetail = async (id) => {
        calls.detail.push(id);
        return rawVideo(id);
      };
      const report = await engine.backfillVideos();
      delete DouyinClient.prototype.getAwemeDetail;
      t("连续失败 ≥3 的候选被跳过（不调详情接口）", !calls.detail.includes("770002"));
      t("正常候选仍补跑", calls.detail.includes("770001") && report.includes("处理 1"));
      t("成功后连续失败计数清除（保留恢复通道）", !engine.state.backfillFails["770001"]);
      t("跳过条目的失败计数保留", engine.state.backfillFails["770002"] === 3);
      t("补跑走详情串行闸门（接线不抛错即通过）", calls.detail.length === 1);
    }
  };

  // getter 形式：run-tests 在 await async() 之后读取 pass/fail，异步断言的计数才不会丢（修复静默漏计）
  return { get pass() { return pass; }, get fail() { return fail; }, async: asyncChecks };
}
