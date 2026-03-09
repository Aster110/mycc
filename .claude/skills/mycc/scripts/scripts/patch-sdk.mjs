#!/usr/bin/env node
/**
 * Patch SDK: 修复已知的 SDK / CLI bug
 *
 * Patch 1: sdk.mjs — settingSources 硬编码
 *   问题：settingSources:[] 导致 v2 Session 不加载 CLAUDE.md / Skills
 *   修复：settingSources:X.settingSources??["user","project"]
 *
 * Patch 2: cli.js — lP 函数不检查 isIdle（Agent Teams 死锁）
 *   问题：do-while 主循环用 lP 判断 task 是否活跃，不检查 isIdle
 *         → idle 的 teammate 被当成活跃 → 循环永不退出 → inbox 轮询永不执行
 *   修复：在 lP 返回 true 前加 if(A.isIdle)return!1
 *
 * 用法：node scripts/patch-sdk.mjs
 *       或通过 npm postinstall 自动执行
 */

import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_DIR = join(__dirname, "..", "node_modules", "@anthropic-ai", "claude-agent-sdk");
const SDK_PATH = join(SDK_DIR, "sdk.mjs");

// ============ Patch 1: sdk.mjs — settingSources ============

const SETTINGS_ORIGINAL = "settingSources:[]";
const SETTINGS_PREVIOUS = 'settingSources:X.settingSources??["user","project"]';
const SETTINGS_PATCHED = 'settingSources:X.settingSources??["user","project","local"]';

try {
  const source = readFileSync(SDK_PATH, "utf-8");

  if (source.includes(SETTINGS_PATCHED)) {
    console.log("[patch-sdk] sdk.mjs: settingSources already patched.");
  } else if (source.includes(SETTINGS_PREVIOUS)) {
    const patched = source.replace(SETTINGS_PREVIOUS, SETTINGS_PATCHED);
    writeFileSync(SDK_PATH, patched, "utf-8");
    console.log("[patch-sdk] sdk.mjs: upgraded settingSources default to include local.");
  } else if (source.includes(SETTINGS_ORIGINAL)) {
    const patched = source.replace(SETTINGS_ORIGINAL, SETTINGS_PATCHED);
    writeFileSync(SDK_PATH, patched, "utf-8");
    console.log("[patch-sdk] sdk.mjs: patched settingSources:[] → settingSources:X.settingSources??[\"user\",\"project\",\"local\"]");
  } else {
    console.warn("[patch-sdk] sdk.mjs: settingSources pattern not found (SDK may have fixed it).");
  }
} catch (err) {
  console.error("[patch-sdk] sdk.mjs patch failed:", err.message);
}

// ============ Patch 2: cli.js — lP 函数 isIdle 检查 ============
// CLI 2.1.63 的 lP 不检查 isIdle，导致 Agent Teams do-while 死锁

import { execSync } from "child_process";

function findCliPath() {
  // 优先用 CLAUDE_PATH 环境变量
  if (process.env.CLAUDE_PATH) return process.env.CLAUDE_PATH;
  try {
    const which = execSync("which claude", { encoding: "utf-8" }).trim();
    // 解析 symlink
    const resolved = execSync(`readlink -f "${which}" 2>/dev/null || realpath "${which}" 2>/dev/null || echo "${which}"`, { encoding: "utf-8" }).trim();
    return resolved;
  } catch {
    return null;
  }
}

const LP_ORIGINAL = 'function lP(A){if(A.status!=="running"&&A.status!=="pending")return!1;if("isBackgrounded"in A&&A.isBackgrounded===!1)return!1;return!0}';
const LP_PATCHED  = 'function lP(A){if(A.status!=="running"&&A.status!=="pending")return!1;if("isBackgrounded"in A&&A.isBackgrounded===!1)return!1;if(A.isIdle)return!1;return!0}';

const cliPath = findCliPath();
if (cliPath) {
  try {
    const cliSource = readFileSync(cliPath, "utf-8");
    if (cliSource.includes(LP_PATCHED)) {
      console.log("[patch-sdk] cli.js: lP already patched.");
    } else if (!cliSource.includes(LP_ORIGINAL)) {
      console.warn("[patch-sdk] cli.js: lP pattern not found (CLI may have fixed it or function renamed).");
    } else {
      const patched = cliSource.replace(LP_ORIGINAL, LP_PATCHED);
      writeFileSync(cliPath, patched, "utf-8");
      console.log("[patch-sdk] cli.js: patched lP → added isIdle check for Agent Teams.");
    }
  } catch (err) {
    // CLI 文件可能需要 sudo 权限
    console.warn(`[patch-sdk] cli.js patch failed (may need sudo): ${err.message}`);
  }
} else {
  console.warn("[patch-sdk] cli.js: claude CLI not found, skipping lP patch.");
}

console.log("[patch-sdk] Done.");
