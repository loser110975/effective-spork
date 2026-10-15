// 第十四轮测试（摘要质量两连修）：
// ① headTailSlice——首尾保留式截断（视频通道首 3000+尾 1000 / 图文通道首 6000+尾 2000 的共用底座，
//    按码点切分防 emoji/星体字符撕裂）；
// ② buildPrompt / 图文通道 prompt 的截断明示（截断时出现、未截断不出现）；
// ③ summaryMaxTokens 500→2000 存量迁移（恰好等于旧默认才迁移；其他合法值不动；非法值走 fallback 2000）；
// ④ ai.lastResponseTruncated——二次截断标记（扩预算后仍 length / 钳制通道截断均置位；每次调用重置）；
// ⑤ 端到端：视频/图文通道截断后 status 仍 success、errorMessage 写入截断提示、视频 msg 并入截断信息。
import assert from "node:assert/strict";

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

  console.log("— headTailSlice：首尾保留式截断（第十四轮）—");
  {
    const { headTailSlice, HEAD_TAIL_OMITTED_MARK } = m;

    const short = "abc";
    const r1 = headTailSlice(short, 5, 3);
    t("短文本原样返回且 truncated=false", r1.text === short && r1.truncated === false);

    const exact = "abcdefgh"; // 恰好 8 = 5+3
    const r2 = headTailSlice(exact, 5, 3);
    t("恰好等于上限：原样返回不截断", r2.text === exact && r2.truncated === false);

    const long = "0123456789" + "x".repeat(20); // 30 码点
    const r3 = headTailSlice(long, 10, 5);
    t("超长：truncated=true 且头 10 尾 5 正确", r3.truncated === true && r3.text.startsWith("0123456789") && r3.text.endsWith("xxxxx"));
    t("中段省略标记存在", r3.text.includes(HEAD_TAIL_OMITTED_MARK));
    t("总长 = head + tail + 标记（无其他内容混入）", Array.from(r3.text).length === 10 + 5 + Array.from(HEAD_TAIL_OMITTED_MARK).length);

    // 星体字符不撕裂：把 emoji 恰好放在头/尾切分边界上——若按 UTF-16 code unit 切，
    // 头段末尾/尾段开头必劈出孤代理；按码点切则 emoji 完整保留
    const straddle = "a".repeat(2999) + "😀" + "x".repeat(2999) + "😀" + "b".repeat(999); // 6999 码点
    const r4 = headTailSlice(straddle, 3000, 1000);
    t("星体字符：头段末尾的 emoji 完整保留（头 = a×2999 + 😀）", r4.truncated === true && r4.text.startsWith("a".repeat(2999) + "😀"));
    t("星体字符：尾段开头的 emoji 完整保留（尾 = 😀 + b×999）", r4.text.endsWith("😀" + "b".repeat(999)));
    const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    t("星体字符：输出不含孤代理", !loneSurrogate.test(r4.text));

    // 混合文本：emoji 夹在 BMP 字符之间，头尾切片与码点切片逐字一致
    const mixed = "a😀b😀c".repeat(6);
    const r5 = headTailSlice(mixed, 7, 4);
    const headPart = Array.from(mixed).slice(0, 7).join("");
    const tailPart = Array.from(mixed).slice(-4).join("");
    t("混合文本首尾与码点切片一致", r5.truncated === true && r5.text.startsWith(headPart) && r5.text.endsWith(tailPart));
    t("混合文本输出不含孤代理", !loneSurrogate.test(r5.text));

    t("空串安全", headTailSlice("", 5, 3).text === "" && headTailSlice("", 5, 3).truncated === false);
    const r6 = headTailSlice("abcdef", 6, 0);
    t("tail=0：只留头部且不触发 slice(-0) 全文回拼", r6.truncated === false && r6.text === "abcdef");
    const r7 = headTailSlice("abcdefgh", 6, 0);
    t("tail=0 且超长：尾部为空", r7.truncated === true && r7.text === "abcdef" + HEAD_TAIL_OMITTED_MARK);
  }

  console.log("— buildPrompt：截断明示（第十四轮）—");
  {
    const base = { title: "T", transcript: "转录内容", frameCount: 2, intervalSec: 10 };
    const p1 = m.buildPrompt({ ...base, transcriptTruncated: true });
    t("截断时提示词含中段缺失明示", p1.includes("中段省略") && p1.includes("严禁对未提供的中间内容做任何编造"));
    t("截断明示句与共享常量同源", p1.includes(m.SOURCE_TRUNCATION_NOTICE));
    const p2 = m.buildPrompt({ ...base });
    t("未截断（缺省参数）不含截断明示", !p2.includes("中段省略") && !p2.includes("严禁对未提供的中间内容"));
    const p3 = m.buildPrompt({ ...base, transcriptTruncated: false });
    t("truncated=false 不含截断明示", !p3.includes("中段省略"));
    t("不传新参数时既有结构兼容（转录原文与风格段仍在）", p2.includes("转录内容") && p2.includes("## AI 总结"));
    // 空转录走「无转录」分支：即使误传 truncated=true 也不出现明示句（分支互斥）
    const p4 = m.buildPrompt({ ...base, transcript: "  ", transcriptTruncated: true });
    t("空转录分支不出现截断明示", p4.includes("空或无效") && !p4.includes("中段省略"));
  }

  console.log("— 设置迁移：summaryMaxTokens 500→2000（第十四轮）—");
  {
    const t500 = m.sanitizeNumericSettings({ ...m.DEFAULT_SETTINGS, summaryMaxTokens: 500 });
    t("存量旧默认 500 → 2000", t500.summaryMaxTokens === 2000);
    t("迁移幂等（再消毒一次仍 2000）", m.sanitizeNumericSettings(t500).summaryMaxTokens === 2000);
    const tStr500 = m.sanitizeNumericSettings({ ...m.DEFAULT_SETTINGS, summaryMaxTokens: "500" });
    t("字符串 \"500\"（旧默认字符串形态）同样迁移", tStr500.summaryMaxTokens === 2000);
    const t300 = m.sanitizeNumericSettings({ ...m.DEFAULT_SETTINGS, summaryMaxTokens: 300 });
    t("用户自设 300 不动", t300.summaryMaxTokens === 300);
    const t2500 = m.sanitizeNumericSettings({ ...m.DEFAULT_SETTINGS, summaryMaxTokens: 2500 });
    t("用户自设 2500 不动", t2500.summaryMaxTokens === 2500);
    const tBig = m.sanitizeNumericSettings({ ...m.DEFAULT_SETTINGS, summaryMaxTokens: 4321 });
    t("超上限 4321 仍按既有钳制收 4000", tBig.summaryMaxTokens === 4000);
    const tLow = m.sanitizeNumericSettings({ ...m.DEFAULT_SETTINGS, summaryMaxTokens: 100 });
    t("低于下限 100 仍按既有钳制抬 200", tLow.summaryMaxTokens === 200);
    const tStr = m.sanitizeNumericSettings({ ...m.DEFAULT_SETTINGS, summaryMaxTokens: "abc" });
    t("非法字符串走 fallback 2000", tStr.summaryMaxTokens === 2000);
    const tNull = m.sanitizeNumericSettings({ ...m.DEFAULT_SETTINGS, summaryMaxTokens: null });
    t("null 走 fallback 2000", tNull.summaryMaxTokens === 2000);
    const t499 = m.sanitizeNumericSettings({ ...m.DEFAULT_SETTINGS, summaryMaxTokens: 499 });
    t("非 500 的 499 不迁移（只认恰好等于旧默认）", t499.summaryMaxTokens === 499);
    t("DEFAULT_SETTINGS 默认值 = 2000", m.DEFAULT_SETTINGS.summaryMaxTokens === 2000);
    t("迁移常量口径（旧 500 / 新 2000）", m.SUMMARY_MAX_TOKENS_LEGACY_DEFAULT === 500 && m.SUMMARY_MAX_TOKENS_DEFAULT === 2000);
    t("fallbackMatchesDefaults 仍绿（fallback 与 DEFAULT_SETTINGS 同步，漂移即红）", m.fallbackMatchesDefaults() === true);
  }

  // ---------- 引擎级替身（最小化：只覆盖摘要通道用到的 vault 面） ----------
  function makeTinyVault(TFile) {
    const files = new Map();
    return {
      files,
      async create(p, content) {
        files.set(p, content);
        const f = new TFile();
        f.path = p;
        f.name = p.slice(p.lastIndexOf("/") + 1);
        f.basename = f.name.replace(/\.md$/, "");
        return f;
      },
      async read(file) {
        const c = files.get(file.path);
        if (c === undefined) throw new Error(`read: 不存在 ${file.path}`);
        return c;
      },
      async process(file, fn) {
        const next = await fn(files.get(file.path));
        files.set(file.path, next);
        return next;
      },
    };
  }

  const asyncChecks = async () => {
    console.log("— ai.lastResponseTruncated：二次截断标记（第十四轮）—");
    {
      // 场景 1：正常 stop → 标记保持 false
      const c1 = new m.AiClient("https://r14.example/v1", "k", "test-model");
      m.setRequestUrlMock(async () => {
        const payload = { choices: [{ message: { content: "完整输出" }, finish_reason: "stop" }] };
        return { status: 200, text: JSON.stringify(payload), json: payload };
      });
      await c1.chat([{ role: "user", content: "hi" }], "test-model", 500);
      t("正常 stop：lastResponseTruncated=false", c1.lastResponseTruncated === false);

      // 场景 2：首次 length → 自动扩预算 2× → 再次 length → 标记置位
      const c2 = new m.AiClient("https://r14.example/v1", "k", "test-model");
      const sizes2 = [];
      let call2 = 0;
      m.setRequestUrlMock(async (p) => {
        call2++;
        sizes2.push(JSON.parse(p.body).max_tokens);
        const payload = { choices: [{ message: { content: `部分输出${call2}` }, finish_reason: "length" }] };
        return { status: 200, text: JSON.stringify(payload), json: payload };
      });
      const out2 = await c2.chat([{ role: "user", content: "hi" }], "test-model", 500);
      t("扩预算链路生效（500→1000）", JSON.stringify(sizes2) === JSON.stringify([500, 1000]));
      t("扩预算后仍 length：lastResponseTruncated=true", c2.lastResponseTruncated === true && out2.includes("部分输出"));

      // 场景 3：钳制通道（400 max_tokens → 收敛到 1024）后仍 length → 标记同样置位
      const c3 = new m.AiClient("https://r14.example/v1", "k", "test-model");
      const sizes3 = [];
      let call3 = 0;
      m.setRequestUrlMock(async (p) => {
        call3++;
        sizes3.push(JSON.parse(p.body).max_tokens);
        if (call3 === 1) {
          return { status: 400, text: '{"error":{"message":"max_tokens must be in [1,1024]"}}' };
        }
        const payload = { choices: [{ message: { content: "钳制后输出" }, finish_reason: "length" }] };
        return { status: 200, text: JSON.stringify(payload), json: payload };
      });
      await c3.chat([{ role: "user", content: "hi" }], "test-model", 2000);
      t("钳制通道截断：lastResponseTruncated=true（钳制也算）", c3.lastResponseTruncated === true);
      t("钳制后请求按 1024 发出", sizes3[1] === 1024);

      // 场景 4：截断后再来一次正常调用 → 标记按次重置
      m.setRequestUrlMock(async () => {
        const payload = { choices: [{ message: { content: "这次完整" }, finish_reason: "stop" }] };
        return { status: 200, text: JSON.stringify(payload), json: payload };
      });
      await c2.chat([{ role: "user", content: "hi" }], "test-model", 500);
      t("标记按次重置：上次截断不泄漏到下次调用", c2.lastResponseTruncated === false);
      noNet();
    }

    console.log("— 端到端：视频通道截断 → msg 并入截断信息 + errorMessage 落台账（第十四轮）—");
    {
      const vault = makeTinyVault(m.TFile);
      // 5000 码点转录：超过 4000 上限，触发首 3000 + 尾 1000 切分
      const transcript = "HEAD_A" + "甲".repeat(4988) + "TAIL_Z";
      const notePath = "抖音/收藏/夹/R14 [r1400001].md";
      const file = await vault.create(notePath, "---\ntype: 视频\n---\n\n正文");
      const settings = {
        ...m.DEFAULT_SETTINGS,
        videoSummaryEnabled: true,
        videoSummaryBaseUrl: "https://r14.example/v1",
        videoSummaryApiKey: "k-r14",
        keyframeIntervalSec: 10,
      };
      const prompts = [];
      const sizesSeen = [];
      let call = 0;
      m.setRequestUrlMock(async (p) => {
        if (!/\/chat\/completions$/.test(p.url)) throw new Error("意外端点 " + p.url);
        call++;
        const body = JSON.parse(p.body);
        sizesSeen.push(body.max_tokens);
        prompts.push(body.messages[0].content.find((c) => c.type === "text").text);
        const payload = { choices: [{ message: { content: "主题:测试主题\n\n## AI 总结\n测试摘要。" }, finish_reason: "length" }] };
        return { status: 200, text: JSON.stringify(payload), json: payload };
      });
      const r = await m.generateAndWriteVideoSummary({ vault }, file, settings, {
        title: "测试视频",
        transcript,
        framePaths: [],
      });
      noNet();
      t("截断下摘要仍成功落盘（status=success，不触发失败重试链）", r.ok === true && r.record?.status === "success");
      t("msg 并入截断信息", r.msg.includes("输出被截断"));
      t("record.errorMessage 写入截断提示", r.record?.errorMessage === m.OUTPUT_TRUNCATED_HINT);
      t("扩预算链路仍在（2000→4000）", JSON.stringify(sizesSeen) === JSON.stringify([2000, 4000]));
      t("提示词含截断明示句", prompts[0].includes("中段已省略") && prompts[0].includes("严禁对未提供的中间内容做任何编造"));
      t("首尾保留生效：转录开头与结尾都在提示词里", prompts[0].includes("HEAD_A") && prompts[0].includes("TAIL_Z"));
      t("首尾保留生效：中段（甲×4988）未整体进入提示词", !prompts[0].includes("甲".repeat(4988)));
      t("摘要折叠块写入笔记", vault.files.get(notePath).includes("测试摘要"));
    }

    console.log("— 端到端：图文通道截断 → errorMessage + 明示句进 prompt（第十四轮）—");
    {
      const vault = makeTinyVault(m.TFile);
      // 8994 码点逐字稿：超过 8000 上限；「中段哨兵」落在被省略的中段窗口 [6000, 6994)
      const transcriptLine = "> HEAD_A" + "乙".repeat(6494) + "中段哨兵" + "乙".repeat(2484) + "TAIL_Z";
      const notePath = "抖音/收藏/夹/图文R14 [r1400002].md";
      const file = await vault.create(
        notePath,
        ["---", 'title: "图文R14"', "---", "", "> [!quote]- 逐字稿（test）", transcriptLine, ""].join("\n"),
      );
      const settings = {
        ...m.DEFAULT_SETTINGS,
        summaryEnabled: true,
        aiBaseUrl: "https://r14.example/v1",
        aiKey: "k-r14",
        aiModel: "test-model",
      };
      const prompts = [];
      m.setRequestUrlMock(async (p) => {
        if (!/\/chat\/completions$/.test(p.url)) throw new Error("意外端点 " + p.url);
        const body = JSON.parse(p.body);
        prompts.push(body.messages[0].content);
        const payload = { choices: [{ message: { content: "- 要点一\n- 要点二" }, finish_reason: "length" }] };
        return { status: 200, text: JSON.stringify(payload), json: payload };
      });
      const r = await m.generateSummaryForFile({ vault }, file, settings);
      noNet();
      t("截断下摘要仍成功（status=success）", r.ok === true && r.record?.status === "success");
      t("record.errorMessage 写入截断提示", r.record?.errorMessage === m.OUTPUT_TRUNCATED_HINT);
      t("prompt 含截断明示句", prompts[0].includes("中段已省略") && prompts[0].includes("严禁对未提供的中间内容做任何编造"));
      t("首尾保留生效：开头与结尾都在 prompt 里", prompts[0].includes("HEAD_A") && prompts[0].includes("TAIL_Z"));
      t("首尾保留生效：中段哨兵被省略", !prompts[0].includes("中段哨兵"));
      t("摘要折叠块写入笔记", vault.files.get(notePath).includes("- 要点一"));

      // 对侧：不截断的正常调用 → 不写 errorMessage（扩预算会产生两次请求，先清空再收当前条）
      const notePath2 = "抖音/收藏/夹/图文R14 [r1400003].md";
      const file2 = await vault.create(
        notePath2,
        ["---", 'title: "图文R14b"', "---", "", "> [!quote]- 逐字稿（test）", "> 短转录内容", ""].join("\n"),
      );
      prompts.length = 0;
      m.setRequestUrlMock(async (p) => {
        if (!/\/chat\/completions$/.test(p.url)) throw new Error("意外端点 " + p.url);
        prompts.push(JSON.parse(p.body).messages[0].content);
        const payload = { choices: [{ message: { content: "- 要点甲\n- 要点乙" }, finish_reason: "stop" }] };
        return { status: 200, text: JSON.stringify(payload), json: payload };
      });
      const r2 = await m.generateSummaryForFile({ vault }, file2, settings);
      noNet();
      t("正常 stop：errorMessage 不写、msg 不变", r2.ok === true && r2.record?.errorMessage === undefined && r2.msg === "摘要已生成");
      t("未截断的 prompt 不含明示句", prompts.length === 1 && !prompts[0].includes("中段省略"));
    }
  };

  console.log(`小计：${pass} 通过，${fail} 失败`);
  if (fail > 0) throw new Error(`round14-summary-quality: ${fail} 个断言失败`);
  return { get pass() { return pass; }, get fail() { return fail; }, async: asyncChecks };
}
