// douyin-bridge.js — 本地桥接服务
// 插件 → http://127.0.0.1:<port>/req → 真实 Chromium 页面上下文 fetch → 抖音 API
//
// 用法: node douyin-bridge.js [port]
//   需 NODE_PATH 指向含 playwright-core 的 node_modules（或用安装脚本写好插件配置）
//
// 依赖同目录的 bridge-common.js（内核探测 + 登录态目录解析）。
// 内核探测回退链：playwright 自带内核 → 系统 Chrome → 系统 Edge。
const http = require("http");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright-core");
const { UA, resolveProfile, findChrome, kernelArgs } = require("./bridge-common");

const PORT = parseInt(process.argv[2] || "8765", 10);
const PROFILE = resolveProfile();

let ctx = null;
let page = null;
let headed = false;
let kernel = null;

async function launchBrowser(useHeaded) {
  const found = findChrome();
  kernel = found;
  const extra = kernelArgs(found.source);
  ctx = await chromium.launchPersistentContext(PROFILE, {
    executablePath: found.exe,
    headless: !useHeaded,
    userAgent: UA,
    viewport: useHeaded ? { width: 1280, height: 800 } : { width: 1366, height: 900 },
    args: useHeaded
      ? ["--disable-blink-features=AutomationControlled", "--window-position=-32000,-32000", ...extra]
      : ["--disable-blink-features=AutomationControlled", ...extra],
  });
  page = ctx.pages()[0] || (await ctx.newPage());
  await page
    .goto("https://www.douyin.com/", { waitUntil: "domcontentloaded", timeout: 60000 })
    .catch(() => {});
  await page.waitForTimeout(3000);
  headed = useHeaded;
  console.log(`[bridge] kernel: ${found.source} -> ${found.exe}`);
  console.log(`[bridge] profile: ${PROFILE}`);
}

async function ensurePageAlive() {
  // 长时间驻留后页面可能挂死/被站点刷新，请求前保活
  try {
    if (!page || page.isClosed()) throw new Error("page closed");
    await page.evaluate("1+1");
  } catch {
    console.log("[bridge] page dead, reloading");
    try {
      await page.goto("https://www.douyin.com/", { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(3000);
    } catch {
      console.log("[bridge] reload failed, rebuilding browser context");
      await ctx.close().catch(() => {});
      await launchBrowser(headed);
    }
  }
}

async function apiFetch(payload) {
  await ensurePageAlive();
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
  // 页面内 fetch 抛错（-1）→ 重载后重试一次
  if (out.status === -1) {
    console.log("[bridge] fetch error, reload and retry");
    await ensurePageAlive();
    const retry = await page.evaluate(
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
    return retry;
  }
  // headless 被 Argus 拦 → 自动换 headed 重试一次
  if (out.status === 403 && !headed) {
    console.log("[bridge] 403 in headless, retrying with headed window");
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
    return send(res, 200, {
      ok: true,
      ready: !!page,
      headed,
      kernel: kernel ? kernel.source : null,
      profile: PROFILE,
    });
  }
  if (req.method === "POST" && req.url === "/download") {
    // 浏览器上下文代下载（绕过 CDN 对非浏览器指纹的拦截），返回 base64
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let payload;
      try { payload = JSON.parse(raw); } catch { return send(res, 400, { error: "bad json" }); }
      enqueue(async () => {
        await ensurePageAlive();
        const rel = String(payload.url || "").replace(/^https?:\/\/www\.douyin\.com/, "");
        const out = await page.evaluate(async (rel) => {
          try {
            const r = await fetch(rel, { credentials: "include" });
            const buf = await r.arrayBuffer();
            if (buf.byteLength > 200 * 1024 * 1024) return { status: r.status, error: "file exceeds 200MB limit" };
            const bytes = new Uint8Array(buf);
            let bin = "";
            const CH = 0x8000;
            for (let i = 0; i < bytes.length; i += CH) {
              bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
            }
            return { status: r.status, contentType: r.headers.get("content-type") || "", b64: btoa(bin), bytes: buf.byteLength };
          } catch (e) {
            return { status: -1, error: String(e) };
          }
        }, rel).catch((e) => ({ status: -1, error: String(e) }));
        logReq(`DOWNLOAD ${String(payload.url).slice(0, 60)} -> ${out.status} bytes=${out.bytes || 0}`);
        send(res, 200, out);
      });
    });
    return;
  }
  if (req.method === "POST" && req.url === "/form-upload") {
    // Node 原生 multipart 上传（把 base64 文件 + 指定表单字段 POST 到目标 host）
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let payload;
      try { payload = JSON.parse(raw); } catch { return send(res, 400, { error: "bad json" }); }
      (async () => {
        const fd = new FormData();
        for (const [k, v] of Object.entries(payload.fields || {})) fd.append(k, String(v));
        const bin = Buffer.from(payload.fileB64, "base64");
        fd.append("file", new Blob([bin]), payload.filename || "audio.mp4");
        const r = await fetch(payload.uploadHost, { method: "POST", body: fd });
        const text = await r.text();
        logReq(`FORM-UPLOAD ${payload.filename} -> ${r.status} bytes=${bin.length}`);
        send(res, 200, { status: r.status, text: text.slice(0, 2000) });
      })().catch((e) => send(res, 500, { status: -1, text: "UPLOAD_ERROR: " + String(e) }));
    });
    return;
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
  if (req.method === "POST" && req.url === "/shutdown") {
    // 问题 11：供插件侧先优雅退出（关 Chromium 上下文、释放 profile 锁），失败再由调用方强杀
    send(res, 200, { ok: true, msg: "shutting down" });
    gracefulShutdown("request");
    return;
  }

  send(res, 404, { error: "not found" });
});

// 优雅退出（问题 11）：先关浏览器上下文（释放 profile 目录锁）再退出，避免强杀后下次启动报错
let shuttingDown = false;
function gracefulShutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[bridge] graceful shutdown (${reason})`);
  try { if (ctx) ctx.close().catch(() => {}); } catch {}
  try { server.close(() => process.exit(0)); } catch { process.exit(0); }
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

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
  console.error("[bridge] startup failed:", e.message);
  process.exit(1);
});
