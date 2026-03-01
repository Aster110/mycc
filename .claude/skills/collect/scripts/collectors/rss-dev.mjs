#!/usr/bin/env node
/**
 * 开发者 RSS Collector
 * 数据源：阮一峰的网络日志、少数派
 *
 * 用法：
 *   node rss-dev.mjs                                           # 采集（48h 内）
 *   node rss-dev.mjs --extract /path/to/rss-dev.json 3,8      # 按序号提取
 */

import { fetchFeeds } from '../lib/rss-parser.mjs';
import { makeResult, extractItems } from '../lib/fetcher.mjs';

const SOURCE_NAME = 'rss-dev';

const FEEDS = [
  { name: '阮一峰的网络日志', url: 'https://www.ruanyifeng.com/blog/atom.xml', enabled: true },
  { name: '少数派', url: 'https://sspai.com/feed', enabled: true },
];

// ── --extract 格式化 ──
function formatExtract(item, idx) {
  const m = item.meta || {};
  const lines = [];
  lines.push(`### [rss-dev:${idx}] ${item.title}`);
  lines.push('');
  lines.push(`**来源**：${m.feedName || '-'} | **日期**：${item.pubDate || '-'}`);
  lines.push(`**链接**：${item.url || '-'}`);
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
    if (!jsonPath || !indices) {
      console.error('Usage: node rss-dev.mjs --extract <json> <idx,idx,...>');
      process.exit(1);
    }
    return extractItems(jsonPath, indices, formatExtract, SOURCE_NAME);
  }

  // --index 模式（仅输出标题列表，便于人工筛选）
  const indexFlag = process.argv.includes('--index');

  const { items, errors } = await fetchFeeds(FEEDS, { hoursBack: 48 });

  if (indexFlag) {
    items.forEach((item, idx) => {
      const m = item.meta || {};
      console.log(`[${idx}] [${m.feedName || '-'}] ${item.title}`);
    });
    return;
  }

  console.log(JSON.stringify(makeResult(SOURCE_NAME, items, {
    feeds: FEEDS.filter(f => f.enabled).map(f => f.name),
    errors: errors.length > 0 ? errors : undefined,
  })));
}

main().catch(err => {
  console.log(JSON.stringify(makeResult(SOURCE_NAME, [], { error: err.message })));
});
