#!/usr/bin/env node
/**
 * 小红书热点 Collector
 * 数据源：NewsNow API（无需认证）
 *
 * 用法：
 *   node xhs.mjs                                       # 采集
 *   node xhs.mjs --extract /path/to/xhs.json 3,8,15   # 按序号提取
 */

import { fetchJSON, makeResult, extractItems } from '../lib/fetcher.mjs';

// ── --extract 格式化 ──
function formatExtract(item, idx) {
  const m = item.meta || {};
  const lines = [];
  lines.push(`### [xhs:${idx}] ${item.title}`);
  lines.push('');
  if (item.url) lines.push(`**链接**：${item.url}`);
  lines.push('');
  return lines.join('\n');
}

const API_BASE = 'https://newsnow.busiyi.world/api/s';

async function fetchXHS(limit = 15) {
  const url = `${API_BASE}?id=xiaohongshu&latest`;
  const data = await fetchJSON(url, { timeout: 10000, retries: 1 });
  return (data.items || []).slice(0, limit);
}

async function main() {
  // --extract 模式
  const extFlag = process.argv.indexOf('--extract');
  if (extFlag !== -1) {
    const jsonPath = process.argv[extFlag + 1];
    const indices = process.argv[extFlag + 2];
    if (!jsonPath || !indices) { console.error('Usage: node xhs.mjs --extract <json> <idx,idx,...>'); process.exit(1); }
    return extractItems(jsonPath, indices, formatExtract, 'xhs');
  }

  // ── 采集模式 ──
  const items = await fetchXHS();

  const result = items.map(item => ({
    title: item.title || '无标题',
    url: item.url || item.mobileUrl || '',
    summary: '',
    meta: {
      platform: '小红书',
      platformId: 'xiaohongshu',
    },
  }));

  console.log(JSON.stringify(makeResult('xhs', result)));
}

main().catch(err => {
  console.log(JSON.stringify(makeResult('xhs', [], { error: err.message })));
});
