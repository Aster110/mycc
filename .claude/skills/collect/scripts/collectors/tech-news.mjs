#!/usr/bin/env node
/**
 * 海外技术社区 Collector
 * 数据源：NewsNow API（无需认证）
 * 覆盖：Hacker News、Product Hunt、V2EX
 *
 * 用法：
 *   node tech-news.mjs                                           # 采集
 *   node tech-news.mjs --extract /path/to/tech-news.json 3,8     # 按序号提取
 */

import { fetchJSON, makeResult, extractItems } from '../lib/fetcher.mjs';

// ── --extract 格式化 ──
function formatExtract(item, idx) {
  const m = item.meta || {};
  const lines = [];
  lines.push(`### [tech-news:${idx}] ${item.title}`);
  lines.push('');
  lines.push(`**平台**：${m.platform || '-'}`);
  if (item.url) lines.push(`**链接**：${item.url}`);
  lines.push('');
  return lines.join('\n');
}

const API_BASE = 'https://newsnow.busiyi.world/api/s';

const DEFAULT_PLATFORMS = ['hackernews', 'producthunt', 'v2ex'];

const PLATFORM_NAMES = {
  hackernews: 'Hacker News',
  producthunt: 'Product Hunt',
  v2ex: 'V2EX',
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
    if (!jsonPath || !indices) { console.error('Usage: node tech-news.mjs --extract <json> <idx,idx,...>'); process.exit(1); }
    return extractItems(jsonPath, indices, formatExtract, 'tech-news');
  }

  const platforms = process.argv.slice(2).filter(a => !a.startsWith('--'));
  const toFetch = platforms.length > 0 ? platforms : DEFAULT_PLATFORMS;

  const allItems = [];

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

  console.log(JSON.stringify(makeResult('tech-news', allItems, {
    platforms: toFetch,
  })));
}

main().catch(err => {
  console.log(JSON.stringify(makeResult('tech-news', [], { error: err.message })));
});
