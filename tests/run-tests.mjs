// 测试运行器：esbuild 打包纯函数模块（不依赖 obsidian）后加载 tests/ 下全部 *.test.mjs 用例。
// 运行：npm test（即 node tests/run-tests.mjs；结束后自清理 bundle 文件）
import { build } from "esbuild";
import { pathToFileURL, fileURLToPath } from "node:url";
import { readdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url)); // fileURLToPath：路径含中文/空格时 fileURLToPath 才能正确解码
const outfile = path.join(here, ".bundle.tmp.mjs");

await build({
  entryPoints: [path.join(here, "entry.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile,
  logLevel: "silent",
  // obsidian 模块替身：被替身后 douyinClient.normalize 等纯静态方法可进单测（requestUrl 不会被调用）
  alias: { obsidian: path.join(here, "obsidian-stub.ts") },
});

let pass = 0;
let fail = 0;
try {
  const { m } = await import(pathToFileURL(outfile).href);
  const suites = readdirSync(here)
    .filter((f) => f.endsWith(".test.mjs"))
    .sort();
  for (const s of suites) {
    const mod = await import(pathToFileURL(path.join(here, s)).href);
    const r = mod.runTests(m);
    if (typeof r.async === "function") await r.async(); // 支持异步断言（先跑完再累计，保证计数正确）
    pass += r.pass;
    fail += r.fail;
  }
  console.log(`\n合计：${pass} 通过，${fail} 失败`);
} finally {
  await rm(outfile, { force: true }); // 清理放在 finally：用例抛错也不残留 bundle
}
process.exit(fail > 0 ? 1 : 0);
