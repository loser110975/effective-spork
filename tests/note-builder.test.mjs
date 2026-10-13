// noteBuilder.buildNote 单元测试（2026-09-27 新增）：frontmatter 结构 / callout 转义 / 分段码点安全。
import assert from "node:assert/strict";

const mkItem = (over = {}) => ({
  id: "7301234567890123456",
  type: "video",
  source: "collection",
  title: "测试标题",
  desc: "测试文案",
  author: "作者",
  authorId: "sec",
  createTime: 1758900000,
  playUrl: "https://www.douyin.com/video/x",
  coverUrl: "https://img.example/cover.jpg",
  imageUrls: [],
  durationSec: 23,
  awemeType: 0,
  mediaType: 0,
  stats: { likes: 12, comments: 3, collects: 4, shares: 5 },
  ...over,
});

export function runTests(m) {
  const { buildNote } = m;
  let pass = 0, fail = 0;
  const t = (name, ok) => {
    if (ok) { pass++; console.log("  ✓ " + name); }
    else { fail++; console.log("  ✗ " + name); }
  };
  const input = (over = {}) => ({
    item: mkItem(),
    folder: "学习",
    category: "成长学习",
    coverPath: "抖音/Media/cover/7301234567890123456.jpg",
    imagesDownloaded: [],
    visionTexts: [],
    asr: null,
    framePaths: [],
    keyframeIntervalSec: 10,
    syncedAt: "2026-09-27T00:00:00.000Z",
    ...over,
  });

  console.log("— buildNote frontmatter 结构 —");
  const n1 = buildNote(input());
  t("douyin_id / type / category 就位", n1.includes('douyin_id: "7301234567890123456"') && n1.includes('type: "视频"') && n1.includes('category: "成长学习"'));
  t("顶层 likes 与嵌套 stats 同时存在（Bases 排序依赖 note.likes）", n1.includes("likes: 12") && n1.includes("  likes: 12"));
  t("视频笔记写 frame_interval", /^frame_interval: 10$/m.test(n1));
  t("未转写视频给出 not_requested（无引号字面量）", /^transcript_status: not_requested$/m.test(n1));

  console.log("— buildNote 逐字稿渲染 —");
  const segs = [{ text: "第一句", beginSec: 0, endSec: 2 }, { text: "第二句", beginSec: 65, endSec: 70 }];
  const n2 = buildNote(input({ asr: { status: "success", transcript: "第一句第二句", provider: "paraformer-v2", segments: segs } }));
  t("带 segments 时渲染 mmss 时间戳", n2.includes("`00:00` 第一句") && n2.includes("`01:05` 第二句"));
  t("逐字稿头带引擎名", n2.includes("> [!quote]- 逐字稿（paraformer-v2）"));

  const long = "😀".repeat(1000) + "结尾";
  const n3 = buildNote(input({ asr: { status: "success", transcript: long, provider: "sensevoice" } }));
  const quoteLines = n3.split("\n").filter((l) => l.startsWith("> ") && !l.includes("[!"));
  const loneSurrogate = quoteLines.some((l) => /[\uD800-\uDBFF]$/.test(l.replace(/^>\s?/, "")));
  t("1000 个 emoji 分段不劈开代理对（码点切片）", !loneSurrogate);
  t("分段每段不超过 800 码点", quoteLines.every((l) => Array.from(l.replace(/^>\s?/, "")).length <= 800));

  const n4 = buildNote(input({ asr: { status: "success", transcript: "正常行\n> 行首引用行", provider: "x" } }));
  t("转录中的行首 `>` 转成全角 ＞", n4.includes("> ＞ 行首引用行") && !n4.includes("> > 行首引用行"));

  console.log("— buildNote 转写状态分支 —");
  const n5 = buildNote(input({ asr: { status: "unavailable", transcript: "", provider: "none", error: "无对白" } }));
  t("unavailable 渲染「未转写」信息块", n5.includes("> [!info]- 逐字稿") && n5.includes("未转写：无对白"));
  const n6 = buildNote(input({ asr: { status: "failed", transcript: "", provider: "x", error: "网络错误" } }));
  t("failed 渲染 warning 块并提示重试", n6.includes("> [!warning]- 逐字稿") && n6.includes("转写未成功：网络错误") && n6.includes("重试失败转写"));

  console.log("— buildNote 关键帧与图片 —");
  const n7 = buildNote(input({ framePaths: ["抖音/Media/frames/7301234567890123456/frame_01.jpg", "抖音/Media/frames/7301234567890123456/frame_02.jpg"] }));
  t("关键帧折叠块嵌入全部帧", n7.includes("> [!note]- 关键帧（2 张）") && n7.includes("> ![[抖音/Media/frames/7301234567890123456/frame_01.jpg]]"));
  const n8 = buildNote(input({
    item: mkItem({ type: "note", imageUrls: ["https://img.example/1.jpg", "https://img.example/2.jpg"], durationSec: 0, awemeType: 68 }),
    imagesDownloaded: ["抖音/Media/images/7301234567890123456/1.jpg", "抖音/Media/images/7301234567890123456/2.jpg"],
    visionTexts: [{ index: 1, text: "图中文字", status: "识别成功" }, { index: 2, text: "", status: "未识别" }],
    keyframeIntervalSec: 0,
  }));
  t("图文笔记嵌入图片与逐图 OCR 分段", n8.includes("![[抖音/Media/images/7301234567890123456/1.jpg]]") && n8.includes("**图 1**（识别成功）") && n8.includes("**图 2**（未识别）"));
  t("图文不写 frame_interval", !/^frame_interval:/m.test(n8));

  console.log("— DouyinClient.normalize 归一化 —");
  const { DouyinClient } = m;
  const raw = {
    aweme_id: "7301234567890123456",
    desc: "标题行\n第二行",
    create_time: 1758900000,
    author: { nickname: "作者", sec_uid: "sec" },
    video: {
      duration: 23000,
      play_addr: { url_list: ["https://www.douyin.com/aweme/v1/play/?u=abc"] },
      cover: { url_list: ["https://img.example/cover1", "https://img.example/cover2"] },
    },
    statistics: { digg_count: "12", comment_count: 3, collect_count: 4, share_count: 5 },
    aweme_type: 0,
  };
  const it1 = DouyinClient.normalize(raw, "collection");
  t("标题取文案首行", it1.title === "标题行");
  t("时长毫秒转秒", it1.durationSec === 23);
  t("封面取 url_list 首个（设计行为：图才取末个）", it1.coverUrl === "https://img.example/cover1");
  t("统计字段字符串也转数字", it1.stats.likes === 12 && it1.stats.comments === 3);
  const it2 = DouyinClient.normalize({
    aweme_id: "7301234567890123456",
    video: { play_addr: { url_list: ["https://www.douyin.com/aweme/v1/playwm/?u=abc"] } },
    aweme_type: 0,
  }, "collection");
  t("播放地址 playwm → play 去水印", it2.playUrl.includes("/play/?"));
  t("无图无显式类型 → 视频", it2.type === "video");

  const it3 = DouyinClient.normalize({
    aweme_id: "7301234567890123456",
    images: [{ url_list: ["a", "b", "c"] }, { url_list: ["d"] }],
    aweme_type: 68,
  }, "collection");
  t("图文类型码显式判定", it3.type === "note");
  t("图片取每档 url_list 最后一个", it3.imageUrls[0] === "c" && it3.imageUrls[1] === "d");

  const it4 = DouyinClient.normalize({ aweme_id: "abc123", aweme_type: 0 }, "collection");
  const it5 = DouyinClient.normalize({ aweme_id: "123", aweme_type: 0 }, "collection");
  t("非法/过短 aweme_id 返回 null（过滤广告位）", it4 === null && it5 === null);

  const it6 = DouyinClient.normalize({ aweme_id: "7301234567890123456", is_note: true, aweme_type: 0 }, "collection");
  t("is_note=true 显式判图文", it6.type === "note");

  assert.ok(true);
  return { get pass() { return pass; }, get fail() { return fail; } };
}
