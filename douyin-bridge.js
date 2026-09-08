// douyin-bridge.js — 本地桥接服务
// 插件 → http://127.0.0.1:<port>/req → 真实 Chromium 页面上下文 fetch → 抖音 API
// 用法: node douyin-bridge.js [port]   (需 NODE_PATH 指向含 playwright-core 的 node_modules)
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { chromium } = require("playwright-core");

const PORT = parseInt(process.argv[2] || "8765", 10);
const PROFILE = path.join(os.homedir(), "Desktop", "抖音收藏1", "login-profile");
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

function findChrome() {
  const base = path.join(os.homedir(), "AppData", "Local", "ms-playwright");
  if (!fs.existsSync(base)) return null;
  const dirs = fs
    .readdirSync(base)
    .filter((d) => /^chromium-\d+$/.test(d))
    .sort((a, b) => parseInt(b.slice(9)) - parseInt(a.slice(9)));
  for (const d of dirs) {
    for (const sub of ["chrome-win64", "chrome-win"]) {
      const p = path.join(base, d, sub, "chrome.exe");
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

let ctx = null;
let page = null;
let headed = false;

async function launchBrowser(useHeaded) {
  const exe = findChrome();
  if (!exe) throw new Error("未找到 Chromium 内核（ms-playwright 目录）");
  ctx = await chromium.launchPersistentContext(PROFILE, {
    executablePath: exe,
    headless: !useHeaded,
    userAgent: UA,
    viewport: useHeaded ? { width: 1280, height: 800 } : { width: 1366, height: 900 },
    args: useHeaded
      ? ["--disable-blink-features=AutomationControlled", "--window-position=-32000,-32000"]
      : ["--disable-blink-features=AutomationControlled"],
  });
  page = ctx.pages()[0] || (await ctx.newPage());
  await page
    .goto("https://www.douyin.com/", { waitUntil: "domcontentloaded", timeout: 60000 })
    .catch(() => {});
  await page.waitForTimeout(3000);
  headed = useHeaded;
}

async function apiFetch(payload) {
  const rel = String(payload.url || "").replace(/^https?:\/\/www\.douyin\.com/, "");
  const out = await page.evaluate(
    async ({ rel, method, body, contentType }) => {
      try {
        const res = await fetch(rel, {
          method: method || "GET",
          headers: body ? { "content-type": contentType || "application/x-www-form-urlencoded" } : undefined,
          body: body || undefined,
        });
        const text = await res.text();
        return { status: res.status, text: text.slice(0, 5000000) };
      } catch (e) {
        return { status: -1, text: "BRIDGE_FETCH_ERROR: " + String(e) };
      }
    },
    { rel, method: payload.method, body: payload.body, contentType: payload.contentType },
  );
  // headless 被 Argus 拦 → 自动换 headed 重试一次
  if (out.status === 403 && !headed) {
    console.log("[bridge] headless 被 403，切换 headed 窗口重试");
    await ctx.close().catch(() => {});
    await launchBrowser(true);
    return apiFetch(payload);
  }
  return out;
}

// 串行队列：同一时刻只放一个 evaluate，避免竞态
let chain = Promise.resolve();
function enqueue(fn) {
  const p = chain.then(fn, fn);
  chain = p.catch(() => {});
  return p;
}

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json" });
  res.end(body);
}

const LOG_FILE = path.join(__dirname, "bridge.log");
function logReq(line) {
  try {
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`);
  } catch {}
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/ping") {
    return send(res, 200, { ok: true, ready: !!page, headed });
  }
  if (req.method === "POST" && req.url === "/req") {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let payload;
      try {
        payload = JSON.parse(raw);
      } catch {
        return send(res, 400, { error: "bad json" });
      }
      enqueue(() => apiFetch(payload))
        .then((out) => {
          logReq(`REQ ${payload.method} ${String(payload.url).slice(0, 80)} -> ${out.status}${out.status === 403 ? " (headed=" + headed + ")" : ""}`);
          send(res, 200, out);
        })
        .catch((e) => {
          logReq(`REQ ERROR ${String(payload.url).slice(0, 80)} -> ${e}`);
          send(res, 500, { status: -1, text: "BRIDGE_ERROR: " + String(e) });
        });
    });
    return;
  }
  send(res, 404, { error: "not found" });
});

// 端口被占 = 已有实例在跑，静默退出
server.on("error", () => process.exit(0));

(async () => {
  await launchBrowser(false);
  // 启动自检：真实拉一页收藏
  const probe = await enqueue(() =>
    apiFetch({
      url: "/aweme/v1/web/aweme/listcollection/?device_platform=webapp&aid=6383&channel=channel_pc_web&version_code=170400",
      method: "POST",
      body: "count=3&cursor=0",
    }),
  );
  console.log(`[bridge] 自检 HTTP ${probe.status} headless=${!headed}`);
  server.listen(PORT, "127.0.0.1", () =>
    console.log(`[bridge] listening on http://127.0.0.1:${PORT} (headed=${headed})`),
  );
})().catch((e) => {
  console.error("[bridge] 启动失败:", e.message);
  process.exit(1);
});
