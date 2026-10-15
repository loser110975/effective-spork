// QA 独立回归验证（第十四轮摘要质量修复）——由 QA 工程师独立编写，不复用工程师用例的构造。
// 目的：以全新视角证明行为正确，边界用例自行设计：
// ① headTailSlice 真实 4000/4001 码点边界 + emoji 恰在切分点（头段末位 / 尾段首位两个方向）+ tail=0
// ② buildPrompt 截断明示句的出现/缺席三态 + 截断文本不被二次截断
// ③ summaryMaxTokens 迁移：500→2000、499/300/2500 不动、"500" 字符串先 coerce 再迁移、两次调用幂等
// ④ ai.lastResponseTruncated：stop/length-扩尽/钳制通道/连续调用不串 + chatVision 继承
// ⑤ 端到端：视频通道转录 >4000 字 → 首尾哨兵进 prompt、中段哨兵缺席、errorMessage 落 record、status=success
import assert from "node:assert/strict";

export function runTests(m) {
  let pass = 0,
    fail = 0;
  const t = (name, ok, extra = "") => {
    if (ok) {
      pass++;
      console.log("  ✓ " + name);
    } else {
      fail++;
      console.log("  ✗ " + name + (extra ? " | " + extra : ""));
    }
  };

  const noNet = () =>
    m.setRequestUrlMock(async () => {
      throw new Error("requestUrl 不应在单测中被调用");
    });

  console.log("— [QA独立] headTailSlice：真实 4000 码点边界 —");
  {
    const { headTailSlice, HEAD_TAIL_OMITTED_MARK } = m;

    // 恰好 4000 码点（= 3000 + 1000）：不截断
    const exact4000 = "a".repeat(3000) + "b".repeat(1000);
    const r1 = headTailSlice(exact4000, 3000, 1000);
    t("恰好 4000 码点：truncated=false 且原文原样", r1.truncated === false && r1.text === exact4000);

    // 4001 码点：截断，头 3000 + 尾 1000
    const over = "H".repeat(3000) + "M".repeat(1) + "T".repeat(1000); // 4001
    const r2 = headTailSlice(over, 3000, 1000);
    t("4001 码点：truncated=true", r2.truncated === true);
    t("4001 码点：头段 = 前 3000 码点", r2.text.startsWith("H".repeat(3000)));
    t("4001 码点：尾段 = 后 1000 码点", r2.text.endsWith("T".repeat(1000)));
    t("4001 码点：中段省略标记存在且唯一", (r2.text.match(/中段已省略/g) ?? []).length === 1);
    t(
      "4001 码点：输出总码点数 = 3000 + 1000 + 标记",
      Array.from(r2.text).length === 4000 + Array.from(HEAD_TAIL_OMITTED_MARK).length,
    );

    // emoji 恰在头段末位（码点 2999）：不得劈成孤代理
    const headEdge = "a".repeat(2999) + "🌟" + "c".repeat(1001); // 4001 码点
    const r3 = headTailSlice(headEdge, 3000, 1000);
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    t("emoji 在头段末位：完整保留在头段结尾", r3.truncated === true && r3.text.startsWith("a".repeat(2999) + "🌟"));
    t("emoji 在头段末位：输出无孤代理", !lone.test(r3.text));

    // emoji 恰在尾段首位（倒数第 1000 个码点，即索引 N-1000）：不得劈成孤代理
    const tailEdge = "a".repeat(3001) + "🌙" + "d".repeat(999); // 4001 码点，尾段 = 🌙 + d×999
    const r4 = headTailSlice(tailEdge, 3000, 1000);
    t("emoji 在尾段首位：完整保留在尾段开头", r4.truncated === true && r4.text.endsWith("🌙" + "d".repeat(999)));
    t("emoji 在尾段首位：输出无孤代理", !lone.test(r4.text));

    // tailChars=0 且超长：只留头、尾部为空（防 slice(-0) 全文回拼回归）
    const r5 = headTailSlice("x".repeat(5001), 4000, 0);
    t("tail=0 且超长：尾部为空、仍截断", r5.truncated === true && r5.text === "x".repeat(4000) + HEAD_TAIL_OMITTED_MARK);

    // 超契约输入安全（TS 签名为 string；null/undefined 不抛错、按「原样返回」语义 truncated=false）
    const rn = headTailSlice(null, 10, 5);
    const ru = headTailSlice(undefined, 10, 5);
    t("null/undefined 输入不抛错且 truncated=false", rn.truncated === false && ru.truncated === false && rn.text === null && ru.text === undefined);
  }

  console.log("— [QA独立] buildPrompt：截断明示三态 —");
  {
    const base = { title: "标题", transcript: "这是转录正文", frameCount: 3, intervalSec: 10 };
    const p1 = m.buildPrompt({ ...base, transcriptTruncated: true });
    t("truncated=true + 非空转录：明示句出现", p1.includes(m.SOURCE_TRUNCATION_NOTICE));
    t("明示句在转录文本之后（拼在同一段内）", p1.indexOf("这是转录正文") < p1.indexOf("中段省略"));

    const p2 = m.buildPrompt({ ...base, transcriptTruncated: false });
    t("truncated=false：明示句不出现", !p2.includes("中段省略") && !p2.includes("严禁对未提供的中间内容"));

    const p3 = m.buildPrompt({ ...base });
    t("参数缺省：明示句不出现", !p3.includes("中段省略"));

    const p4 = m.buildPrompt({ ...base, transcript: "   ", transcriptTruncated: true });
    t("空转录（纯画面路径）：明示句不出现", p4.includes("空或无效") && !p4.includes("中段省略"));

    // 截断文本整体进 prompt，不被二次截断（含省略标记的转录必须完整保留）
    const sliced = m.headTailSlice("y".repeat(5000), 3000, 1000);
    const p5 = m.buildPrompt({ ...base, transcript: sliced.text, transcriptTruncated: true });
    t("已切分的转录整体进 prompt（含中段省略标记）", p5.includes(m.HEAD_TAIL_OMITTED_MARK));
  }

  console.log("— [QA独立] 迁移：summaryMaxTokens 500→2000 —");
  {
    const mk = (v) => m.sanitizeNumericSettings({ ...m.DEFAULT_SETTINGS, summaryMaxTokens: v });
    t("500 → 2000", mk(500).summaryMaxTokens === 2000);
    t("499 不动", mk(499).summaryMaxTokens === 499);
    t("300 不动", mk(300).summaryMaxTokens === 300);
    t("2500 不动", mk(2500).summaryMaxTokens === 2500);
    t("字符串 \"500\" 先 coerce 再迁移 → 2000", mk("500").summaryMaxTokens === 2000);
    t("字符串 \"500\" 迁移后为 number 类型", typeof mk("500").summaryMaxTokens === "number");

    const twice = mk(500);
    m.sanitizeNumericSettings(twice);
    t("连续两次调用幂等（仍 2000）", twice.summaryMaxTokens === 2000);

    const twiceOther = mk(800);
    m.sanitizeNumericSettings(twiceOther);
    t("非 500 合法值两次调用幂等（仍 800）", twiceOther.summaryMaxTokens === 800);

    t("非法值（\"abc\"）走 fallback 2000", mk("abc").summaryMaxTokens === 2000);
    t("DEFAULT_SETTINGS 默认 = 2000", m.DEFAULT_SETTINGS.summaryMaxTokens === 2000);
    t("NUMERIC_RULES fallback 与默认同步（fallbackMatchesDefaults）", m.fallbackMatchesDefaults() === true);
  }

  const asyncChecks = async () => {
    console.log("— [QA独立] ai.lastResponseTruncated：四种场景 —");
    {
      // 场景 A：stop → false
      const cA = new m.AiClient("https://qa.example/v1", "k", "qa-model");
      m.setRequestUrlMock(async () => {
        const payload = { choices: [{ message: { content: "完整" }, finish_reason: "stop" }] };
        return { status: 200, text: JSON.stringify(payload), json: payload };
      });
      await cA.chat([{ role: "user", content: "hi" }], "qa-model", 1000);
      t("stop：flag=false", cA.lastResponseTruncated === false);

      // 场景 B：2000 → 扩到 4000 → 仍 length → true（边界：扩到上限 4000 后不再扩）
      const cB = new m.AiClient("https://qa.example/v1", "k", "qa-model");
      const sizesB = [];
      let callsB = 0;
      m.setRequestUrlMock(async (p) => {
        callsB++;
        sizesB.push(JSON.parse(p.body).max_tokens);
        const payload = { choices: [{ message: { content: "截断输出" + callsB }, finish_reason: "length" }] };
        return { status: 200, text: JSON.stringify(payload), json: payload };
      });
      const outB = await cB.chat([{ role: "user", content: "hi" }], "qa-model", 2000);
      t("扩预算链路 2000→4000（一次扩到上限）", JSON.stringify(sizesB) === JSON.stringify([2000, 4000]));
      t("扩预算后仍 length：flag=true", cB.lastResponseTruncated === true && outB === "截断输出2");

      // 场景 C：钳制通道（400/max_tokens → 收敛 1024）后仍 length → true，且不触发扩预算
      const cC = new m.AiClient("https://qa.example/v1", "k", "qa-model");
      const sizesC = [];
      let callsC = 0;
      m.setRequestUrlMock(async (p) => {
        callsC++;
        sizesC.push(JSON.parse(p.body).max_tokens);
        if (callsC === 1) return { status: 400, text: '{"error":{"message":"max_tokens must be in [1,1024]"}}' };
        const payload = { choices: [{ message: { content: "钳制输出" }, finish_reason: "length" }] };
        return { status: 200, text: JSON.stringify(payload), json: payload };
      });
      await cC.chat([{ role: "user", content: "hi" }], "qa-model", 2000);
      t("钳制通道：恰好 2 次请求（不扩预算）", callsC === 2 && JSON.stringify(sizesC) === JSON.stringify([2000, 1024]));
      t("钳制通道截断：flag=true", cC.lastResponseTruncated === true);

      // 场景 D：连续两次调用 flag 不串
      m.setRequestUrlMock(async () => {
        const payload = { choices: [{ message: { content: "这次完整" }, finish_reason: "stop" }] };
        return { status: 200, text: JSON.stringify(payload), json: payload };
      });
      await cB.chat([{ role: "user", content: "hi" }], "qa-model", 2000);
      t("截断后接一次 stop：flag 重置为 false（不泄漏）", cB.lastResponseTruncated === false);

      // 场景 E：chatVision 复用 chat → flag 继承
      const cE = new m.AiClient("https://qa.example/v1", "k", "qa-model", "qa-vision");
      m.setRequestUrlMock(async () => {
        const payload = { choices: [{ message: { content: "视觉输出" }, finish_reason: "length" }] };
        return { status: 200, text: JSON.stringify(payload), json: payload };
      });
      await cE.chatVision("看图", [], "qa-vision", 1200);
      t("chatVision 继承截断标记", cE.lastResponseTruncated === true);
      noNet();
    }

    console.log("— [QA独立] 端到端：视频通道转录 >4000 字 —");
    {
      const files = new Map();
      const vault = {
        files: files,
        async create(p, content) {
          files.set(p, content);
          const f = new m.TFile();
          f.path = p;
          f.name = p.slice(p.lastIndexOf("/") + 1);
          f.basename = f.name.replace(/\.md$/, "");
          return f;
        },
        async read(file) {
          const c = files.get(file.path);
          if (c === undefined) throw new Error("read: 不存在 " + file.path);
          return c;
        },
        async process(file, fn) {
          const next = await fn(files.get(file.path));
          files.set(file.path, next);
          return next;
        },
      };

      // 5002 码点转录：首哨兵在头 3000 内，中段哨兵在省略区 [3000, 4002)，尾哨兵在末 1000 内
      const headPart = "开头哨兵" + "甲".repeat(2996); // 3000 码点（4 + 2996）
      const midPart = "中段哨兵" + "乙".repeat(999); // 1002 码点（全部落在省略区）
      const tailPart = "丙".repeat(999) + "结尾哨兵"; // 1000 码点
      const transcript2 = headPart + midPart + tailPart; // 5002 码点
      assert.ok(Array.from(transcript2).length > 4000, "构造的转录必须超过 4000");
      assert.ok(
        transcript2.indexOf("中段哨兵") >= 3000 && transcript2.indexOf("中段哨兵") < 4002,
        "中段哨兵必须落在省略区",
      );

      const notePath = "抖音/收藏/QA [qa1400001].md";
      const file = await vault.create(notePath, "---\ntype: 视频\n---\n\n正文");
      const settings = {
        ...m.DEFAULT_SETTINGS,
        videoSummaryBaseUrl: "https://qa.example/v1",
        videoSummaryApiKey: "k-qa",
        keyframeIntervalSec: 10,
      };
      const prompts = [];
      const sizes = [];
      m.setRequestUrlMock(async (p) => {
        if (!/\/chat\/completions$/.test(p.url)) throw new Error("意外端点 " + p.url);
        const body = JSON.parse(p.body);
        sizes.push(body.max_tokens);
        prompts.push(body.messages[0].content.find((c) => c.type === "text").text);
        const payload = {
          choices: [{ message: { content: "主题:QA 主题\n\n## AI 总结\nQA 测试摘要。" }, finish_reason: "length" }],
        };
        return { status: 200, text: JSON.stringify(payload), json: payload };
      });
      const r = await m.generateAndWriteVideoSummary({ vault }, file, settings, {
        title: "QA 测试视频",
        transcript: transcript2,
        framePaths: [],
      });
      noNet();

      t("status=success（截断不转失败）", r.ok === true && r.record?.status === "success");
      t("record.errorMessage === OUTPUT_TRUNCATED_HINT", r.record?.errorMessage === m.OUTPUT_TRUNCATED_HINT);
      t("msg 并入截断信息", r.msg.includes("输出被截断"));
      t("prompt 含开头哨兵（首 3000 保留）", prompts[0].includes("开头哨兵"));
      t("prompt 含结尾哨兵（尾 1000 保留）", prompts[0].includes("结尾哨兵"));
      t("prompt 不含中段哨兵（中段省略）", !prompts[0].includes("中段哨兵"));
      t("prompt 含截断明示句", prompts[0].includes(m.SOURCE_TRUNCATION_NOTICE));
      t("max_tokens 扩预算链路（默认 2000→4000）", JSON.stringify(sizes) === JSON.stringify([2000, 4000]));
      t("摘要折叠块写入笔记", files.get(notePath).includes("QA 测试摘要"));
      t("record.kind=video_multimodal", r.record?.kind === "video_multimodal");
    }
  };

  console.log(`小计：${pass} 通过，${fail} 失败`);
  if (fail > 0) throw new Error(`zz-qa-round14-verify: ${fail} 个断言失败`);
  return { get pass() { return pass; }, get fail() { return fail; }, async: asyncChecks };
}
