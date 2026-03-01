#!/usr/bin/env node
/**
 * 创业/商业资讯 RSS Collector
 * 数据源：TechCrunch、极客公园等 RSS Feed
 *
 * 用法：
 *   node rss-startup.mjs                                                # 采集（默认 48h）
 *   node rss-startup.mjs --extract /path/to/rss-startup.json 3,8       # 按序号提取
 *   node rss-startup.mjs --index /path/to/rss-startup.json             # 输出索引列表
 */

import { fetchFeeds } from '../lib/rss-parser.mjs';
import { makeResult, extractItems } from '../lib/fetcher.mjs';

const SOURCE_NAME = 'rss-startup';

const FEEDS = [
  { name: 'TechCrunch', url: 'https://techcrunch.com/feed/', enabled: true },
  { name: '极客公园', url: 'http://www.geekpark.net/rss', enabled: true },
  { name: '36氪', url: 'https://36kr.com/feed', enabled: false }, // 预留
  { name: '虎嗅网', url: 'https://www.huxiu.com/rss/0.xml', enabled: false }, // 预留
];

// ── --extract 格式化 ──
function formatExtract(item, idx) {
  const m = item.meta || {};
  const lines = [];
  lines.push(`### [rss-startup:${idx}] ${item.title}`);
  lines.push('');
  lines.push(`**来源**：${m.feedName || '-'} | **日期**：${item.pubDate || '-'}`);
  if (item.url) lines.push(`**链接**：${item.url}`);
  lines.push('');
  if (item.summary) lines.push(item.summary);
  lines.push('');
  return lines.join('\n');
}

// ── --index 格式化（输出简洁索引，便于快速浏览选条）──
function formatIndex(items) {
  const lines = [`## ${SOURCE_NAME} 索引（共 ${items.length} 条）`, ''];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const m = item.meta || {};
    const date = item.pubDate ? item.pubDate.slice(0, 10) : '-';
    lines.push(`[${i}] [${m.feedName || '-'}] ${item.title} (${date})`);
  }
  console.log(lines.join('\n'));
}

async function main() {
  // --extract 模式
  const extFlag = process.argv.indexOf('--extract');
  if (extFlag !== -1) {
    const jsonPath = process.argv[extFlag + 1];
    const indices = process.argv[extFlag + 2];
    if (!jsonPath || !indices) {
      console.error('Usage: node rss-startup.mjs --extract <json> <idx,idx,...>');
      process.exit(1);
    }
    return extractItems(jsonPath, indices, formatExtract, SOURCE_NAME);
  }

  // --index 模式
  const idxFlag = process.argv.indexOf('--index');
  if (idxFlag !== -1) {
    const jsonPath = process.argv[idxFlag + 1];
    if (!jsonPath) {
      console.error('Usage: node rss-startup.mjs --index <json>');
      process.exit(1);
    }
    const { readFile } = await import('fs/promises');
    const raw = await readFile(jsonPath, 'utf-8');
    const data = JSON.parse(raw);
    return formatIndex(data.items || []);
  }

  // 采集模式（默认）
  const { items, errors } = await fetchFeeds(FEEDS, { hoursBack: 48 });

  const metadata = {
    feeds: FEEDS.filter(f => f.enabled !== false).map(f => f.name),
    errors: errors.length > 0 ? errors : undefined,
  };

  console.log(JSON.stringify(makeResult(SOURCE_NAME, items, metadata)));
}

main().catch(err => {
  console.log(JSON.stringify(makeResult(SOURCE_NAME, [], { error: err.message })));
});
