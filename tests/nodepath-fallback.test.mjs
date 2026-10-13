// nodepath 过期加固（U1~U4）单测：util.resolveNodeExe「配置 → 可执行文件」决策纯函数。
// 事故背景：WorkBuddy 更新换 node 版本目录（22.22.2-3 → 22.22.2-6）并删除旧目录，
// data.json 里的 bridgeNodePath 失效 → spawn 异步 ENOENT → 用户空等 15s 超时。
// 决策三分支：未配置 / 健康路径 / 过期路径；existsFn 全部注入（测试环境无 Electron
// require，默认 fsExists 恒 false，不能走默认实现）。
export function runTests(m) {
  const { resolveNodeExe } = m;
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
  const yes = () => true; // existsFn 替身：文件存在
  const no = () => false; // existsFn 替身：文件不存在

  console.log("— resolveNodeExe：健康路径（文件存在，U3 行为零变化）—");
  {
    const configured = "C:/Program Files/nodejs/node.exe";
    const r = resolveNodeExe({ bridgeNodePath: configured, existsFn: yes });
    t("健康路径原样返回（exe = 配置路径，与旧实现 trim 后取值一致）", r.exe === configured);
    t("健康路径不产生 stale 标记（不发警告）", !r.stalePath);
    t("配置路径两侧空白被 trim（spawn 参数干净）", resolveNodeExe({ bridgeNodePath: "  " + configured + "  ", existsFn: yes }).exe === configured);
  }

  console.log("— resolveNodeExe：过期路径（文件已删除，U1/U2 触发条件）—");
  {
    const stale = "C:/Users/x/.workbuddy/binaries/node/versions/22.22.2-3/node.exe";
    const r = resolveNodeExe({ bridgeNodePath: stale, existsFn: no });
    t("回退 PATH node（exe = 'node'）", r.exe === "node");
    t("stalePath 携带原配置路径原文（供快失败提示与会话级一次性警告）", r.stalePath === stale);
    t("stalePath 与 exe 互斥语义成立（回退时不把失效路径留在 exe）", r.exe !== stale);
    t("trim 后为空的失效判定不误伤：仅空白串不走存在性检查", resolveNodeExe({ bridgeNodePath: "   ", existsFn: no }).stalePath === undefined);
  }

  console.log("— resolveNodeExe：未配置（空 / 空白 / null / undefined，与旧实现 || 'node' 等价）—");
  {
    t("空串回退 PATH node", resolveNodeExe({ bridgeNodePath: "", existsFn: no }).exe === "node");
    t("纯空白回退 PATH node", resolveNodeExe({ bridgeNodePath: "   ", existsFn: yes }).exe === "node");
    t("null 回退 PATH node（旧 ensureRunning 分支行为等价）", resolveNodeExe({ bridgeNodePath: null, existsFn: no }).exe === "node");
    t("undefined 回退 PATH node（旧 startInner 分支行为等价）", resolveNodeExe({ existsFn: no }).exe === "node");
    t("未配置不产生 stale 标记", !resolveNodeExe({ bridgeNodePath: null, existsFn: no }).stalePath);
  }

  return { get pass() { return pass; }, get fail() { return fail; } };
}
