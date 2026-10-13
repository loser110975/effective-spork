// 存储拆分轮测试（data.json → settings.json + state.json 双文件布局）：
// 覆盖迁移（单文件→拆分、迁移幂等、旧文件保留）、损坏回退（.bak 抢救 / 旧 data.json 兜底）、
// 原子写（.tmp 中间态 + rename / rename 失败重试）与备份链（.bak 生成 + .bak.tmp 消失）。
// 全程内存 FakeAdapter，不触真实 Vault。
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

  const { PluginFileStore, payloadNeedsRescue, pickSettingsSource } = m;

  /** 内存适配器：实现 KvAdapter 全部方法，记录 rename 序列供原子性断言。 */
  class FakeAdapter {
    constructor() {
      this.files = new Map(); // path -> string
      this.renames = []; // {from, to}
    }
    async exists(p) {
      return this.files.has(String(p));
    }
    async read(p) {
      const v = this.files.get(String(p));
      if (v === undefined) throw new Error("read: 不存在 " + p);
      return v;
    }
    async write(p, data) {
      this.files.set(String(p), String(data));
    }
    async remove(p) {
      this.files.delete(String(p));
    }
    async rename(from, to) {
      if (from === to) throw new Error("same path");
      this.renames.push({ from: String(from), to: String(to) });
      const v = this.files.get(String(from));
      if (v === undefined) throw new Error("rename: 源不存在 " + from);
      this.files.delete(String(from));
      this.files.set(String(to), v);
    }
  }

  const DIR = "plugins/douyin-sync";
  const store = (adapter, bakMs = 10 * 60_000) => new PluginFileStore(adapter, DIR, bakMs);
  const pathOf = (name) => `${DIR}/${name}`;

  const asyncChecks = async () => {
    console.log("— 存储拆分：迁移（data.json → settings.json + state.json）—");
    {
      const a = new FakeAdapter();
      const legacy = { settings: { cookie: "s=1;", maxTranscribePerSync: 5 }, state: { processed: { x: { path: "a.md", syncedAt: "t", folder: "f" } }, pendingAsr: [] } };
      a.files.set(pathOf("data.json"), JSON.stringify(legacy));
      const st = store(a);
      const r = await st.load();
      t("迁移：migrated=true", r.migrated === true);
      t("迁移：settings 载荷=旧 settings 域", r.settings && r.settings.cookie === "s=1;" && r.settings.maxTranscribePerSync === 5);
      t("迁移：state 载荷=旧 state 域", r.state && r.state.processed && r.state.processed.x.path === "a.md");
      t("迁移：双新文件已写出", a.files.has(pathOf("settings.json")) && a.files.has(pathOf("state.json")));
      t("迁移：新文件载荷为对象本体（非复合包装）", JSON.parse(a.files.get(pathOf("settings.json"))).cookie === "s=1;" && JSON.parse(a.files.get(pathOf("state.json"))).pendingAsr.length === 0);
      t("迁移：旧 data.json 原样保留（回滚锚点）", a.files.get(pathOf("data.json")) === JSON.stringify(legacy));
      t("迁移：Notice 含迁移完成提示", r.notices.some((n) => n.includes("迁移") && n.includes("data.json")));
    }

    console.log("— 存储拆分：迁移幂等（第二次加载读新文件，不再迁移）—");
    {
      const a = new FakeAdapter();
      a.files.set(pathOf("data.json"), JSON.stringify({ settings: { cookie: "old" }, state: { processed: {} } }));
      const st = store(a);
      await st.load();
      // 迁移后用户改动新文件（模拟首次落盘），旧 data.json 保持旧值
      await st.writeJson("settings.json", { cookie: "new" });
      const r2 = await st.load();
      t("第二次加载 migrated=false", r2.migrated === false);
      t("第二次加载读新文件（旧 data.json 不再是数据源）", r2.settings.cookie === "new");
      t("旧 data.json 未被改写", a.files.get(pathOf("data.json")) === JSON.stringify({ settings: { cookie: "old" }, state: { processed: {} } }));
    }

    console.log("— 存储拆分：双新文件齐全 → 直接读新 —");
    {
      const a = new FakeAdapter();
      a.files.set(pathOf("settings.json"), JSON.stringify({ cookie: "fresh" }));
      a.files.set(pathOf("state.json"), JSON.stringify({ processed: {}, pendingAsr: [] }));
      const r = await store(a).load();
      t("migrated=false 且读新载荷", r.migrated === false && r.settings.cookie === "fresh" && r.state.pendingAsr.length === 0);
      t("无提示（正常路径无 Notice）", r.notices.length === 0);
    }

    console.log("— 存储拆分：全新安装（无任何文件）—");
    {
      const r = await store(new FakeAdapter()).load();
      t("settings/state 为 null 且不迁移", r.settings === null && r.state === null && r.migrated === false && r.notices.length === 0);
    }

    console.log("— 存储拆分：损坏回退（.bak 抢救 → 旧 data.json 兜底）—");
    {
      // 场景 1：settings.json 损坏但有 .bak → 从 .bak 恢复
      const a1 = new FakeAdapter();
      a1.files.set(pathOf("settings.json"), "{截断的JSON");
      a1.files.set(pathOf("state.json"), JSON.stringify({ processed: {} }));
      a1.files.set(pathOf("settings.json.bak"), JSON.stringify({ cookie: "from-bak" }));
      const r1 = await store(a1).load();
      t("settings.json 损坏 → 从 settings.json.bak 恢复", r1.settings && r1.settings.cookie === "from-bak");
      t("抢救有 Notice", r1.notices.some((n) => n.includes("settings.json") && n.includes("备份")));
      // 场景 2：双新文件都损坏且无备份 → 回退旧 data.json 对应域
      const a2 = new FakeAdapter();
      a2.files.set(pathOf("settings.json"), "garbage");
      a2.files.set(pathOf("state.json"), "garbage");
      a2.files.set(pathOf("data.json"), JSON.stringify({ settings: { cookie: "legacy" }, state: { processed: { k: 1 } } }));
      const r2 = await store(a2).load();
      t("双新文件损坏 → 回退旧 data.json 的 settings 域", r2.settings && r2.settings.cookie === "legacy");
      t("回退旧 data.json 的 state 域", r2.state && r2.state.processed.k === 1);
      t("回退有警告 Notice", r2.notices.some((n) => n.includes("回退") && n.includes("data.json")));
      // 场景 3：state.json 缺失但 settings.json 完好（无旧 data.json）→ settings 正常、state 为 null
      const a3 = new FakeAdapter();
      a3.files.set(pathOf("settings.json"), JSON.stringify({ cookie: "only-s" }));
      const r3 = await store(a3).load();
      t("state.json 缺失不算致命", r3.settings.cookie === "only-s" && r3.state === null);
    }

    console.log("— 存储拆分：原子写（.tmp 中间态 + rename；rename 失败 remove 重试）—");
    {
      const a = new FakeAdapter();
      const st = store(a);
      await st.writeJson("state.json", { processed: {} });
      t("写后 .tmp 不残留", !a.files.has(pathOf("state.json.tmp")));
      t("rename 走 tmp → 正式", a.renames.some((r) => r.from === pathOf("state.json.tmp") && r.to === pathOf("state.json")));
      // rename 对已存在目标失败 → remove 后重试成功（FakeAdapter.rename 不允许覆盖目标）
      a.files.set(pathOf("state.json.tmp"), JSON.stringify({ processed: { n: 2 } }));
      const realRename = a.rename.bind(a);
      let blockedOnce = false;
      a.rename = async (from, to) => {
        if (String(to) === pathOf("state.json") && a.files.has(pathOf("state.json")) && !blockedOnce) {
          blockedOnce = true;
          throw new Error("target exists");
        }
        return realRename(from, to);
      };
      await st.writeJson("state.json", { processed: { n: 2 } });
      t("rename 失败 → remove 后重试成功（内容为新值）", JSON.parse(a.files.get(pathOf("state.json"))).processed.n === 2 && blockedOnce);
    }

    console.log("— 存储拆分：备份链（.bak 生成与节流）—");
    {
      const a = new FakeAdapter();
      const st = store(a, 0); // 测试：节流 0 → 每次写都到期
      await st.writeJson("settings.json", { cookie: "v1" });
      t("首次写（无旧文件）不产生 .bak", !a.files.has(pathOf("settings.json.bak")));
      await st.writeJson("settings.json", { cookie: "v2" });
      t("第二次写前旧内容进 .bak", JSON.parse(a.files.get(pathOf("settings.json.bak"))).cookie === "v1");
      t("正式文件为新值", JSON.parse(a.files.get(pathOf("settings.json"))).cookie === "v2");
      t(".bak.tmp 中间态不残留", !a.files.has(pathOf("settings.json.bak.tmp")));
      // 节流：默认 10 分钟间隔内不重复备份。注意首次写（无旧文件）不产生 .bak 也不记账，
      // 所以第二次写会正常备份 v0；第三次写在节流窗口内 → .bak 停留在 v0（不被 v1 覆盖）。
      const a2 = new FakeAdapter();
      const st2 = store(a2, 10 * 60_000);
      await st2.writeJson("state.json", { processed: {} });
      await st2.writeJson("state.json", { processed: { n: 1 } });
      t("第二次写前旧内容进 .bak（首次写无旧文件未记账）", JSON.stringify(JSON.parse(a2.files.get(pathOf("state.json.bak")))) === JSON.stringify({ processed: {} }));
      await st2.writeJson("state.json", { processed: { n: 2 } });
      t("节流期内第三次写不刷新 .bak（仍为 v0 而非 v1）", JSON.stringify(JSON.parse(a2.files.get(pathOf("state.json.bak")))) === JSON.stringify({ processed: {} }));
    }

    console.log("— 存储拆分：settingsSanitize 适配（payloadNeedsRescue + 复合结构口径不变）—");
    {
      t("payloadNeedsRescue：对象 → false（完好）", payloadNeedsRescue({ cookie: "x" }) === false);
      t("payloadNeedsRescue：null / 数组 / 标量 → true（损坏）", payloadNeedsRescue(null) === true && payloadNeedsRescue([1]) === true && payloadNeedsRescue("x") === true && payloadNeedsRescue(undefined) === true);
      t("pickSettingsSource：合成复合结构 {settings: 载荷} → 直接采用", pickSettingsSource({ settings: { cookie: "a" } }).cookie === "a");
      t("pickSettingsSource：载荷损坏 → {}（不合并整个 data）", Object.keys(pickSettingsSource({ settings: null })).length === 0);
      t("needsBackupRescue：旧复合结构口径不变", m.needsBackupRescue({ settings: {}, state: {} }) === false && m.needsBackupRescue({ state: {} }) === true);
    }
  };

  // getter 形式：run-tests 在 await async() 之后读取 pass/fail，异步断言的计数才不会丢（修复静默漏计）
  return { get pass() { return pass; }, get fail() { return fail; }, async: asyncChecks };
}
