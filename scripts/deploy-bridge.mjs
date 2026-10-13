#!/usr/bin/env node
/**
 * deploy-bridge.mjs —— 桥接脚本一键同步分发工具
 *
 * 背景：douyin-bridge.js 存在三份运行副本，历史上靠手工复制，容易漂移：
 *   1. C:\Users\23699\bin\                        （命令行/开机桥接入口）
 *   2. ...\dist\douyin-sync-installer\bridge\     （安装器打包源）
 *   3. ...\Obsidian Vault\.obsidian\plugins\douyin-sync\ （插件随附副本）
 *
 * 本脚本把仓库根目录的桥接源文件（douyin-bridge.js / bridge-common.js）
 * 分发到上述三个目标目录，并用 sha256 逐文件复验，保证三副本字节级一致。
 *
 * 行为约定：
 *   - 默认 dry-run：只打印每个目标每个文件的 sha256 对比结果（相同/不同/目标缺失/目标独有），
 *     不写任何文件。加 --write 才实际复制。
 *   - 复制完成后立即对每个已复制文件做 sha256 复验，任一不匹配即报错并以非零码退出。
 *   - 目标目录中存在但仓库无源的文件（如 profile-path.txt、node_modules、bridge.log 等
 *     运行期/目标侧专属文件）一律不删除、不覆盖，仅在报告中标注为「目标独有，未动」。
 *
 * 用法：
 *   node scripts/deploy-bridge.mjs            # dry-run
 *   node scripts/deploy-bridge.mjs --write    # 实际复制
 *
 * 零依赖，Node >= 18。
 */

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");

/** 仓库内桥接源文件（相对仓库根）。仓库里有源的才分发。 */
const SOURCE_FILES = ["douyin-bridge.js", "bridge-common.js"];

/** 三个分发目标目录（绝对路径）。 */
const TARGET_DIRS = [
  "C:/Users/23699/bin",
  "C:/Users/23699/Desktop/抖音收藏1/dist/douyin-sync-installer/bridge",
  "C:/Users/23699/Documents/Obsidian Vault/.obsidian/plugins/douyin-sync",
];

function sha256(filePath) {
  const buf = readFileSync(filePath);
  return createHash("sha256").update(buf).digest("hex");
}

function main() {
  const writeMode = process.argv.includes("--write");
  const label = writeMode ? "WRITE" : "DRY-RUN";

  console.log("=== deploy-bridge (" + label + ") ===");
  console.log("repo root: " + REPO_ROOT);

  // 前置校验：源文件必须齐全
  const missingSources = SOURCE_FILES.filter((f) => !existsSync(join(REPO_ROOT, f)));
  if (missingSources.length > 0) {
    console.error("FATAL: missing source files in repo: " + missingSources.join(", "));
    process.exit(2);
  }

  // 源文件指纹
  const sourceHash = new Map();
  for (const f of SOURCE_FILES) {
    const abs = join(REPO_ROOT, f);
    sourceHash.set(f, { abs, hash: sha256(abs), size: statSync(abs).size });
  }
  console.log("sources:");
  for (const f of SOURCE_FILES) {
    const s = sourceHash.get(f);
    console.log("  " + f + "  " + s.hash.slice(0, 12) + "...  (" + s.size + " bytes)");
  }

  let failures = 0;

  for (const dir of TARGET_DIRS) {
    console.log("");
    console.log("--- target: " + dir);

    if (!existsSync(dir)) {
      if (writeMode) {
        mkdirSync(dir, { recursive: true });
        console.log("  created missing target directory");
      } else {
        console.log("  STATUS: target dir MISSING (dry-run: not created)");
      }
    }

    // 目标独有条目盘点（不在源集合内的一切文件/目录）：不删除不覆盖，仅报告
    const targetEntries = existsSync(dir)
      ? readdirSync(dir, { withFileTypes: true })
      : [];
    const orphanNames = [];
    for (const e of targetEntries) {
      if (SOURCE_FILES.includes(e.name)) continue;
      orphanNames.push(e.isDirectory() ? e.name + "/ (dir)" : e.name);
    }

    for (const f of SOURCE_FILES) {
      const src = sourceHash.get(f);
      const dst = join(dir, f);
      if (!existsSync(dst)) {
        console.log("  " + f + ": MISSING in target" + (writeMode ? " -> copy" : " (dry-run: would copy)"));
        if (writeMode) {
          try {
            copyFileSync(src.abs, dst);
            const verify = sha256(dst);
            if (verify !== src.hash) {
              console.log("    VERIFY: FAIL  expected " + src.hash + " got " + verify);
              failures++;
            } else {
              console.log("    VERIFY: OK    " + verify.slice(0, 12) + "...");
            }
          } catch (err) {
            console.log("    COPY ERROR: " + (err && err.message ? err.message : String(err)));
            failures++;
          }
        }
        continue;
      }
      const dstHash = sha256(dst);
      if (dstHash === src.hash) {
        console.log("  " + f + ": SAME   " + dstHash.slice(0, 12) + "...");
      } else {
        console.log("  " + f + ": DIFFER (src " + src.hash.slice(0, 12) + "... vs dst " + dstHash.slice(0, 12) + "...)");
        if (writeMode) {
          try {
            copyFileSync(src.abs, dst);
            const verify = sha256(dst);
            if (verify !== src.hash) {
              console.log("    VERIFY: FAIL  expected " + src.hash + " got " + verify);
              failures++;
            } else {
              console.log("    VERIFY: OK    " + verify.slice(0, 12) + "...");
            }
          } catch (err) {
            console.log("    COPY ERROR: " + (err && err.message ? err.message : String(err)));
            failures++;
          }
        }
      }
    }

    if (orphanNames.length > 0) {
      console.log("  target-only (untouched): " + orphanNames.join(", "));
    } else {
      console.log("  target-only (untouched): (none)");
    }
  }

  console.log("");
  if (writeMode) {
    if (failures > 0) {
      console.log("RESULT: " + failures + " file(s) FAILED verification");
      process.exit(1);
    }
    console.log("RESULT: all files written and sha256 verified");
  } else {
    console.log("RESULT: dry-run complete (no files written; re-run with --write to apply)");
  }
}

main();
