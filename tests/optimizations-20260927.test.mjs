// 2026-09-27 优化轮新增纯函数用例：原子摘要写入 / 折叠块边界 / 导出幂等 / 台账去重 /
// Windows 文件名加固 / 埋点滤零 / Semaphore 防线。
import assert from "node:assert/strict";

export function runTests(m) {
  const {
    applySummaryToNote, upsertAbstractBlock, appendOcrToNoteCallout, frontmatterBlock,
    pushSummaryRecord, sanitizeFilename, planNotePath,
    summarizeStageTimings, detailStageTimings, Semaphore, mapLimit, clampConcurrency,
    extractSummarySources, collectExistingAssets,
  } = m;
  let pass = 0, fail = 0;
  const t = (name, ok) => {
    if (ok) { pass++; console.log("  ✓ " + name); }
    else { fail++; console.log("  ✗ " + name); }
  };

  console.log("— 原子摘要写入（applySummaryToNote）—");
  const base = [
    "---",
    "title: 测试",
    'type: "视频"',
    'summary: "旧摘要"',
    "summary_v: 2",
    "transcript_status: success",
    "---",
    "",
    "> [!quote]- 逐字稿",
    "> 内容",
  ].join("\n");

  const out1 = applySummaryToNote(base, "新摘要\n第二行", 3);
  const fm1 = out1.slice(0, out1.indexOf("\n---\n") + 1) + "---";
  t("旧 summary 与 summary_v 被移除", !out1.includes("旧摘要") && !/^summary_v: 2$/m.test(fm1));
  // 批次二 v4 分层（2026-10-16）：fm summary 写一行短摘要（无哨兵回退 = 首行前 60 码点）、
  // 正文摘要块写全文摘要——fm 不再携带多行全文
  t("新 summary 分层：fm 写短摘要（JSON 双引号标量）", out1.includes(`summary: ${JSON.stringify("新摘要")}`));
  t("summary_v 更新为 3", /^summary_v: 3$/m.test(out1));
  t("其余 frontmatter 键保留", /^type: "视频"$/m.test(fm1) && /^transcript_status: success$/m.test(fm1));
  t("正文逐字稿折叠块逐字保留", out1.includes("> [!quote]- 逐字稿\n> 内容"));
  t("摘要折叠块写入全文摘要", out1.includes("> [!abstract]- 摘要") && out1.includes("> 新摘要") && out1.includes("> 第二行"));

  const multi = ["---", "title: t", "summary: >-", "  旧第一行", "  旧第二行", "type: 视频", "---", "正文"].join("\n");
  const out2 = applySummaryToNote(multi, "新");
  t("块标量形式的多行旧摘要整体移除", !out2.includes("旧第一行") && !out2.includes("旧第二行") && /^type: 视频$/m.test(out2));

  const out3 = applySummaryToNote("正文第一行\n", "摘", 3);
  t("无 frontmatter 时新建且正文保留", out3.startsWith("---\nsummary: ") && out3.includes("正文第一行") && /^summary_v: 3$/m.test(out3));

  const once = applySummaryToNote(base, "S", 3);
  const twice = applySummaryToNote(once, "S", 3);
  t("幂等：连续 apply 两次输出不变", once === twice);

  const manual = applySummaryToNote(base, "手动摘要");
  t("未传版本号时保留既有 summary_v（手动摘要不破坏补跑判定）", /^summary_v: 2$/m.test(manual) && manual.includes("summary: \"手动摘要\""));
  t("summary_v 唯一（复审 P1：手动路径不累积重复 YAML 键）", (manual.match(/^summary_v:/gm) ?? []).length === 1);
  const manualTwice = applySummaryToNote(manual, "手动摘要2");
  t("两次手动摘要后 summary_v 仍唯一", (manualTwice.match(/^summary_v:/gm) ?? []).length === 1 && manualTwice.includes("summary: \"手动摘要2\""));
  const noVerNote = applySummaryToNote("---\ntitle: t\n---\n正文", "首次手动摘要");
  t("原本无 summary_v 的笔记手动摘要后仍不产生 summary_v", !/^summary_v:/m.test(noVerNote));

  console.log("— callout 行首 `>` 转义与层数稳定 —");
  const withQuote = applySummaryToNote(base, "行1\n> 引用行\n行3", 3);
  t("模型输出的引用行转成全角 ＞", withQuote.includes("> ＞ 引用行"));
  const extracted = withQuote
    .split("\n")
    .filter((l) => l.startsWith(">") && !l.includes("[!abstract]"))
    .map((l) => l.replace(/^>\s?/, ""))
    .join("\n");
  const reWritten = applySummaryToNote(base, extracted, 3);
  t("提取→回填一轮后不产生 `> >` 嵌套", !reWritten.includes("> > ") && reWritten.includes("> ＞ 引用行"));

  console.log("— 折叠块边界（不吞紧邻的下一个 callout）—");
  const adjacent = [
    "---", "type: 视频", "---",
    "> [!abstract]- 摘要", "> 摘要内容",
    "> [!info]- 用户自己的块", "> 用户内容",
    "",
    "正文",
  ].join("\n");
  const replaced = upsertAbstractBlock(adjacent, "新摘要");
  t("替换摘要时保留下一个折叠块与用户内容", replaced.includes("> [!info]- 用户自己的块") && replaced.includes("> 用户内容") && !replaced.includes("摘要内容"));
  t("摘要块被原位替换", replaced.includes("> 新摘要"));

  console.log("— OCR 导出幂等 —");
  const ocrNote = ["---", "type: 图文", "---", "> [!note]- 图片文字", "> **图 1**（识别成功）", "> 原始文字", ""].join("\n");
  const newText = "**图 1**（识别成功）\n原始文字";
  const onceExport = appendOcrToNoteCallout(ocrNote, newText);
  const twiceExport = appendOcrToNoteCallout(onceExport, newText);
  t("同一份识别结果重复导出不再追加", onceExport === twiceExport);
  const samePrefix = ["---", "type: 图文", "---", "> [!note]- 图片文字", "> **图 1**（识别成功）", "> 相同页眉：第一章 绪论", ""].join("\n");
  const diffText = "**图 1**（识别成功）\n相同页眉：第一章 绪论\n第二张图特有内容";
  const appended = appendOcrToNoteCallout(samePrefix, diffText);
  t("前 80 字相同但内容不同的导出仍会追加（不静默丢内容）", appended.includes("第二张图特有内容"));
  const added = appendOcrToNoteCallout(ocrNote, "**图 1**（识别成功）\n原始文字\n新增行");
  t("内容有差异时仍允许追加", added.split("\n").length > ocrNote.split("\n").length);

  console.log("— frontmatter 区间切片（防正文劫持分支）—");
  const hijack = ["---", "type: 图文", "---", "正文", "type: 视频", "more"].join("\n");
  t("frontmatter 内 type 判定不受正文同名行影响", /^type:\s*"?(图文)"?\s*$/m.test(frontmatterBlock(hijack)) && !/^type:\s*"?(视频)"?\s*$/m.test(frontmatterBlock(hijack)));
  t("无 frontmatter 返回空串", frontmatterBlock("正文") === "");

  console.log("— 摘要台账去重（pushSummaryRecord）—");
  const rec1 = { notePath: "a.md", sourceChars: 1, model: "m", status: "failed", generatedAt: "t1" };
  const rec2 = { notePath: "a.md", sourceChars: 1, model: "m", status: "success", generatedAt: "t2" };
  const rec3 = { notePath: "b.md", sourceChars: 1, model: "m", status: "success", generatedAt: "t3" };
  const ledger = pushSummaryRecord(pushSummaryRecord([rec1], rec2), rec3);
  t("同一笔记先失败后成功只留最新一条", ledger.filter((r) => r.notePath === "a.md").length === 1 && ledger.find((r) => r.notePath === "a.md").status === "success");
  t("不同笔记互不影响", ledger.length === 2 && ledger.some((r) => r.notePath === "b.md"));

  console.log("— sanitizeFilename Windows 加固 —");
  t("保留设备名加前缀", sanitizeFilename("CON").startsWith("_"));
  t("保留名带扩展形式同样处理", sanitizeFilename("NUL.txt").startsWith("_"));
  t("结尾点被剥离", !sanitizeFilename("标题.").endsWith("."));
  t("结尾空格被剥离", !sanitizeFilename("标题  ").endsWith(" "));
  t("常规标题不受影响", sanitizeFilename("正常的标题") === "正常的标题");
  t("非法字符仍被清洗", !/[\\/:*?"<>|]/.test(sanitizeFilename('a/b\\c:d*e?f"g<h>i|j')));
  t("DEL 控制符被清洗", !/\u007f/.test(sanitizeFilename("a\u007fb")));
  const surrogateTrunc = sanitizeFilename("标".repeat(60) + "\u{1F600}"); // 61 个码点（62 code units）→ 截断
  t("截断按码点切，不产生孤代理（复审 P1）", !/[\uD800-\uDFFF]$/.test(surrogateTrunc) && Array.from(surrogateTrunc).length <= 60);

  console.log("— 折叠块解析边界（复审 P2 回归）—");
  const adjacentTranscript = [
    "---", "type: 视频", "---",
    "> [!quote]- 逐字稿（whisper）",
    "> 第一句话",
    "> [!note]- 图片文字",
    "> 用户图片里的内容",
  ].join("\n");
  const srcAdj = extractSummarySources(adjacentTranscript);
  t("紧邻兄弟折叠块的正文不泄入逐字稿", srcAdj.transcript === "第一句话");

  const twoBlocks = [
    "---", "type: 图文", "---",
    "> [!note]- 图片文字",
    "> **图 1**（识别成功）", "> 图1文字",
    "> **图 2**（识别成功）", "> 图2文字",
    "> [!note]- 图片文字",
    "> **图 3**（识别成功）", "> 图3文字",
  ].join("\n");
  const assets2 = collectExistingAssets(twoBlocks);
  t("双子块布局不丢上一块最后一张图的 OCR（复审 P2）", assets2.visionTexts.length === 3 && assets2.visionTexts.every((v) => v.text.includes("图") && v.text.includes("文字")));

  console.log("— planNotePath 收藏夹名清洗 —");
  const item = { id: "123456", source: "collection", type: "video", title: "t", desc: "", author: "", authorId: "", createTime: 0, playUrl: "", coverUrl: "", imageUrls: [], durationSec: 0, stats: { likes: 0, comments: 0, collects: 0, shares: 0 } };
  const p1 = planNotePath("抖音", item, "非法/夹名:测试", "标题");
  t("收藏夹名中的路径字符被清洗", !p1.includes("非法/夹名:测试") && p1.includes("抖音/收藏/"));
  const p2 = planNotePath("抖音", item, "", "标题");
  t("空收藏夹回退「未分类」", p2.includes("抖音/收藏/未分类/"));

  console.log("— 埋点滤零 —");
  const rows = [];
  for (let i = 0; i < 8; i++) rows.push({ id: "n" + i, type: "note", totalMs: 5000, asrMs: 0, summaryMs: 0, recordedAt: "2026-09-27T00:00:00Z" });
  rows.push({ id: "v1", type: "video", totalMs: 100000, asrMs: 100000, recordedAt: "2026-09-27T00:00:00Z" });
  rows.push({ id: "v2", type: "video", totalMs: 120000, asrMs: 120000, recordedAt: "2026-09-27T00:00:00Z" });
  t("图文 0 样本不稀释转写 p50", summarizeStageTimings(rows).includes("转写 110.0s"));
  t("明细同样滤零", detailStageTimings(rows).includes("转写：p50 110.0s / p90 118.0s"));

  console.log("— Semaphore fail-fast 防线 —");
  t("limit=0 构造即抛错", assert.throws(() => new Semaphore(0)) === undefined);
  t("limit=NaN 构造即抛错", assert.throws(() => new Semaphore(NaN)) === undefined);
  t("clampConcurrency 非法值回退", clampConcurrency(0, 3, 6) === 3 && clampConcurrency(99, 3, 6) === 6);

  console.log("— mapLimit 保序与峰值（异步）—");
  const asyncChecks = async () => {
    let active = 0, peak = 0;
    const res = await mapLimit([1, 2, 3, 4, 5], 2, async (n) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
      return n * 2;
    });
    t("并发峰值 ≤ limit", peak <= 2);
    t("结果保序", JSON.stringify(res) === "[2,4,6,8,10]");
  };

  // getter 形式：run-tests 在 await async() 之后读取 pass/fail，异步断言的计数才不会丢（修复静默漏计）
  return { get pass() { return pass; }, get fail() { return fail; }, async: asyncChecks };
}
