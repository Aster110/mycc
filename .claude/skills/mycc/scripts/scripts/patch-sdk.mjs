#!/usr/bin/env node
/**
 * Patch SDK: 修复 v2 Session API 的 settingSources 硬编码问题
 *
 * 问题：sdk.mjs 中 V9 构造函数硬编码 settingSources:[]
 *       导致 v2 Session 永远不加载项目设置（CLAUDE.md / Skills）
 *
 * 修复：将 settingSources:[] 替换为 settingSources:X.settingSources??["user","project"]
 *       使得默认加载用户设置和项目设置，同时允许调用方自定义
 *
 * 用法：node scripts/patch-sdk.mjs
 *       或通过 npm postinstall 自动执行
 */

import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_PATH = join(__dirname, "..", "node_modules", "@anthropic-ai", "claude-agent-sdk", "sdk.mjs");

const ORIGINAL = "settingSources:[]";
const PATCHED = 'settingSources:X.settingSources??["user","project"]';

try {
  const source = readFileSync(SDK_PATH, "utf-8");

  if (source.includes(PATCHED)) {
    console.log("[patch-sdk] Already patched, skipping.");
    process.exit(0);
  }

  if (!source.includes(ORIGINAL)) {
    console.warn("[patch-sdk] Warning: original pattern not found. SDK may have been updated.");
    console.warn("[patch-sdk] Looking for settingSources to verify...");
    if (source.includes("settingSources")) {
      console.warn("[patch-sdk] settingSources exists but pattern changed. Manual review needed.");
    }
    process.exit(0);
  }

  // 只替换第一个匹配（V9 构造函数中的）
  const patched = source.replace(ORIGINAL, PATCHED);
  writeFileSync(SDK_PATH, patched, "utf-8");

  console.log("[patch-sdk] Patched settingSources:[] → settingSources:X.settingSources??[\"user\",\"project\"]");
  console.log("[patch-sdk] Skills and CLAUDE.md will now be loaded in v2 Session mode.");
} catch (err) {
  console.error("[patch-sdk] Failed to patch SDK:", err.message);
  // 不要 exit(1)，避免阻塞 npm install
  process.exit(0);
}
