#!/usr/bin/env node
/**
 * 风向标 Collector
 * 数据源：生财有术 API
 * 需要 token：.claude/skills/collect/.fxb-token（或环境变量 FXB_TOKEN_PATH）
 *
 * 用法：
 *   node fxb.mjs                                # 采集，输出 JSON 到 stdout
 *   node fxb.mjs --index /path/to/fxb.json      # 读 JSON，输出 markdown 索引到 stdout
 *   node fxb.mjs --extract /path/to/fxb.json 4,12,19  # 按序号提取全文，输出 markdown
 */

import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFile } from 'fs/promises';
import { fetchWithRetry, readToken, stripHTML, makeResult, extractItems } from '../lib/fetcher.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// skills/collect/scripts/collectors → skill 根（向上 2 层）
const SKILL_ROOT = resolve(__dirname, '../..');
const TOKEN_PATH = process.env.FXB_TOKEN_PATH || resolve(SKILL_ROOT, '.fxb-token');
const API_URL = 'https://scys.com/shengcai-web/client/homePage/searchTopic';
const WARN_DAYS = 2; // 提前几天预警
const MAX_PAGES = 10; // 安全上限

/** 计算昨天的时间范围（CST UTC+8），返回 { start, end } Unix 秒 */
function getYesterdayRange() {
  const now = new Date();
  const cstMs = now.getTime() + 8 * 3600_000;
  const cstDate = new Date(cstMs);
  // 今天 00:00 CST 对应的 UTC 毫秒
  const todayMidnightUTC = Date.UTC(cstDate.getUTCFullYear(), cstDate.getUTCMonth(), cstDate.getUTCDate()) - 8 * 3600_000;
  return {
    start: (todayMidnightUTC - 24 * 3600_000) / 1000,
    end: todayMidnightUTC / 1000 - 1,
  };
}

/** 解码 JWT 检查 token_expire，返回 { daysLeft, expireDate } 或 null */
function checkTokenExpiry(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    const expireAt = payload.token_expire;
    if (!expireAt) return null;
    const daysLeft = (expireAt - Math.floor(Date.now() / 1000)) / 86400;
    if (daysLeft <= WARN_DAYS) {
      return {
        daysLeft: Math.max(0, daysLeft).toFixed(1),
        expireDate: new Date(expireAt * 1000).toISOString().split('T')[0],
      };
    }
    return null;
  } catch {
    return null;
  }
}

async function fetchPage(token, pageIndex) {
  const res = await fetchWithRetry(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-token': token,
    },
    body: JSON.stringify({
      pageIndex,
      pageSize: 20,
      isSimpleModel: false,
      includeMenuIdList: [21272],
      orderBy: 'gmt_create',
      orderDirection: 'desc',
      isHot: false,
      pageScene: 'fxb',
      groupId: null,
    }),
    timeout: 15000,
  });
  return res.json();
}

// ── --extract 模式：按序号提取全文 ──
function formatExtract(item, idx) {
  const m = item.meta || {};
  const lines = [];
  lines.push(`### [fxb:${idx}] ${item.title}`);
  lines.push('');
  if (m.author) lines.push(`**作者**：${m.author} | **阅读**：${m.reads || 0} | **点赞**：${m.likes || 0} | **评论**：${m.comments || 0}`);
  if (m.tags?.length) lines.push(`**标签**：${m.tags.map(t => t.name).join('、')}`);
  if (item.url) lines.push(`**链接**：${item.url}`);
  lines.push('');
  const content = (m.content || item.summary || '').replace(/<[^>]+>/g, '').trim();
  if (content) {
    lines.push(content);
    lines.push('');
  }
  return lines.join('\n');
}

// ── --index 模式：读 JSON，输出 markdown 索引 ──
async function generateIndex(jsonPath) {
  const raw = await readFile(jsonPath, 'utf-8');
  const data = JSON.parse(raw);
  const items = data.items || [];

  const lines = [`## 风向标索引（${items.length} 条）`, ''];

  if (data.metadata?.error) {
    lines.push(`> ⚠️ 错误：${data.metadata.error}`);
    console.log(lines.join('\n'));
    return;
  }
  if (data.metadata?.warning) {
    lines.push(`> ⚠️ ${data.metadata.warning}（${data.metadata.daysLeft} 天后过期）`);
    lines.push('');
  }

  lines.push('| # | 标题 | 作者 | 互动 | 标签 |');
  lines.push('|---|------|------|------|------|');

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const m = it.meta || {};
    const stats = [];
    if (m.reads) stats.push(`👀${m.reads}`);
    if (m.likes) stats.push(`👍${m.likes}`);
    if (m.comments) stats.push(`💬${m.comments}`);
    const tags = (m.tags || []).map(t => t.name).join('/');
    lines.push(`| ${i} | ${it.title.substring(0, 60)} | ${m.author || ''} | ${stats.join(' ') || '-'} | ${tags || '-'} |`);
  }

  lines.push('');
  console.log(lines.join('\n'));
}

async function main() {
  // --extract 模式
  const extFlag = process.argv.indexOf('--extract');
  if (extFlag !== -1) {
    const jsonPath = process.argv[extFlag + 1];
    const indices = process.argv[extFlag + 2];
    if (!jsonPath || !indices) { console.error('Usage: node fxb.mjs --extract <fxb.json> <idx,idx,...>'); process.exit(1); }
    return extractItems(jsonPath, indices, formatExtract, 'fxb');
  }

  // --index 模式
  const idxFlag = process.argv.indexOf('--index');
  if (idxFlag !== -1) {
    const jsonPath = process.argv[idxFlag + 1];
    if (!jsonPath) { console.error('Usage: node fxb.mjs --index <fxb.json>'); process.exit(1); }
    return generateIndex(jsonPath);
  }

  // 读 token
  let token;
  try {
    token = await readToken(TOKEN_PATH);
  } catch {
    console.log(JSON.stringify(makeResult('fxb', [], { error: 'token_file_not_found' })));
    return;
  }

  // 预检 token 过期时间
  const expiry = checkTokenExpiry(token);

  // 按时间范围拉取昨天的数据（newest first，遇到前天的就停）
  const { start: yesterdayStart, end: yesterdayEnd } = getYesterdayRange();
  const allItems = [];
  let reachedOlder = false;

  for (let pageIndex = 1; pageIndex <= MAX_PAGES && !reachedOlder; pageIndex++) {
    try {
      const data = await fetchPage(token, pageIndex);
      if (!data.success) {
        console.log(JSON.stringify(makeResult('fxb', [], { error: 'token_expired' })));
        return;
      }
      const items = data.data?.list || data.data?.items || [];
      if (items.length === 0) break;

      for (const item of items) {
        const t = item.topicDTO || {};
        const createTime = t.gmtCreate || 0;
        if (createTime > yesterdayEnd) continue;       // 今天的，跳过
        if (createTime < yesterdayStart) { reachedOlder = true; break; } // 前天的，停
        allItems.push(item);
      }
    } catch (err) {
      console.error(`[fxb] page ${pageIndex} failed: ${err.message}`);
    }
  }

  // 映射为统一格式（API 返回嵌套结构：topicDTO + topicUserDTO）
  const normalized = allItems.map(item => {
    const t = item.topicDTO || {};
    const u = item.topicUserDTO || {};
    const content = t.articleContent || '';
    return {
      title: t.showTitle || content.substring(0, 80) || '无标题',
      url: item.detailUrl || `https://articles.zsxq.com/id_${t.topicId}.html`,
      summary: stripHTML(t.aiSummaryContent || ''),
      meta: {
        author: u.name || '',
        likes: t.likeCount || 0,
        comments: t.commentsCount || 0,
        reads: t.readingCount || 0,
        tags: (t.menuList || []).map(tag => ({ id: tag.key, name: tag.value })),
        content,
        createTime: t.gmtCreate || '',
      },
    };
  });

  const meta = expiry
    ? { warning: 'token_expiring_soon', daysLeft: expiry.daysLeft, expireDate: expiry.expireDate }
    : {};
  console.log(JSON.stringify(makeResult('fxb', normalized, meta)));
}

main().catch(err => {
  console.log(JSON.stringify(makeResult('fxb', [], { error: err.message })));
});
