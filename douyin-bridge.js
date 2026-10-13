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
if (!Number.isFinite(PORT) || PORT <= 0 || PORT > 65535) {
  // 手工运行传错参数时报「端口参数非法」而非脱离上下文的 ERR_SOCKET_BAD_PORT（2026-09-27 第四轮）
  console.error(`[bridge] 端口参数非法：${process.argv[2] || "(未传)"}（应为 1~65535 的数字）`);
  process.exit(1);
}
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
  pageParked = false; // 第十轮复审批：新页面已导航回站点——所有重建路径（探活失败/403 重试/RSS 超限）统一在此复位，此前仅 RSS 巡检分支手动置回
  headed = useHeaded;
  console.log(`[bridge] kernel: ${found.source} -> ${found.exe}`);
  console.log(`[bridge] profile: ${PROFILE}`);
}

// evaluate 无超时是串行队列的单点（2026-09-27 修）：一条挂死请求会让后续所有 /req 无限排队、
// 整轮同步假死。所有 evaluate 都包超时竞速，超时按失败处理走既有的重载/重试路径。
const EVAL_TIMEOUT_MS = 60_000;
const ALIVE_PROBE_TIMEOUT_MS = 10_000;
function withTimeout(promise, ms, tag) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${tag} timeout (${ms / 1000}s)`)), ms);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

// 单飞启动（复审 P2）：启动窗口内（listen 已就绪、浏览器未起来）收到 /req 时，
// ensurePageAlive 若直接 launchBrowser 会与启动中的 launchBrowser 并发 → 双 Chromium 抢同一 profile 锁
let launching = null;
function launchOnce(useHeaded) {
  if (!launching) {
    launching = launchBrowser(useHeaded).finally(() => {
      launching = null;
    });
  }
  return launching;
}

// 等在飞的单飞启动落定（第九轮 C1）：403→headed 重试与探活重建都必须先等它结束——
// 否则 launchOnce(headed) 会命中单飞、拿到仍是 headless 的在飞 promise，而上方 ctx.close()
// 会让该 promise 中途 reject（waitForTimeout 在已关闭 ctx 上抛错），拒绝沿启动 IIFE
// 扩散成整桥 process.exit(1)，插件侧表现为间歇性「15s 启动超时」。
async function waitLaunchSettled() {
  while (launching) {
    await launching.catch(() => {});
  }
}

// 复审 P2：evaluate 超时的 fire-and-forget reload 与 ensurePageAlive 探活竞速——
// 探活的 1+1 在 reload 进行中必抛「Execution context was destroyed」，catch 里再 goto 与在飞 reload
// 双重导航互踩，最终升级成整浏览器重建。把 reload promise 存模块变量，探活前先等它结束。
let pageReloadInFlight = null;
function scheduleReload(reason) {
  if (!pageReloadInFlight) {
    const target = page;
    pageReloadInFlight = (target && !target.isClosed() ? target.reload({ timeout: 30000 }) : Promise.resolve())
      .catch(() => {})
      .finally(() => {
        pageReloadInFlight = null;
      });
    console.log(`[bridge] scheduled page reload (${reason})`);
  }
  return pageReloadInFlight;
}

// ---------- 内存自保（第十轮 P2-1）----------
// 桥是 detached 常驻进程，douyin.com 重 SPA 的页面堆随挂机时长增长（数日可达 GB 级），
// 页面重建此前只在出错时触发，探活成功的膨胀页会永远驻留。两道自保，均经 enqueue 串行
// 与请求互斥：
// 1) 空闲停靠：超过 IDLE_PARK_MS 无请求 → 导航到 about:blank 丢掉站点堆；下次 /req 由
//    ensurePageAlive 的 pageParked 分支先导航回站点；
// 2) RSS 超限重建：rss 超过 RSS_REBUILD_BYTES → 走 waitLaunchSettled + ctx.close + launchOnce。
const IDLE_PARK_MS = 10 * 60_000;
const RSS_REBUILD_BYTES = 800 * 1024 * 1024;
let lastReqAt = Date.now();
let pageParked = false;

async function ensurePageAlive() {
  // 在飞的 reload 先等它结束（复审 P2），避免探活与重载互踩
  if (pageReloadInFlight) await pageReloadInFlight;
  // 空闲停靠恢复（第十轮 P2-1）：about:blank 上 fetch 相对 URL 必失败，先导航回站点。
  // 第十轮复审批：恢复失败必须保持 pageParked=true 并让本次请求失败——若无条件复位，
  // about:blank 上的探活（1+1）永远通过、页面内 fetch 相对 URL 永远失败（-1 重试再 -1），
  // 桥会对后续所有请求持续失败直到重启；保持停靠标记则下一轮请求会重新尝试导航。
  if (pageParked) {
    if (page && !page.isClosed()) {
      const back = await page
        .goto("https://www.douyin.com/", { waitUntil: "domcontentloaded", timeout: 60000 })
        .then(() => true, () => false);
      if (!back || !/douyin\.com/.test(page.url())) {
        throw new Error(`park recovery: navigate back failed (url=${page.url().slice(0, 60)})`);
      }
      await page.waitForTimeout(3000);
    }
    pageParked = false;
  }
  // 长时间驻留后页面可能挂死/被站点刷新，请求前保活（探活本身也带超时，挂死页同样能被识别）
  try {
    if (!page || page.isClosed()) throw new Error("page closed");
    await withTimeout(page.evaluate("1+1"), ALIVE_PROBE_TIMEOUT_MS, "alive-probe");
  } catch {
    console.log("[bridge] page dead, reloading");
    // 复审 P2：!page / !ctx（启动窗口收到 /req）时，下面的 goto/close 对 null 引用会同步抛 TypeError，
    // .catch() 只兜 Promise 拒绝不兜同步抛出 → 错误语义失真。走单飞启动兜底。
    if (!ctx || !page) {
      await launchOnce(headed);
      return;
    }
    try {
      await page.goto("https://www.douyin.com/", { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(3000);
    } catch {
      console.log("[bridge] reload failed, rebuilding browser context");
      await waitLaunchSettled(); // 第九轮 C1：见 waitLaunchSettled 注释
      await ctx.close().catch(() => {});
      // 重建同样走单飞（2026-09-27 第四轮）：与启动窗口/其他在飞 launch 并发时不再双开 Chromium
      await launchOnce(headed);
    }
  }
}

async function apiFetch(payload) {
  await ensurePageAlive();
  lastReqAt = Date.now(); // 空闲停靠计时基准（第十轮 P2-1）
  const rel = String(payload.url || "").replace(/^https?:\/\/www\.douyin\.com/, "");
  const evalArgs = { rel, method: payload.method, body: payload.body, contentType: payload.contentType };
  const doEval = () =>
    withTimeout(
      page.evaluate(
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
        evalArgs,
      ),
      EVAL_TIMEOUT_MS,
      "page.evaluate",
    ).catch((e) => {
      const msg = String(e?.message ?? e);
      // 超时只让本次 HTTP 请求失败还不够（回归审查 #9）：挂死的 evaluate 仍占着串行队列，
      // 后续请求会继续排队。调度 reload（可被 ensurePageAlive 等待，复审 P2）使挂死的 evaluate
      // 立即以异常结束、队列放行。
      if (/timeout/i.test(msg)) {
        scheduleReload("evaluate timeout");
      }
      return { status: -1, text: "BRIDGE_EVAL_ERROR: " + msg };
    });
  const out = await doEval();
  // 页面内 fetch 抛错/evaluate 超时（-1）→ 重载后重试一次
  if (out.status === -1) {
    console.log("[bridge] fetch error, reload and retry");
    await ensurePageAlive();
    return doEval();
  }
  // headless 被 Argus 拦 → 自动换 headed 重试一次
  if (out.status === 403 && !headed) {
    console.log("[bridge] 403 in headless, retrying with headed window");
    await waitLaunchSettled(); // 第九轮 C1：先等在飞的单飞启动落定，再关旧上下文（防整桥 exit(1)，见函数注释）
    await ctx.close().catch(() => {});
    // 单飞收口（2026-09-27 第四轮）：与启动窗口/探活重建并发时不再双开 Chromium
    await launchOnce(true);
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

// 第十一轮：send 内部统一兜底——客户端在响应窗口断开时 writeHead/end 可能同步抛
// （ERR_HTTP_HEADERS_SENT / ERR_STREAM_DESTROYED），request handler 与 enqueue .then 里的
// 调用点没有各自的 try，异常会以 uncaught exception 崩掉常驻桥进程（同步全停）。
// 各调用点此前只有部分包了 try（/download 错误路径有、/req 成功路径没有），收口到一处。
function send(res, code, obj) {
  try {
    const body = JSON.stringify(obj);
    res.writeHead(code, { "content-type": "application/json" });
    res.end(body);
  } catch {}
}

const LOG_FILE = path.join(__dirname, "bridge.log");
const LOG_MAX_BYTES = 2 * 1024 * 1024; // 2MB 触发轮转（长期挂机的桥此前日志无界增长）
let logOps = 0;
function rotateLogIfNeeded(force) {
  try {
    const st = fs.existsSync(LOG_FILE) ? fs.statSync(LOG_FILE) : null;
    if (st && st.size > LOG_MAX_BYTES) {
      fs.writeFileSync(LOG_FILE, `${new Date().toISOString()} [rotate] log exceeded ${LOG_MAX_BYTES} bytes, truncated\n`);
    }
  } catch {}
}
rotateLogIfNeeded(true);
function logReq(line) {
  try {
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`);
    // 每 500 次写复查一次大小（避免每次 append 都 stat 的开销）
    if (++logOps % 500 === 0) rotateLogIfNeeded(false);
  } catch {}
}

// ---------- 请求体读取（2026-09-27 修）----------
// 原实现 `raw += c` 无字节上限：同机任意进程 POST 超大 body 可把 Node 打到 OOM；
// 且无 req.on("error")，客户端中途断开时 IncomingMessage 的 error 无人监听会直接崩掉整个桥接。
const BODY_LIMITS = {
  "/req": 1 * 1024 * 1024, // 只携带 URL/方法 JSON，1MB 绰绰有余
  "/download": 1 * 1024 * 1024, // payload 只是目标 URL，下载发生在浏览器上下文里
};
function readBody(req, res, url, onBody) {
  const max = BODY_LIMITS[url] || 1 * 1024 * 1024;
  const chunks = [];
  let bytes = 0;
  let aborted = false;
  req.on("data", (c) => {
    if (aborted) return;
    bytes += c.length;
    if (bytes > max) {
      aborted = true;
      req.pause();
      try { send(res, 413, { error: `payload too large (>${max} bytes)` }); } catch {}
      // 第九轮 C12：响应 flush 完再断开——req 与 res 共享同一 socket，立即 destroy 可能
      // 抢在 413 写出之前，客户端看到的是连接重置而非 413
      res.on("finish", () => { try { req.destroy(); } catch {} });
      return;
    }
    chunks.push(c);
  });
  req.on("error", () => {
    aborted = true;
    try { res.destroy(); } catch {}
  });
  req.on("end", () => {
    if (!aborted) {
      // Buffer.concat 后统一解码（2026-09-27 第四轮）：逐块 `raw += c` 的隐式 toString 按块独立
      // 解码，跨块的多字节 UTF-8（中文等）会被撕裂成 mojibake
      onBody(Buffer.concat(chunks).toString("utf8"));
    }
  });
}

// ---------- 本地请求校验（2026-09-27 修，阻断本地 CSRF/DNS rebinding）----------
// 浏览器里任意网页都能向 127.0.0.1:<port>/shutdown 发跨站 POST（简单请求无预检），
// 或经 DNS rebinding 伪装域名访问。插件侧 requestUrl 与 curl 都不会带 Origin 头。
function localRequestOk(req) {
  const host = String(req.headers.host || "");
  if (!/^127\.0\.0\.1:\d+$/i.test(host) && !/^localhost:\d+$/i.test(host) && !/^\[::1\]:\d+$/i.test(host)) {
    return false;
  }
  if (req.headers.origin) return false; // 浏览器跨站请求必带 Origin → 一律拒绝
  return true;
}

const server = http.createServer((req, res) => {
  // 本地校验（2026-09-27 修）：非本机 Host / 带 Origin 的跨站请求一律拒绝
  if (!localRequestOk(req)) {
    logReq(`REJECTED ${req.method} ${req.url} host=${String(req.headers.host || "")} origin=${String(req.headers.origin || "")}`);
    return send(res, 403, { error: "forbidden (local only)" });
  }
  if (req.method === "GET" && req.url === "/ping") {
    return send(res, 200, {
      ok: true,
      ready: !!page,
      headed,
      kernel: kernel ? kernel.source : null,
      profile: PROFILE,
      rss: process.memoryUsage().rss, // 第十轮 P2-1：管理面板可直接观察桥内存
    });
  }
  if (req.method === "POST" && req.url === "/download") {
    // 浏览器上下文代下载（绕过 CDN 对非浏览器指纹的拦截），返回 base64
    readBody(req, res, "/download", (raw) => {
      let payload;
      try { payload = JSON.parse(raw); } catch { return send(res, 400, { error: "bad json" }); }
      enqueue(async () => {
        await ensurePageAlive();
        const rel = String(payload.url || "").replace(/^https?:\/\/www\.douyin\.com/, "");
        const out = await withTimeout(
          page.evaluate(async (rel) => {
            try {
              const r = await fetch(rel, { credentials: "include" });
              const buf = await r.arrayBuffer();
              // 第十轮 P3-4：上限 200MB → 64MB。原限制是 fetch 全量落堆后才检查，
              // 大文件会先在页面堆里攒出 GB 级 base64 字符串；端点本为诊断保留（C13），
              // 64MB 对小图/短视频诊断足够，堆峰值约 200MB 可承受
              if (buf.byteLength > 64 * 1024 * 1024) return { status: r.status, error: "file exceeds 64MB limit" };
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
          }, rel),
          300_000,
          "download",
        ).catch((e) => ({ status: -1, error: String(e) }));
        logReq(`DOWNLOAD ${String(payload.url).slice(0, 60)} -> ${out.status} bytes=${out.bytes || 0}`);
        send(res, 200, out);
      }).catch((e) => {
        // 2026-09-27 修：enqueue 任务缺 .catch 时 ensurePageAlive 抛错会让 HTTP 响应永久悬挂
        logReq(`DOWNLOAD ERROR ${String(payload.url).slice(0, 60)} -> ${e}`);
        try { send(res, 500, { status: -1, error: String(e) }); } catch {}
      });
    });
    return;
  }
  if (req.method === "POST" && req.url === "/req") {
    readBody(req, res, "/req", (raw) => {
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
// 客户端异常兜底（2026-09-27 修）：无监听器的 clientError 会以 uncaught exception 崩掉整个桥接
server.on("clientError", (err, socket) => {
  try { socket.destroy(); } catch {}
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

// 内存自保巡检（第十轮 P2-1）：60s 一查，空闲达标才动手；unref 不阻止进程退出
setInterval(() => {
  if (shuttingDown || !ctx || !page) return;
  if (Date.now() - lastReqAt < IDLE_PARK_MS) return;
  lastReqAt = Date.now(); // 本轮处理完再等一个完整空闲窗口，避免连续触发
  const rss = process.memoryUsage().rss;
  if (rss > RSS_REBUILD_BYTES) {
    console.log(`[bridge] rss ${Math.round(rss / 1048576)}MB > limit, rebuilding browser context`);
    enqueue(async () => {
      await waitLaunchSettled();
      await ctx.close().catch(() => {});
      await launchOnce(headed);
      pageParked = false; // launchBrowser 已导航回站点
    }).catch(() => {});
    return;
  }
  if (pageParked) return; // 已停靠，无事可做
  console.log("[bridge] idle 10min, parking page to about:blank to release site heap");
  enqueue(async () => {
    if (page && !page.isClosed()) {
      await page.goto("about:blank", { timeout: 30000 }).catch(() => {});
      pageParked = true;
    }
  }).catch(() => {});
}, 60_000).unref();

// 端口/服务错误（2026-09-27 修）：写 stderr 再退出，插件侧与人工排查都能看到真实原因；
// EADDRINUSE（双拉起）以退出码 1 退出，不再静默 exit(0)
server.on("error", (e) => {
  console.error(`[bridge] server error: ${e && e.code ? e.code : ""} ${e && e.message ? e.message : e}`);
  process.exit(1);
});

(async () => {
  // 先听端口再启浏览器（2026-09-27 修）：原顺序是先完整启动 Chromium（可达 10s+）再 listen，
  // 双拉起时第二个实例白启一个浏览器才发现端口被占、还与在跑实例抢同一 profile 锁。
  // 现在端口被占会在启动浏览器之前立即退出（stderr 带原因）；启动窗口内 /ping 返回 ok=true, ready=false。
  await new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve));
  console.log(`[bridge] listening on http://127.0.0.1:${PORT} (browser starting…)`);
  // 初始启动同样走单飞（2026-09-27 第四轮）：listen 到浏览器就绪之间有数秒窗口，此时收到
  // /req 会走 ensurePageAlive 的 launchOnce 兜底——初始启动不经单飞的话，两条 launchPersistentContext
  // 会并发抢同一 profile 锁，抢输的一方整桥 exit(1)
  await launchOnce(false);
  // 启动自检：真实拉一页收藏
  const probe = await enqueue(() =>
    apiFetch({
      url: "/aweme/v1/web/aweme/listcollection/?device_platform=webapp&aid=6383&channel=channel_pc_web&version_code=170400",
      method: "POST",
      body: "count=3&cursor=0",
    }),
  );
  console.log(`[bridge] 自检 HTTP ${probe.status} headless=${!headed}`);
  console.log(`[bridge] ready (headed=${headed})`);
})().catch((e) => {
  console.error("[bridge] startup failed:", e.message);
  process.exit(1);
});
