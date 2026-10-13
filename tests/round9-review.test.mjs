// 第九轮复审批测试（2026-09-27，独立复核会话）：
// 本套件只覆盖复审批新增的加固项——loadState 对 transcriptCache 的条目级形状消毒（复审批 1）。
// 复审批 2（桥接启动超时文案报实际等待时长）在 main.ts，不在测试 bundle 内，不设用例。
// 背景纪律：asrRetry 自第六轮起有条目级消毒；transcriptCache（第九轮 B3 新增）原实现只验
// 顶层 isPlainObject，手改 data.json 的条目级脏值会穿过 peekStashedTranscript 流进笔记渲染。
import assert from "node:assert/strict";

function makeEngine(m, settingsOver = {}) {
  const settings = {
    ...m.DEFAULT_SETTINGS,
    rootFolder: "抖音",
    ...settingsOver,
  };
  return new m.SyncEngine({ vault: {} }, settings, async () => {}, () => {});
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

  const asyncChecks = async () => {
    console.log("— loadState：transcriptCache 条目形状消毒（第九轮复审批 1）—");
    {
      const engine = makeEngine(m);
      engine.loadState({
        processed: {},
        transcriptCache: {
          ok1: { transcript: "正常转录文本", provider: "siliconflow_sensevoice", at: "2026-09-27T01:00:00.000Z" },
          dirty_number: { transcript: 12345, provider: "x", at: "2026-09-27T01:00:00.000Z" },
          dirty_empty: { transcript: "", provider: "x", at: "2026-09-27T01:00:00.000Z" },
          dirty_null_transcript: { transcript: null, provider: "x", at: "2026-09-27T01:00:00.000Z" },
          dirty_null_entry: null,
          dirty_garbage: "整体是字符串的条目",
          dirty_bad_at: { transcript: "有效文本", provider: 42, at: "不是时间" },
        },
      });
      const c = engine.state.transcriptCache ?? {};
      t("有效条目原样保留", c.ok1?.transcript === "正常转录文本" && c.ok1?.provider === "siliconflow_sensevoice");
      t("transcript 非字符串的条目被丢弃", !("dirty_number" in c));
      t("transcript 空串的条目被丢弃", !("dirty_empty" in c));
      t("transcript 为 null 的条目被丢弃", !("dirty_null_transcript" in c));
      t("条目整体为 null 被丢弃", !("dirty_null_entry" in c));
      t("条目整体为字符串被丢弃", !("dirty_garbage" in c));
      t("provider 非字符串归一为空串", c.dirty_bad_at?.provider === "");
      t("at 不可解析归一为 epoch（FIFO 排序仍可确定）", c.dirty_bad_at?.at === "1970-01-01T00:00:00.000Z");
      t("脏条目丢弃后有效条目不受影响（共 2 条存活）", Object.keys(c).length === 2);
    }
    {
      // 顶层整体错位仍回退空对象（与原行为一致，不因消毒引入新崩溃面）
      const engine = makeEngine(m);
      engine.loadState({ processed: {}, transcriptCache: "字符串" });
      t("顶层非对象 → 空对象", engine.state.transcriptCache && Object.keys(engine.state.transcriptCache).length === 0);
    }
    {
      // 未传 transcriptCache（旧版 data.json）→ 缺省空对象
      const engine = makeEngine(m);
      engine.loadState({ processed: {} });
      t("未传字段 → 缺省空对象", !!engine.state.transcriptCache && Object.keys(engine.state.transcriptCache).length === 0);
    }
  };

  return { get pass() { return pass; }, get fail() { return fail; }, async: asyncChecks };
}
