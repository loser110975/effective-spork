// statusCore 纯函数层单元测试（零覆盖保障为核心断言）。
// 运行方式：由 douyin-sync-obsidian/.tmp-tests.mjs 用 esbuild 打包后加载。
import assert from "node:assert/strict";

export function runTests(m) {
  const {
    statusVisual, statusAdvice, classifyAnomaly, parsePidsFromNetstat, isNumericPid,
    extractSummarySources, upsertAbstractBlock, appendOcrToNoteCallout, imageMimeFromName, pickEvenly,
    collectExistingAssets,
  } = m;
  let pass = 0, fail = 0;
  const t = (name, fn) => {
    try { fn(); pass++; console.log("  ✓ " + name); }
    catch (e) { fail++; console.log("  ✗ " + name + "\n      " + (e?.message ?? e)); }
  };

  console.log("— 二维状态灯（设计来源：系统设计 §3.2.M4.5 / UserStory §5.4.3）—");
  const ALL_PS = ["stopped", "starting", "running", "stopping", "failed"];
  const ALL_CS = ["unknown", "ok", "unreachable", "unauthorized"];

  t("全部 20 种组合都有状态灯（无盲区）", () => {
    for (const ps of ALL_PS) for (const cs of ALL_CS) {
      const v = statusVisual(ps, cs);
      assert.ok(v.color && v.label && v.icon, `${ps}|${cs} 缺字段`);
      assert.ok(v.advice, `${ps}|${cs} 缺处置建议`);
    }
  });
  t("running·ok = 运行中 · 连接正常", () => {
    assert.equal(statusVisual("running", "ok").label, "运行中 · 连接正常");
  });
  t("running·unauthorized 提示连接未授权", () => {
    assert.equal(statusVisual("running", "unauthorized").label, "运行中 · 连接未授权");
  });
  t("stopped·unknown → 建议点击启动", () => {
    assert.equal(statusAdvice("stopped", "unknown"), "点击「启动桥接」一键拉起");
  });
  t("failed·unreachable → 建议复核 Node / 依赖路径", () => {
    assert.equal(statusAdvice("failed", "unreachable"), "复核 Node 与依赖路径，或查看 bridge.log");
  });

  console.log("— E1~E4 异常分类（UserStory §5.5.3 判定顺序）—");
  t("探测完全不可达 → E1 进程未运行", () => {
    assert.equal(classifyAnomaly(null), "E1");
    assert.equal(classifyAnomaly({ reachable: false }), "E1");
  });
  t("不可达且端口被他人占用 → E2", () => {
    assert.equal(classifyAnomaly({ reachable: false, portOccupiedByOther: true }), "E2");
  });
  t("可达但 ok=false 且无内核 → E3 内核缺失", () => {
    assert.equal(classifyAnomaly({ reachable: true, ok: false, kernel: null }), "E3");
  });
  t("可达但未就绪 → E4 连接异常", () => {
    assert.equal(classifyAnomaly({ reachable: true, ok: true, ready: false, kernel: "playwright" }), "E4");
  });
  t("可达且就绪 → 无异常", () => {
    assert.equal(classifyAnomaly({ reachable: true, ok: true, ready: true, kernel: "playwright" }), "NONE");
  });

  console.log("— 进程探测纯解析 —");
  t("netstat 解析：仅取 LISTENING 且端口精确匹配", () => {
    const sample = [
      "  TCP    127.0.0.1:8765     0.0.0.0:0    LISTENING    1234",
      "  TCP    127.0.0.1:8765     1.2.3.4:5555 TIME_WAIT    9999",
      "  TCP    127.0.0.1:87650    0.0.0.0:0    LISTENING    4321",
      "  TCP    0.0.0.0:8766       0.0.0.0:0    LISTENING    555",
    ].join("\n");
    assert.deepEqual(parsePidsFromNetstat(sample, 8765), [1234]);
  });
  t("PID 必须是 1~10 位纯数字（防 taskkill 参数注入）", () => {
    assert.equal(isNumericPid("1234"), true);
    assert.equal(isNumericPid("12a4"), false);
    assert.equal(isNumericPid("-1"), false);
    assert.equal(isNumericPid(""), false);
    assert.equal(isNumericPid("12345678901"), false);
  });
  t("扩展名 → MIME 白名单", () => {
    assert.equal(imageMimeFromName("a.PNG"), "image/png");
    assert.equal(imageMimeFromName("a.svg"), null);
  });

  console.log("— 笔记文本手术（M3 零覆盖保障）—");
  const SRC = [
    "---",
    "douyin_id: \"123\"",
    "title: \"示例\"",
    "---",
    "",
    "> [!abstract]- 摘要",
    "> 旧摘要行",
    "",
    "> [!note]- 图片文字",
    "> 图片里的字 A",
    "> 图片里的字 B",
    "",
    "正文第一行",
    "",
    "> [!quote]- 逐字稿（fun-asr）",
    "> 第一句话",
    "> 第二句话",
    "",
    "---",
  ].join("\n");

  t("抽取逐字稿与图片文字（含 provider 后缀的 quote 标题）", () => {
    const { transcript, ocrText } = extractSummarySources(SRC);
    assert.ok(transcript.includes("第一句话") && transcript.includes("第二句话"), "逐字稿未抽全");
    assert.ok(ocrText.includes("图片里的字 A") && ocrText.includes("图片里的字 B"), "图片文字未抽全");
    assert.ok(!transcript.includes("正文第一行"), "正文被误抽进逐字稿");
  });

  t("★ 零覆盖：替换摘要块后，逐字稿与图片文字逐字不变", () => {
    const out = upsertAbstractBlock(SRC, "新摘要 1\n新摘要 2");
    const before = extractSummarySources(SRC);
    const after = extractSummarySources(out);
    assert.equal(after.transcript, before.transcript, "逐字稿被改动");
    assert.equal(after.ocrText, before.ocrText, "图片文字被改动");
    assert.ok(out.includes("> 新摘要 1") && out.includes("> 新摘要 2"), "新摘要未写入");
    assert.ok(!out.includes("旧摘要行"), "旧摘要未替换");
  });

  t("重复生成不产生重复摘要块", () => {
    const once = upsertAbstractBlock(SRC, "摘要甲");
    const twice = upsertAbstractBlock(once, "摘要乙");
    assert.equal((twice.match(/\[!abstract\]/g) || []).length, 1);
  });

  t("无 frontmatter 的笔记也能插入摘要块", () => {
    const plain = "正文而已";
    const out = upsertAbstractBlock(plain, "摘要");
    assert.ok(out.startsWith("> [!abstract]- 摘要"), "未插到文件头");
    assert.ok(out.includes("正文而已"));
  });

  t("导出 OCR：追加到既有图片文字块，逐字稿不受影响", () => {
    const out = appendOcrToNoteCallout(SRC, "新识别行");
    const { transcript } = extractSummarySources(out);
    assert.ok(transcript.includes("第一句话"), "逐字稿被改动");
    const { ocrText } = extractSummarySources(out);
    assert.ok(ocrText.includes("新识别行"), "未追加");
    assert.ok(ocrText.includes("图片里的字 A"), "原图片文字丢失");
  });

  t("导出 OCR：无图片文字块时新建", () => {
    const bare = "---\ntitle: \"x\"\n---\n\n> [!quote]- 逐字稿\n> 话\n";
    const out = appendOcrToNoteCallout(bare, "识别文本");
    assert.ok(out.includes("[!note]- 图片文字"), "块未创建");
    assert.ok(extractSummarySources(out).transcript.includes("话"), "逐字稿被改动");
  });

  console.log("— 既有笔记资产回收（问题 6：重试免二次副作用）—");
  const RICH = [
    "---",
    "douyin_id: \"123\"",
    "category: 投资理财",
    "cover: \"抖音/Media/cover/123.jpg\"",
    "transcript_status: success",
    "summary_v: 3",
    "---",
    "",
    "> [!abstract]- 摘要",
    "> 摘要行",
    "",
    "## 图片",
    "",
    "![[抖音/Media/images/123/1.jpg]]",
    "",
    "![[抖音/Media/images/123/2.jpg]]",
    "",
    "正文",
    "",
    "> [!note]- 图片文字",
    "> **图 1**（识别成功）",
    ">",
    "> 字幕文字甲",
    ">",
    "> **图 2**（识别成功）",
    ">",
    "> 字幕文字乙",
    "",
    "> [!note]- 关键帧（2 张）",
    "> ![[抖音/Media/frames/123/f001.jpg]]",
    "> ![[抖音/Media/frames/123/f002.jpg]]",
    "",
    "> [!quote]- 逐字稿（fun-asr）",
    "> 第一句话",
  ].join("\n");

  t("回收 frontmatter 的 cover 与 category（引号无关）", () => {
    const a = collectExistingAssets(RICH);
    assert.equal(a.coverPath, "抖音/Media/cover/123.jpg");
    assert.equal(a.category, "投资理财");
  });
  t("回收行首图片（关键帧不混入）", () => {
    const a = collectExistingAssets(RICH);
    assert.deepEqual(a.images, ["抖音/Media/images/123/1.jpg", "抖音/Media/images/123/2.jpg"]);
  });
  t("回收关键帧折叠块内的帧路径", () => {
    const a = collectExistingAssets(RICH);
    assert.deepEqual(a.framePaths, ["抖音/Media/frames/123/f001.jpg", "抖音/Media/frames/123/f002.jpg"]);
  });
  t("回收逐图 OCR 文本（含序号与状态）", () => {
    const a = collectExistingAssets(RICH);
    assert.equal(a.visionTexts.length, 2);
    assert.equal(a.visionTexts[0].index, 1);
    assert.equal(a.visionTexts[0].text, "字幕文字甲");
    assert.equal(a.visionTexts[1].index, 2);
    assert.equal(a.visionTexts[1].text, "字幕文字乙");
  });
  t("无 frontmatter / 非笔记内容返回空资产（回退联网路径）", () => {
    const a = collectExistingAssets("plain text only");
    assert.equal(a.coverPath, "");
    assert.equal(a.images.length, 0);
    assert.equal(a.visionTexts.length, 0);
    assert.equal(a.summaryText, "");
  });
  t("★ 回收既有摘要（防止重建笔记把摘要抹掉）", () => {
    const a = collectExistingAssets(RICH);
    assert.equal(a.summaryText, "摘要行");
    assert.equal(a.summaryV, "3");
  });
  t("★ 摘要回填后仍保持零覆盖（回填不碰逐字稿与图片文字）", () => {
    const a = collectExistingAssets(RICH);
    const rebuilt = "---\ntitle: \"x\"\n---\n\n> [!quote]- 逐字稿\n> 第一句话\n";
    const restored = upsertAbstractBlock(rebuilt, a.summaryText);
    const src = extractSummarySources(restored);
    assert.ok(restored.includes("> [!abstract]- 摘要"), "摘要块未回填");
    assert.ok(src.transcript.includes("第一句话"), "逐字稿被破坏");
  });
  t("回收后重写笔记：资产无损流转（零覆盖组合断言）", () => {
    const a = collectExistingAssets(RICH);
    assert.ok(a.images.length + a.framePaths.length + a.visionTexts.length > 0, "未回收到任何资产");
    const sources = extractSummarySources(RICH);
    assert.ok(sources.transcript.includes("第一句话"), "逐字稿在回收过程中丢失");
  });

  console.log("— 关键帧抽样（图片数上限自适应降档）—");
  t("帧数 ≤ 上限时原样返回", () => {
    assert.deepEqual(pickEvenly([1, 2, 3], 5), [1, 2, 3]);
  });
  t("抽 1 张取首帧", () => {
    assert.deepEqual(pickEvenly([1, 2, 3, 4, 5], 1), [1]);
  });
  t("抽 n 张保留首尾且均匀", () => {
    const r = pickEvenly([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 5);
    assert.equal(r.length, 5);
    assert.equal(r[0], 0);
    assert.equal(r[4], 9);
    assert.deepEqual(r, [0, 2, 5, 7, 9]);
  });
  t("抽 0 张返回空", () => {
    assert.deepEqual(pickEvenly([1, 2], 0), []);
  });

  return { get pass() { return pass; }, get fail() { return fail; } };
}
