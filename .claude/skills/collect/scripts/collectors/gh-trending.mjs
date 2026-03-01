#!/usr/bin/env node
/**
 * GitHub Trending Collector
 * 直接抓取 GitHub Trending 页面，解析 HTML
 * 备选 API: gitterapp.com (已 404)
 *
 * 用法：
 *   node gh-trending.mjs                                         # 采集
 *   node gh-trending.mjs --extract /path/to/gh-trending.json 0,2,5  # 按序号提取
 *   （无 --index：数据量小，直接读 JSON 即可）
 */

import { execSync } from 'child_process';
import { makeResult, extractItems } from '../lib/fetcher.mjs';

// ── --extract 格式化 ──
function formatExtract(item, idx) {
  const m = item.meta || {};
  const lines = [];
  lines.push(`### [gh-trending:${idx}] ${item.title}`);
  lines.push('');
  lines.push(`**语言**：${m.language || '-'} | **总星**：${m.stars?.toLocaleString() || 0} | **今日**：+${m.todayStars || 0} | **Forks**：${m.forks?.toLocaleString() || 0}`);
  if (item.url) lines.push(`**链接**：${item.url}`);
  lines.push('');
  if (item.summary) {
    lines.push(item.summary);
    lines.push('');
  }
  return lines.join('\n');
}

const TRENDING_URL = 'https://github.com/trending?since=daily';

function fetchPage() {
  // GitHub 拦截 Node fetch，用 curl 兜底
  return execSync(
    `curl -sS --max-time 30 -H "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36" -H "Accept: text/html" "${TRENDING_URL}"`,
    { encoding: 'utf-8', maxBuffer: 5 * 1024 * 1024 }
  );
}

function parseHTML(html) {
  const repos = [];
  // 匹配每个 repo 条目：<article class="Box-row">
  const articleRegex = /<article class="Box-row">([\s\S]*?)<\/article>/g;
  let match;

  while ((match = articleRegex.exec(html)) !== null) {
    const block = match[1];

    // 提取 repo：stargazers 链接格式 /author/name/stargazers
    const stargazersMatch = block.match(/href="\/([^/]+\/[^/]+)\/stargazers"/);
    if (!stargazersMatch) continue;
    const fullName = stargazersMatch[1].trim();
    const [author, name] = fullName.split('/');

    // 提取描述
    const descMatch = block.match(/<p class="col-9[^"]*"[^>]*>([\s\S]*?)<\/p>/);
    const description = descMatch ? descMatch[1].replace(/<[^>]+>/g, '').trim() : '';

    // 提取语言
    const langMatch = block.match(/itemprop="programmingLanguage">(.*?)<\/span>/);
    const language = langMatch ? langMatch[1].trim() : '';

    // 提取总星标（数字在 SVG 之后、</a> 之前，需跨行匹配）
    const starsMatch = block.match(/href="\/[^"]+\/stargazers"[\s\S]*?<\/svg>\s*([\d,]+)\s*<\/a>/);
    const stars = starsMatch ? parseInt(starsMatch[1].replace(/,/g, ''), 10) : 0;

    // 提取 forks（同上，SVG 后跟数字）
    const forksMatch = block.match(/href="\/[^"]+\/forks"[\s\S]*?<\/svg>\s*([\d,]+)\s*<\/a>/);
    const forks = forksMatch ? parseInt(forksMatch[1].replace(/,/g, ''), 10) : 0;

    // 提取今日星标
    const todayMatch = block.match(/([\d,]+)\s+stars?\s+today/i);
    const todayStars = todayMatch ? parseInt(todayMatch[1].replace(/,/g, ''), 10) : 0;

    repos.push({
      title: `${author}/${name}`,
      url: `https://github.com/${author}/${name}`,
      summary: description,
      meta: {
        author: author || '',
        language: language || '',
        stars,
        forks,
        todayStars,
      },
    });
  }

  return repos;
}

async function main() {
  // --extract 模式
  const extFlag = process.argv.indexOf('--extract');
  if (extFlag !== -1) {
    const jsonPath = process.argv[extFlag + 1];
    const indices = process.argv[extFlag + 2];
    if (!jsonPath || !indices) { console.error('Usage: node gh-trending.mjs --extract <json> <idx,idx,...>'); process.exit(1); }
    return extractItems(jsonPath, indices, formatExtract, 'gh-trending');
  }

  let html;
  try {
    html = fetchPage();
  } catch (err) {
    console.log(JSON.stringify(makeResult('gh-trending', [], { error: err.message })));
    return;
  }

  const repos = parseHTML(html);
  console.log(JSON.stringify(makeResult('gh-trending', repos)));
}

main().catch(err => {
  console.log(JSON.stringify(makeResult('gh-trending', [], { error: err.message })));
});
