// itemType + stripFrameMarkers 纯函数单元测试（2026-09 视频/图片分类优化）。
import assert from "node:assert/strict";

export function runTests(m) {
  const { classifyItemType, IMAGE_AWEME_TYPES, stripFrameMarkers, upsertAbstractBlock } = m;
  let pass = 0, fail = 0;
  const t = (name, fn) => {
    try { fn(); pass++; console.log("  ✓ " + name); }
    catch (e) { fail++; console.log("  ✗ " + name + "\n      " + (e?.message ?? e)); }
  };

  console.log("— 收藏类型明确区分（视频 / 图片）—");
  t("无任何信号 → 视频", () => {
    assert.equal(classifyItemType({ hasImages: false }), "video");
  });
  t("有图 → 图文（原有启发式回退保留）", () => {
    assert.equal(classifyItemType({ hasImages: true }), "note");
  });
  t("aweme_type=0（视频）且无图 → 视频", () => {
    assert.equal(classifyItemType({ hasImages: false, awemeType: 0 }), "video");
  });
  t("aweme_type=2/68/71（图文类型码）→ 图文", () => {
    for (const code of [2, 68, 71]) {
      assert.equal(classifyItemType({ hasImages: false, awemeType: code }), "note", `aweme_type=${code} 应为图文`);
    }
    assert.deepEqual([...IMAGE_AWEME_TYPES].sort(), [2, 68, 71]);
  });
  t("is_note=true 显式标志 → 图文（优先级最高）", () => {
    assert.equal(classifyItemType({ hasImages: false, isNote: true }), "note");
  });
  t("aweme_type=0 但解析出图片 → 保守判图文（不破坏存量行为）", () => {
    assert.equal(classifyItemType({ hasImages: true, awemeType: 0 }), "note");
  });

  console.log("— 摘要纯文本清理（摘要不嵌照片）—");
  t("剔除模型偶发生成的【配图N】标记", () => {
    const out = stripFrameMarkers("🎯 1. 选题环节【配图2】\n- 要点甲【配图 10】\n- 要点乙");
    assert.equal(out, "🎯 1. 选题环节\n- 要点甲\n- 要点乙");
  });
  t("无标记的结构化摘要原样保留", () => {
    const src = "简介：测试\n\n🎯 1. 环节甲\n- **加粗要点**\n\n🌟 小总结\n- 收尾";
    assert.equal(stripFrameMarkers(src), src);
  });
  t("标记剔除后不留尾随空格", () => {
    assert.equal(stripFrameMarkers("- 要点 【配图1】 "), "- 要点");
  });
  t("写入摘要折叠块后逐字保留（含 emoji 分节行）", () => {
    const note = "---\ntitle: \"x\"\n---\n\n正文";
    const out = upsertAbstractBlock(note, "简介：测试\n\n🎯 1. 环节\n- 要点");
    assert.ok(out.includes("> 🎯 1. 环节"), "分节行丢失：\n" + out);
    assert.ok(out.includes("> - 要点"), "要点行丢失");
  });

  return { get pass() { return pass; }, get fail() { return fail; } };
}
