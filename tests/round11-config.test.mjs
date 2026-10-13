// 第十一轮测试（2026-09-27）：配置数据完整性。
// ① sanitizeNumericSettings——data.json 手改 / 外部写入的非法数值消毒（危害链：
//    maxTranscribePerSync=NaN → asrBudgetLeft=NaN → 转写预算静默失效 + slice(0,NaN) 清空重试队列）；
// ② needsBackupRescue——「state 完整但 settings 丢失」的半损坏形态也要触发 .bak 抢救（原条件漏掉）；
// ③ formatRss——面板 /ping 行的内存展示（第十轮声明「管理面板可直接观察」的落地件）。
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

  const asyncChecks = async () => {
    console.log("— sanitizeNumericSettings：非法数值消毒（第十一轮）—");
    {
      const s = m.sanitizeNumericSettings({ ...m.DEFAULT_SETTINGS, maxTranscribePerSync: NaN });
      t("maxTranscribePerSync=NaN → 回默认 20（转写预算不再被 NaN 静默解除）", s.maxTranscribePerSync === 20);
    }
    {
      const s = m.sanitizeNumericSettings({ ...m.DEFAULT_SETTINGS, maxTranscribePerSync: "abc" });
      t("maxTranscribePerSync=非数字字符串 → 回默认 20", s.maxTranscribePerSync === 20);
    }
    {
      const s = m.sanitizeNumericSettings({ ...m.DEFAULT_SETTINGS, maxTranscribePerSync: "30" });
      t("数字字符串 '30' 宽容解析为 30", s.maxTranscribePerSync === 30);
    }
    {
      const s = m.sanitizeNumericSettings({ ...m.DEFAULT_SETTINGS, syncConcurrency: 99 });
      t("syncConcurrency=99 钳到上限 6（与设置页 onChange 同口径）", s.syncConcurrency === 6);
    }
    {
      const s = m.sanitizeNumericSettings({ ...m.DEFAULT_SETTINGS, syncConcurrency: 0 });
      t("syncConcurrency=0 钳到下限 1（0 会让 Semaphore 信号量饿死）", s.syncConcurrency === 1);
    }
    {
      const s = m.sanitizeNumericSettings({ ...m.DEFAULT_SETTINGS, scanStopAfterProcessed: -5 });
      t("scanStopAfterProcessed=-5 钳到 0（0 = 显式禁用提前停止，合法值）", s.scanStopAfterProcessed === 0);
    }
    {
      const s = m.sanitizeNumericSettings({ ...m.DEFAULT_SETTINGS, keyframeIntervalSec: null });
      t("keyframeIntervalSec=null → 回默认 10（Number(null)=0 的陷阱不得放行）", s.keyframeIntervalSec === 10);
    }
    {
      const s = m.sanitizeNumericSettings({ ...m.DEFAULT_SETTINGS, keyframeIntervalSec: false });
      t("keyframeIntervalSec=false → 回默认 10（Number(false)=0 同陷阱）", s.keyframeIntervalSec === 10);
    }
    {
      const s = m.sanitizeNumericSettings({ ...m.DEFAULT_SETTINGS, maxTranscribePerSync: "" });
      t("maxTranscribePerSync='' → 回默认 20（空串 Number 为 0 会静默禁用转写预算）", s.maxTranscribePerSync === 20);
    }
    {
      const s = m.sanitizeNumericSettings({ ...m.DEFAULT_SETTINGS, summaryMaxTokens: 100 });
      t("summaryMaxTokens=100 钳到下限 200", s.summaryMaxTokens === 200);
    }
    {
      const s = m.sanitizeNumericSettings({ ...m.DEFAULT_SETTINGS, processRefreshMs: 50 });
      t("processRefreshMs=50 钳到下限 1000", s.processRefreshMs === 1000);
    }
    {
      const s = m.sanitizeNumericSettings({ ...m.DEFAULT_SETTINGS, maxImages: 3.7 });
      t("小数向下取整（3.7 → 3）", s.maxImages === 3);
    }
    {
      const before = { ...m.DEFAULT_SETTINGS, maxTranscribePerSync: NaN };
      const s = m.sanitizeNumericSettings(before);
      t("就地修改并返回同一对象", s === before);
    }
    {
      const s = m.sanitizeNumericSettings({ ...m.DEFAULT_SETTINGS });
      t("全部合法值原样保留", s.syncIntervalMinutes === 60 && s.maxTranscribePerSync === 20 && s.syncConcurrency === 3);
    }
    {
      t("清单 fallback 与 DEFAULT_SETTINGS 同步（漂移即红）", m.fallbackMatchesDefaults() === true);
    }
    {
      // 危害链锁定（文档化对侧）：引擎消费端对 NaN 的既有行为——NaN <= 0 为 false，预算形同虚设。
      // 消毒后该输入不再可能出现，本断言固化消毒函数的输出契约。
      const s = m.sanitizeNumericSettings({ ...m.DEFAULT_SETTINGS, maxTranscribePerSync: "not-a-number" });
      t("消毒输出保证 Number.isFinite（NaN <= 0 判据从此可用）", Number.isFinite(s.maxTranscribePerSync) && (s.maxTranscribePerSync <= 0 || s.maxTranscribePerSync > 0));
    }

    console.log("— needsBackupRescue：半损坏形态的抢救判定（第十一轮）—");
    {
      t("data=null → 需要抢救", m.needsBackupRescue(null) === true);
      t("data=undefined → 需要抢救", m.needsBackupRescue(undefined) === true);
      t("data={} → 需要抢救", m.needsBackupRescue({}) === true);
      t("data=字符串（整体损坏）→ 需要抢救", m.needsBackupRescue("垃圾") === true);
      t("settings+state 齐全 → 不抢救", m.needsBackupRescue({ settings: { cookie: "x" }, state: { processed: {} } }) === false);
      t("仅 settings → 不抢救（state 缺省合法，旧版 data.json）", m.needsBackupRescue({ settings: { cookie: "x" } }) === false);
      t("仅 state（settings 丢失）→ 抢救（本次修的缺口：原条件不触发，Key 静默归零）", m.needsBackupRescue({ state: { processed: {} } }) === true);
      t("settings=null → 抢救", m.needsBackupRescue({ settings: null, state: {} }) === true);
      t("settings=字符串（值损坏）→ 抢救", m.needsBackupRescue({ settings: "垃圾", state: {} }) === true);
      t("settings={} → 不抢救（全默认但非丢失）", m.needsBackupRescue({ settings: {}, state: {} }) === false);
    }

    console.log("— pickSettingsSource：合并来源守卫（第十二轮，抢救失败时的异常路径收口）—");
    {
      const st = { cookie: "x" };
      t("settings 是对象 → 原样返回（同一引用）", m.pickSettingsSource({ settings: st, state: {} }) === st);
      t("data=null → 空来源（全新安装）", Object.keys(m.pickSettingsSource(null)).length === 0);
      t("data=字符串（整体损坏且抢救失败）→ 空来源，索引键不再混入", Object.keys(m.pickSettingsSource("垃圾")).length === 0);
      t("settings=null（抢救失败）→ 空来源，state 整块不再混入 settings", Object.keys(m.pickSettingsSource({ settings: null, state: { processed: {} } })).length === 0);
      t("settings=字符串（抢救失败）→ 空来源", Object.keys(m.pickSettingsSource({ settings: "垃圾", state: {} })).length === 0);
      const legacy = { cookie: "x", bridgeUrl: "http://127.0.0.1:8765" };
      t("无 settings 键（旧版扁平 data.json）→ 顶层即 settings（兼容保留）", m.pickSettingsSource(legacy) === legacy);
      t("data={} → 空来源（等价全默认）", Object.keys(m.pickSettingsSource({})).length === 0);
      const merged = Object.assign({}, m.DEFAULT_SETTINGS, m.pickSettingsSource({ settings: null, state: { processed: {} } }));
      t("端到端：合并结果不含 state/settings 混入键，数值字段已消毒", !("state" in merged) && !("settings" in merged) && merged.maxTranscribePerSync === 20);
    }

    console.log("— 数组收紧（第十二轮增补：数组不是合法 settings/state 容器）—");
    {
      t("settings=数组 → 抢救（原先按对象放行、误判为存在）", m.needsBackupRescue({ settings: [1, 2], state: {} }) === true);
      t("data=数组 → 抢救", m.needsBackupRescue([{ id: 1 }]) === true);
      t("data=数组 → pickSettingsSource 空来源（索引键不再混入）", Object.keys(m.pickSettingsSource([{ id: 1 }])).length === 0);
      t("settings=数组 → pickSettingsSource 空来源（只用默认值）", Object.keys(m.pickSettingsSource({ settings: [1, 2], state: {} })).length === 0);
    }

    console.log("— formatRss：面板 /ping 内存展示（第十一轮）—");
    {
      t("正常字节 → MB 一位小数", m.formatRss(800 * 1024 * 1024) === "800.0MB");
      t("字段缺失 → —（旧桥接无 rss 字段时不显示噪音）", m.formatRss(undefined) === "—");
      t("非法值 → —", m.formatRss("abc") === "—");
      t("0 与负数 → —", m.formatRss(0) === "—" && m.formatRss(-1) === "—");
      t("小内存取整合理", m.formatRss(1048576) === "1.0MB");
    }
  };

  return { get pass() { return pass; }, get fail() { return fail; }, async: asyncChecks };
}
