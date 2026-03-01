#!/usr/bin/env node
/**
 * Collector 模板
 *
 * 每个 collector 是一个自治单元，包含三种模式：
 *
 *   1. 采集模式（必须）：拉取数据，输出 JSON 到 stdout
 *      node {source}.mjs
 *
 *   2. 提取模式（必须）：从 JSON 按序号提取全文，输出 markdown
 *      node {source}.mjs --extract <json-path> <idx,idx,...>
 *
 *   3. 索引模式（可选，数据量大时）：从 JSON 生成紧凑标题索引
 *      node {source}.mjs --index <json-path>
 *
 * 什么时候需要 --index？
 *   - 数据量大（>20 条或含长文），AI 无法一次读完 JSON
 *   - 例：fxb 60 条含全文 → 74K JSON → 需要索引
 *   - 例：gh-trending 11 条 → 4K JSON → 不需要索引
 *
 * 新建 collector 步骤：
 *   1. 复制此文件，改名为 {source}.mjs
 *   2. 实现采集逻辑 + formatExtract 函数
 *   3. 如果数据量大，加 --index 模式
 *   4. 测试：node {source}.mjs | python3 -m json.tool
 *   5. 完成。协调器会自动发现并运行。
 *
 * JSON 输出格式：
 * {
 *   "source": "my-source",
 *   "timestamp": "2026-02-16T08:00:00.000Z",
 *   "metadata": { "total_fetched": 10, "error": null },
 *   "items": [
 *     { "title": "...", "url": "...", "summary": "...", "meta": { ... } }
 *   ]
 * }
 */

import { fetchJSON, makeResult, extractItems } from '../lib/fetcher.mjs';

const SOURCE_NAME = '_template'; // 改成你的 source 名

// ── --extract 格式化（必须实现）──
function formatExtract(item, idx) {
  const m = item.meta || {};
  const lines = [];
  lines.push(`### [${SOURCE_NAME}:${idx}] ${item.title}`);
  lines.push('');
  // TODO: 根据你的数据结构自定义输出格式
  if (item.url) lines.push(`**链接**：${item.url}`);
  if (item.summary) {
    lines.push('');
    lines.push(item.summary);
  }
  lines.push('');
  return lines.join('\n');
}

async function main() {
  // --extract 模式
  const extFlag = process.argv.indexOf('--extract');
  if (extFlag !== -1) {
    const jsonPath = process.argv[extFlag + 1];
    const indices = process.argv[extFlag + 2];
    if (!jsonPath || !indices) { console.error(`Usage: node ${SOURCE_NAME}.mjs --extract <json> <idx,idx,...>`); process.exit(1); }
    return extractItems(jsonPath, indices, formatExtract, SOURCE_NAME);
  }

  // --index 模式（可选，数据量大时实现）
  // const idxFlag = process.argv.indexOf('--index');
  // if (idxFlag !== -1) { ... }

  // ── 采集模式 ──
  // TODO: 实现采集逻辑
  const items = [];

  // 示例：
  // const data = await fetchJSON('https://api.example.com/data');
  // const items = data.map(item => ({
  //   title: item.title,
  //   url: item.url,
  //   summary: item.description || '',
  //   meta: { author: item.author },
  // }));

  console.log(JSON.stringify(makeResult(SOURCE_NAME, items)));
}

main().catch(err => {
  console.log(JSON.stringify(makeResult(SOURCE_NAME, [], { error: err.message })));
});
