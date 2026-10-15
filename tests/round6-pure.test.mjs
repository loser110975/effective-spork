// 第六轮纯函数回归（2026-09-27 独立深审修复项）：写入/读取往返一致性、aiConfig 通道兜底、帧排序。
// 审计发现的同类根因「写入侧变换 ≠ 读取侧判据的逆」各修复项在此固化。
export function runTests(m) {
  const { DEFAULT_SETTINGS } = m;
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

  console.log("— appendOcrToNoteCallout：行首 > 文本幂等（normOcr 还原顺序修复）—");
  {
    const base = "---\ntype: 图文\n---\n\n正文保留";
    const text = "> 引用行\n普通行";
    const once = m.appendOcrToNoteCallout(base, text);
    const twice = m.appendOcrToNoteCallout(once, text);
    t("重复导出幂等（旧实现归一化顺序颠倒，恒失配 → 无限追加）", once === twice);
    t("首次导出确实写入且引用行转义", once.includes("引用行") && once.includes("＞ 引用行"));
    t("用户正文逐字保留", once.includes("正文保留"));
  }

  console.log("— 缩进 [! 内容行不再提前断块（转义补缩进变体）—");
  {
    const base = "---\ntype: 图文\n---\n\n正文";
    const text = "  [!NOTE] 缩进提示头\n后文A\n[!tip] 行首变体\n后文B";
    const out = m.appendOcrToNoteCallout(base, text);
    const ocr = m.extractSummarySources(out).ocrText;
    t("OCR 块全文可完整读回（旧实现在缩进 [! 处断块丢失后文）", ocr.includes("后文A") && ocr.includes("后文B"));
    t("缩进变体已被全角化（读取侧不再误判为嵌套 callout 头）", /[！]/.test(out) && !/>\s+\[!NOTE\]/.test(out));

    // 逐字稿侧（noteBuilder.callout 与 statusCore 同策略）：转录中的缩进 [! 行不截断后续内容
    const note = m.buildNote({
      item: {
        id: "7301234567890123456",
        type: "video",
        source: "collection",
        title: "测试标题",
        desc: "",
        author: "作者",
        authorId: "sec",
        createTime: 1758900000,
        playUrl: "https://www.douyin.com/video/x",
        coverUrl: "",
        imageUrls: [],
        durationSec: 23,
        awemeType: 0,
        mediaType: 0,
        stats: { likes: 1, comments: 0, collects: 0, shares: 0 },
      },
      folder: "学习",
      category: "未分类",
      coverPath: "",
      imagesDownloaded: [],
      visionTexts: [],
      asr: { status: "success", transcript: "行A\n  [!NOTE] 缩进头\n行C", provider: "test" },
      framePaths: [],
      keyframeIntervalSec: 0,
      syncedAt: "2026-09-27T00:00:00.000Z",
    });
    const transcript = m.extractSummarySources(note).transcript;
    t("逐字稿缩进 [! 后的内容不丢", transcript.includes("行A") && transcript.includes("行C"));
  }

  console.log("— applySummaryToNote：版本号不捏造 —");
  {
    const out1 = m.applySummaryToNote("---\ntype: 视频\n---\n正文", "摘要内容");
    t("无既有 summary_v 时不捏造版本号", !/^summary_v:/m.test(out1) && out1.includes("摘要内容"));
    const out2 = m.applySummaryToNote(out1, "新摘要");
    t("手动摘要二次写入仍无版本号", !/^summary_v:/m.test(out2) && out2.includes("新摘要"));
    const out3 = m.applySummaryToNote(out1.replace(/^type: 视频$/m, "type: 视频\nsummary_v: 2"), "更新摘要");
    t("既有版本号保留", /^summary_v: 2$/m.test(out3));
  }

  console.log("— aiConfig：通道独立化（2026-10-15 回退链移除）—");
  {
    const zhipu = "https://open.bigmodel.cn/api/paas/v4";
    const s1 = { ...DEFAULT_SETTINGS, aiBaseUrl: zhipu, aiKey: "", dashscopeKey: "sk-bailian" };
    t("AI 通道：aiKey 留空 → 报未配置（即使 dashscopeKey 有值也不再借用）", (m.resolveAiChannel(s1).problem || "").includes("API Key 未配置"));
    const s2 = { ...DEFAULT_SETTINGS, aiBaseUrl: "", aiKey: "", dashscopeKey: "sk-bailian" };
    t("AI 通道：基址落默认值，Key 留空仍报未配置", (m.resolveAiChannel(s2).problem || "").includes("API Key 未配置"));
    const s3 = { ...DEFAULT_SETTINGS, visionBaseUrl: "", visionApiKey: "", aiBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", aiKey: "k-ai", dashscopeKey: "sk-bailian" };
    t("视觉通道：独立基址/Key 全空 → 报未配置（不再回退 aiBaseUrl/aiKey）", m.resolveVisionChannel(s3).baseUrl === "" && (m.resolveVisionChannel(s3).problem || "").includes("未配置"));
    const s4 = { ...DEFAULT_SETTINGS, visionBaseUrl: zhipu, visionApiKey: "", aiKey: "k-zhipu", dashscopeKey: "sk-bailian" };
    t("视觉通道：独立基址已填、Key 留空 → 只报 Key 未配置（不借用 aiKey/dashscopeKey）", (m.resolveVisionChannel(s4).problem || "").includes("API Key 未配置"));
    const s5 = { ...DEFAULT_SETTINGS, videoSummaryBaseUrl: "", videoSummaryApiKey: "", aiKey: "k-ai", dashscopeKey: "sk-bailian" };
    t("多模态通道：专用基址/Key 全空 → 报未配置（不再回退 AI 通道）", (m.resolveVideoSummaryChannel(s5).problem || "").includes("未配置"));
    const s6 = { ...DEFAULT_SETTINGS, ocrBaseUrl: zhipu, ocrApiKey: "", aiKey: "k-ai", dashscopeKey: "sk-bailian" };
    t("OCR 面板主通道：Key 留空 → 报未配置（不再回退 aiKey/dashscopeKey）", (m.resolveOcrPanelChannel(s6).problem || "").includes("API Key 未配置"));
  }

  console.log("— sortFramePaths：帧序号数值排序（≥100 帧末帧不再乱序）—");
  {
    const paths = ["抖音/Media/frames/x/frame_01.jpg", "抖音/Media/frames/x/frame_100.jpg", "抖音/Media/frames/x/frame_2.jpg", "抖音/Media/frames/x/frame_11.jpg"];
    const sorted = m.sortFramePaths(paths);
    t("frame_100 排在最后而非 frame_1 与 frame_2 之间", sorted[3].endsWith("frame_100.jpg") && sorted[1].endsWith("frame_2.jpg") && sorted[2].endsWith("frame_11.jpg"));
    t("入命数组不被原地修改", paths[0].endsWith("frame_01.jpg"));
  }

  return { get pass() { return pass; }, get fail() { return fail; }, async: async () => {} };
}
