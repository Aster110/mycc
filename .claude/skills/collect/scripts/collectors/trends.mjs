#!/usr/bin/env node
/**
 * 多平台热点 Collector
 * 数据源：NewsNow API（无需认证）
 * 从 fetch.py 移植为 Node.js
 *
 * 用法：
 *   node trends.mjs                                       # 采集
 *   node trends.mjs --extract /path/to/trends.json 3,8,15   # 按序号提取
 *   （无 --index：数据量小，直接读 JSON 即可）
 */

import { fetchJSON, makeResult, extractItems } from '../lib/fetcher.mjs';

// ── --extract 格式化 ──
function formatExtract(item, idx) {
  const m = item.meta || {};
  const lines = [];
  lines.push(`### [trends:${idx}] ${item.title}`);
  lines.push('');
  lines.push(`**平台**：${m.platform || '-'}`);
  if (item.url) lines.push(`**链接**：${item.url}`);
  lines.push('');
  return lines.join('\n');
}

const API_BASE = 'https://newsnow.busiyi.world/api/s';

const DEFAULT_PLATFORMS = ['weibo', 'zhihu', 'douyin'];

const PLATFORM_NAMES = {
  weibo: '微博',
  zhihu: '知乎',
  douyin: '抖音',
  'bilibili-hot-search': 'B站热搜',
  baidu: '百度热搜',
};

async function fetchPlatform(platformId, limit = 10) {
  const url = `${API_BASE}?id=${platformId}&latest`;
  const data = await fetchJSON(url, { timeout: 10000, retries: 1 });
  return (data.items || []).slice(0, limit);
}

async function main() {
  // --extract 模式
  const extFlag = process.argv.indexOf('--extract');
  if (extFlag !== -1) {
    const jsonPath = process.argv[extFlag + 1];
    const indices = process.argv[extFlag + 2];
    if (!jsonPath || !indices) { console.error('Usage: node trends.mjs --extract <json> <idx,idx,...>'); process.exit(1); }
    return extractItems(jsonPath, indices, formatExtract, 'trends');
  }

  const platforms = process.argv.slice(2).filter(a => !a.startsWith('--'));
  const toFetch = platforms.length > 0 ? platforms : DEFAULT_PLATFORMS;

  const allItems = [];

  // 并行采集所有平台
  const results = await Promise.allSettled(
    toFetch.map(async (pid) => {
      const items = await fetchPlatform(pid);
      return { pid, items };
    })
  );

  for (const result of results) {
    if (result.status === 'fulfilled') {
      const { pid, items } = result.value;
      for (const item of items) {
        allItems.push({
          title: item.title || '无标题',
          url: item.url || item.mobileUrl || '',
          summary: '',
          meta: {
            platform: PLATFORM_NAMES[pid] || pid,
            platformId: pid,
          },
        });
      }
    }
  }

  console.log(JSON.stringify(makeResult('trends', allItems, {
    platforms: toFetch,
  })));
}

main().catch(err => {
  console.log(JSON.stringify(makeResult('trends', [], { error: err.message })));
});
