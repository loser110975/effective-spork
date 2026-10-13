// 第九轮修复测试（2026-09-27）：
// 纯函数——shouldDropToNextStep（B1 降档循环）、frontmatter 闭合围栏行首判定（A9）；
// 引擎级（MiniVault + 协作者 stub）——frame_interval 真实间隔回写与重抽意图（A1）、
// needAudio 时不重编帧（B7）、writeItemNote 间隔落盘、全新撞库资产回收（A2）、
// 同页重复 id in-flight 防线（A3）、转写暂存复用与清除（B3）、
// 已删笔记不再复活（A6）、互链无变化不写盘（A4）、互链重建守卫（A12）。
import assert from "node:assert/strict";

// ---------- 引擎级测试替身 ----------

/** 内存 Vault：覆盖本轮引擎路径需要的最小面（含 create / getFiles / createFolder）。 */
class MiniVault {
  constructor(TFile) {
    this.TFile = TFile;
    this.files = new Map(); // path -> string
    this.processCalls = 0;
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
  getFiles() {
    return this.getMarkdownFiles();
  }
  async create(p, content) {
    const path = String(p).replace(/\\/g, "/");
    if (this.files.has(path)) throw new Error(`create: 已存在 ${path}`);
    this.files.set(path, content);
    return this.makeFile(path);
  }
  async createFolder() {
    /* 目录不入 files（getAbstractFileByPath 对目录返回 null 与用例无冲突） */
  }
  async read(file) {
    const p = file.path ?? file;
    if (!this.files.has(p)) throw new Error(`read: 不存在 ${p}`);
    return this.files.get(p);
  }
  async process(file, fn) {
    const p = file.path ?? file;
    if (!this.files.has(p)) throw new Error(`process: 不存在 ${p}`);
    this.processCalls++;
    const next = await fn(this.files.get(p));
    if (typeof next === "string") this.files.set(p, next);
    return this.files.get(p);
  }
}

function makeEngine(m, vault, settingsOver = {}) {
  const settings = {
    ...m.DEFAULT_SETTINGS,
    rootFolder: "抖音",
    relatedNotesEnabled: true,
    relatedNotesMax: 8,
    ...settingsOver,
  };
  const app = { vault };
  return new m.SyncEngine(app, settings, async () => {}, () => {});
}

function blankSummary() {
  return {
    total: 0,
    created: 0,
    skipped: 0,
    transcribed: 0,
    asrFailed: 0,
    asrSkipped: 0,
    visionOk: 0,
    videoSummaries: 0,
    errors: [],
    notices: [],
    startedAt: "",
    finishedAt: "",
  };
}

function makeItem(id, type) {
  return {
    id,
    type,
    source: "collection",
    title: `标题${id}`,
    desc: "",
    author: "张三",
    authorId: "sec",
    createTime: 0,
    playUrl: "",
    coverUrl: "",
    imageUrls: [],
    durationSec: 30,
    stats: { likes: 0, comments: 0, collects: 0, shares: 0 },
  };
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
    const { shouldDropToNextStep, applySummaryToNote, frontmatterBlock } = m;

    console.log("— shouldDropToNextStep：降档步进判定（B1）—");
    {
      // 6 帧视频 × glm-4v-flash（上限 5）：首档 8 超限后必须还能降档（旧判定在此直接 break）
      t("6 帧 × 档位 8 → 下一档 5 能减图（继续降档）", shouldDropToNextStep(6, 8, 5) === true);
      t("6 帧 × 档位 5 → 下一档 2 能减图", shouldDropToNextStep(6, 5, 2) === true);
      t("3 帧 × 档位 5 → 下一档 2 仍能减图（3→2）", shouldDropToNextStep(3, 5, 2) === true);
      t("2 帧 × 档位 2 → 下一档 1 能减图", shouldDropToNextStep(2, 2, 1) === true);
      t("1 帧 × 档位 1 → 无处可降（false）", shouldDropToNextStep(1, 1, undefined) === false);
      t("无下一档 → false", shouldDropToNextStep(10, 8, undefined) === false);
      t("10 帧 × 档位 8 → 下一档 5 能减图", shouldDropToNextStep(10, 8, 5) === true);
    }

    console.log("— frontmatter 闭合围栏行首判定（A9）—");
    {
      // 多行块标量值里手改出缩进 `  ---`：旧 trim() 判定会误认成闭合围栏，
      // summary 被插进 YAML 中段；新判定按 YAML 口径只认列 0 的 ---
      const tricky = '---\ntitle: x\nnote: |\n  line1\n  ---\n  line2\nfoo: bar\n';
      t("缩进 --- 不再误判闭合：畸形 fm 原样返回（宁可不动）", applySummaryToNote(tricky, "摘要", 3) === tricky);
      t("缩进 --- 不提前截断：frontmatterBlock 返回空串", frontmatterBlock(tricky) === "");
      const trailing = "---\ntitle: x\n--- \nbody";
      t("带尾随空格的闭合围栏仍识别", frontmatterBlock(trailing) === "---\ntitle: x\n--- ");
      const normal = "---\ntitle: x\n---\nbody";
      const out = applySummaryToNote(normal, "摘要内容", 3);
      t("正常 frontmatter：summary 写入 fm 区且 body 保留", /^summary: "摘要内容"$/m.test(out) && out.endsWith("body"));
    }

    console.log("— resolveVideoAssets：frame_interval 真实间隔与重抽意图（A1/B7）—");
    {
      const vault = new MiniVault(m.TFile);
      const engine = makeEngine(m, vault, {
        videoSummaryEnabled: true,
        videoSummaryApiKey: "k",
        keyframeIntervalSec: 10,
        asrProvider: "siliconflow_sensevoice",
        siliconflowKey: "k",
      });
      let pullOpts = null;
      engine.videoMedia = {
        pullAssets: async (_item, opts) => {
          pullOpts = opts;
          // 模拟 pullAssets 的按需裁剪：wantFrames=false 时不产出帧
          return {
            assets: { audioPath: "", framePaths: opts?.wantFrames ? ["抖音/Media/frames/v1/frame_01.jpg"] : [] },
            errorKind: "none",
            error: "",
          };
        },
        cleanup: () => {},
      };
      const reused = {
        coverPath: "",
        category: "",
        images: [],
        visionTexts: [],
        framePaths: ["抖音/Media/frames/v1/frame_01.jpg"],
        frameInterval: "30",
        summaryText: "",
        summaryV: "",
      };
      const asr = { status: "success", transcript: "t", provider: "x" };
      const item = makeItem("v1", "video");

      // Case 1：backfill 重抽意图（帧间隔不匹配）→ 不复用旧帧，走拉取，新帧间隔=当前设置
      let out = await engine.resolveVideoAssets(item, reused, asr, undefined, true, blankSummary());
      t("A1：重抽意图下不复用旧帧（wantFrames=true 走拉取）", pullOpts !== null && pullOpts.wantFrames === true && pullOpts.wantAudio === false);
      t("A1：拉取的新帧间隔=当前设置 10", out.frameIntervalSec === 10);

      // Case 2：重试路径（无重抽意图）→ 复用 reused 帧，间隔=笔记记录的 30
      pullOpts = null;
      out = await engine.resolveVideoAssets(item, reused, asr, undefined, false, blankSummary());
      t("A1：重试路径复用旧帧且不触发拉取", pullOpts === null && out.assets.framePaths.length === 1);
      t("A1：复用帧的真实间隔=笔记记录值 30", out.frameIntervalSec === 30);

      // Case 3（B7）：转录缺失需音频 + 帧网格完好 → 帧路裁剪、帧从 reused 回填
      pullOpts = null;
      out = await engine.resolveVideoAssets(item, reused, undefined, undefined, false, blankSummary());
      t("B7：needAudio 时帧路被裁剪（wantFrames=false）", pullOpts !== null && pullOpts.wantAudio === true && pullOpts.wantFrames === false);
      t("B7：帧从 reused 回填且间隔如实=30", out.assets.framePaths.length === 1 && out.frameIntervalSec === 30);
    }

    console.log("— writeItemNote：frame_interval 落盘口径（A1）—");
    {
      const vault = new MiniVault(m.TFile);
      const engine = makeEngine(m, vault, { videoSummaryEnabled: false });
      const item = makeItem("v2", "video");
      const asr = { status: "success", transcript: "转录内容", provider: "x" };
      const res = await engine.writeItemNote({
        item,
        folder: "测试",
        reused: null,
        category: "c",
        coverPath: "",
        imagesDownloaded: [],
        visionTexts: [],
        asr,
        assets: { audioPath: "", framePaths: ["f1.jpg"] },
        frameIntervalSec: 30,
      });
      const content = vault.files.get(res.path);
      t("有帧：frame_interval 写真实间隔 30（不再盲写当前设置）", /^frame_interval: 30$/m.test(content));
      const res2 = await engine.writeItemNote({
        item,
        folder: "测试",
        reused: null,
        category: "c",
        coverPath: "",
        imagesDownloaded: [],
        visionTexts: [],
        asr,
        assets: { audioPath: "", framePaths: [] },
        frameIntervalSec: 0,
      });
      t("无帧：不写 frame_interval（部分成功不伪装达标）", !/^frame_interval:/m.test(vault.files.get(res2.path)));
    }

    console.log("— processItem：全新撞库资产回收（A2）—");
    {
      const vault = new MiniVault(m.TFile);
      const existing = [
        "---",
        'douyin_id: "f1"',
        'title: "旧标题"',
        'type: "图文"',
        'source: "收藏"',
        'category: "投资理财"',
        "---",
        "",
        "# 旧标题",
        "",
        "> [!abstract]- 摘要",
        "> 旧摘要内容第一行",
        "> 旧摘要内容第二行",
        "",
        "用户手写的正文段落",
        "",
        "---",
        "",
        "*同步于 2026-09-27T00:00:00.000Z ｜ douyin-sync*",
        "",
      ].join("\n");
      vault.files.set("抖音/收藏/测试/2026-01-01 旧标题 [f1].md", existing);
      const engine = makeEngine(m, vault, { videoSummaryEnabled: false });
      const summary = blankSummary();
      const ok = await engine.processItem(makeItem("f1", "note"), "测试", summary);
      const finalPath = engine.state.processed["f1"]?.path ?? "";
      const content = finalPath ? vault.files.get(finalPath) : "";
      t("撞库条目按 overwrite 重建成功", ok === true && finalPath.endsWith("[f1].md"));
      t("A2：既有摘要块在重建后回填保留", content.includes("> [!abstract]- 摘要") && content.includes("旧摘要内容第一行"));
      t("A2：既有分类被回收复用（不再重新分类）", content.includes('category: "投资理财"'));
    }

    console.log("— processItem：转写暂存复用（B3）—");
    {
      const vault = new MiniVault(m.TFile);
      const engine = makeEngine(m, vault, { videoSummaryEnabled: false });
      // provider 必须用真实 provider 名（第十轮 F7：peek 校验 provider 与 asrProvider 一致才复用）
      engine.state.transcriptCache = {
        v3: { transcript: "已付费的转录内容", provider: "siliconflow_sensevoice", at: new Date().toISOString() },
      };
      const summary = blankSummary();
      const ok = await engine.processItem(makeItem("v3", "video"), "测试", summary);
      const p = engine.state.processed["v3"]?.path ?? "";
      const content = p ? vault.files.get(p) : "";
      t("暂存命中：笔记直接带逐字稿（不再调 ASR）", ok === true && content.includes("已付费的转录内容"));
      t("暂存命中：frontmatter transcript_status=success", content.includes("transcript_status:"));
      t("台账收尾后暂存清除", engine.state.transcriptCache["v3"] === undefined);
    }

    console.log("— processItem：暂存 provider 不匹配 → 忽略并清除（F7）—");
    {
      const vault = new MiniVault(m.TFile);
      const engine = makeEngine(m, vault, { videoSummaryEnabled: false });
      // 用户已切换 ASR 供应商：旧供应商的暂存转录不得抢先落账（否则该条目永不按新供应商重转）
      engine.state.transcriptCache = {
        v9: { transcript: "旧供应商的转录", provider: "dashscope_paraformer", at: new Date().toISOString() },
      };
      const summary = blankSummary();
      const ok = await engine.processItem(makeItem("v9", "video"), "测试", summary);
      const p = engine.state.processed["v9"]?.path ?? "";
      const content = p ? vault.files.get(p) : "";
      t("旧供应商暂存被忽略（笔记不含其转录）", ok === true && !content.includes("旧供应商的转录"));
      t("过期暂存条目已从缓存清除", engine.state.transcriptCache["v9"] === undefined);
    }

    console.log("— consumePage：同页重复 id in-flight 防线（A3）—");
    {
      const vault = new MiniVault(m.TFile);
      const engine = makeEngine(m, vault, { videoSummaryEnabled: false });
      let calls = 0;
      engine.processItem = async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 30)); // 制造并发窗口
        return true;
      };
      const raw = { aweme_id: "123456789012", desc: "t", aweme_type: 0 };
      const summary = blankSummary();
      const r = await engine.consumePage([raw, raw], "collection", "测试", summary, undefined);
      t("重复 id 只跑一次（并发下不再双跑双计费）", calls === 1 && r.created === 1 && summary.skipped === 1);
    }

    console.log("— retryPendingAsr：已删笔记不再复活（A6）—");
    {
      const vault = new MiniVault(m.TFile); // 空库：台账里的笔记已被用户删除
      const engine = makeEngine(m, vault, { videoSummaryEnabled: false });
      let detailCalls = 0;
      engine.client = { getAwemeDetail: async () => { detailCalls++; return null; } };
      engine.state.processed = {
        x: { path: "抖音/收藏/测试/2026-01-01 t [x].md", syncedAt: "", folder: "测试" },
      };
      engine.state.pendingAsr = ["x"];
      engine.state.asrRetry = { x: { attempts: 0, lastError: "", nextRetryAt: new Date(Date.now() - 1000).toISOString() } };
      const summary = blankSummary();
      await engine.retryPendingAsr(5, summary, new m.Notice("t"));
      t("笔记已删除：重试队列结清且不调详情（不重建复活）", engine.state.pendingAsr.length === 0 && detailCalls === 0 && engine.state.asrRetry["x"] === undefined);
      t("processed 台账保留（下轮不会当新条目重建）", engine.state.processed["x"] !== undefined);
    }

    console.log("— writeRelatedBlock：无变化不写盘（A4）—");
    {
      const vault = new MiniVault(m.TFile);
      const note = [
        "---",
        'douyin_id: "a"',
        "---",
        "",
        "# 笔记A",
        "",
        "---",
        "",
        "*同步于 2026-09-27T00:00:00.000Z ｜ douyin-sync*",
        "",
      ].join("\n");
      vault.files.set("抖音/收藏/成长学习/A.md", note);
      const engine = makeEngine(m, vault, { relatedNotesEnabled: true });
      const file = vault.getAbstractFileByPath("抖音/收藏/成长学习/A.md");
      const self = { id: "a", category: "成长学习", author: "张三" };
      const candidates = [
        { path: "抖音/收藏/成长学习/A.md", id: "a", category: "成长学习", author: "张三", title: "笔记A", likes: 0 },
        { path: "抖音/收藏/成长学习/B.md", id: "b", category: "成长学习", author: "李四", title: "笔记B", likes: 5 },
      ];
      const links1 = await engine.writeRelatedBlock(file, self, candidates);
      const callsAfterFirst = vault.processCalls;
      const links2 = await engine.writeRelatedBlock(file, self, candidates);
      t("首次写入：块落盘且返回互链", callsAfterFirst === 1 && links1.length === 1);
      t("二次写入：内容无变化不再落盘（mtime 不动）", vault.processCalls === callsAfterFirst && links2.length === 1);
    }

    console.log("— findNotePath：douyin_id frontmatter 兜底（A6 配套）—");
    {
      const vault = new MiniVault(m.TFile);
      const renamed = "抖音/收藏/测试/用户改名后的笔记.md";
      vault.files.set(renamed, '---\ndouyin_id: "r1"\n---\n正文');
      const engine = makeEngine(m, vault);
      engine.app = {
        vault,
        metadataCache: { getFileCache: (f) => (f.path === renamed ? { frontmatter: { douyin_id: "r1" } } : null) },
      };
      t("改名后文件名后缀失配：按 douyin_id frontmatter 找回", engine.findNotePath("r1") === renamed);
      t("索引回填", engine.noteIndexGet().get("r1") === renamed);
      t("彻底删除：仍返回 null（A6 据此结清队列）", engine.findNotePath("gone") === null);
    }

    console.log("— refreshAllRelatedNotes：守卫（A12）—");
    {
      const vault = new MiniVault(m.TFile);
      const engine = makeEngine(m, vault, { relatedNotesEnabled: false });
      const r = await engine.refreshAllRelatedNotes();
      t("互链开关关闭：扫描 0、更新 0、不写库", r.scanned === 0 && r.updated === 0 && vault.processCalls === 0);
      engine.settings = { ...engine.settings, relatedNotesEnabled: true };
      engine.running = true;
      let threw = false;
      try {
        await engine.refreshAllRelatedNotes();
      } catch {
        threw = true;
      }
      t("同步进行中：拒绝并发重建（抛错）", threw === true);
      engine.running = false;
    }
  };

  return { get pass() { return pass; }, get fail() { return fail; }, async: asyncChecks };
}
