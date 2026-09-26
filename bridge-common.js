// bridge-common.js — 桥接链路的公共能力
// 被 douyin-bridge.js（桥接服务）与 login-capture.js（扫码登录）共用，
// 保证两者命中同一个 Chromium 内核、写入同一个登录态目录，避免漂移。
//
// 移植性约定：
//   · 内核探测回退链：playwright 自带内核 → 系统 Chrome → 系统 Edge
//   · 登录态目录：环境变量 DOUYIN_BRIDGE_PROFILE > 同目录 profile-path.txt
//                 > %LOCALAPPDATA%\DouyinSyncBridge\login-profile
const fs = require("fs");
const path = require("path");
const os = require("os");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

/** 用户级默认登录态目录。 */
function defaultProfile() {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return path.join(localAppData, "DouyinSyncBridge", "login-profile");
}

/** 可选的同目录配置文件：一行文本，指定登录态目录。用于沿用已有的登录态。 */
function configuredProfile() {
  try {
    const f = path.join(__dirname, "profile-path.txt");
    if (!fs.existsSync(f)) return "";
    const v = fs.readFileSync(f, "utf8").trim().split(/\r?\n/)[0].trim();
    return v || "";
  } catch {
    return "";
  }
}

/** 解析本次要用的登录态目录：环境变量 > profile-path.txt > 用户级默认目录。 */
function resolveProfile() {
  const fromEnv = (process.env.DOUYIN_BRIDGE_PROFILE || "").trim();
  if (fromEnv) return fromEnv;
  const fromFile = configuredProfile();
  if (fromFile) return fromFile;
  return defaultProfile();
}

/**
 * 探测可用的 Chromium 内核。
 * @returns {{exe: string, source: "playwright"|"system-chrome"|"system-edge"}}
 * @throws 全部缺失时抛错，并在 message 中列出已尝试路径
 */
function findChrome() {
  const tried = [];

  // 1) playwright 自带内核：版本与指纹最可控，优先使用
  const base = path.join(os.homedir(), "AppData", "Local", "ms-playwright");
  if (fs.existsSync(base)) {
    const dirs = fs
      .readdirSync(base)
      .filter((d) => /^chromium-\d+$/.test(d))
      .sort((a, b) => parseInt(b.slice(9), 10) - parseInt(a.slice(9), 10));
    for (const d of dirs) {
      for (const sub of ["chrome-win64", "chrome-win"]) {
        const p = path.join(base, d, sub, "chrome.exe");
        tried.push(p);
        if (fs.existsSync(p)) return { exe: p, source: "playwright" };
      }
    }
  } else {
    tried.push(base + " (directory not found)");
  }

  // 2) 系统 Chrome / Edge：Win10/11 自带 Edge，无需额外下载内核
  const pf = process.env.ProgramFiles || "C:\\Program Files";
  const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const lad = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const system = [
    path.join(pf, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(pf86, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(lad, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
  ];
  for (const p of system) {
    tried.push(p);
    if (fs.existsSync(p)) {
      return { exe: p, source: p.includes("Edge") ? "system-edge" : "system-chrome" };
    }
  }

  const err = new Error(
    "No usable browser kernel (playwright kernel / system Chrome / system Edge all missed). Tried:\n  " + tried.join("\n  "),
  );
  err.tried = tried;
  throw err;
}

/** 系统浏览器需要额外参数，避免首启引导页干扰自动化。 */
function kernelArgs(source) {
  return source.startsWith("system") ? ["--no-first-run", "--no-default-browser-check"] : [];
}

module.exports = { UA, defaultProfile, configuredProfile, resolveProfile, findChrome, kernelArgs };
