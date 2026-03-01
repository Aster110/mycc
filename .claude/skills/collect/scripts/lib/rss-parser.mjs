/**
 * RSS 解析共享工具
 * 提供 RSS/Atom XML 解析、24h 过滤、统一格式输出
 */

import { fetchWithRetry, stripHTML } from './fetcher.mjs';

/**
 * 抓取并解析 RSS/Atom feed
 * @param {string} url - Feed URL
 * @param {object} opts - { timeout, retries, hoursBack }
 * @returns {Promise<Array<{title, url, summary, pubDate, meta}>>}
 */
export async function fetchFeed(url, opts = {}) {
  const { timeout = 15000, retries = 2, hoursBack = 48 } = opts;

  const res = await fetchWithRetry(url, {
    timeout,
    retries,
    headers: {
      'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    },
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  const xml = await res.text();

  const items = parseXML(xml);

  // 过滤时间窗口
  const cutoff = Date.now() - hoursBack * 3600 * 1000;
  return items.filter(item => {
    if (!item.pubDate) return true; // 没日期的保留
    return new Date(item.pubDate).getTime() > cutoff;
  });
}

/**
 * 批量抓取多个 feed，合并结果
 * @param {Array<{name, url, enabled?}>} feeds - feed 配置列表
 * @param {object} opts - fetchFeed 选项
 * @returns {Promise<{items: Array, errors: Array}>}
 */
export async function fetchFeeds(feeds, opts = {}) {
  const enabledFeeds = feeds.filter(f => f.enabled !== false);
  const allItems = [];
  const errors = [];

  const results = await Promise.allSettled(
    enabledFeeds.map(async (feed) => {
      const items = await fetchFeed(feed.url, opts);
      return { feed, items };
    })
  );

  for (const result of results) {
    if (result.status === 'fulfilled') {
      const { feed, items } = result.value;
      for (const item of items) {
        allItems.push({
          ...item,
          meta: { ...item.meta, feedName: feed.name },
        });
      }
    } else {
      const feed = enabledFeeds[results.indexOf(result)];
      errors.push({ name: feed?.name, url: feed?.url, error: result.reason?.message });
      console.error(`[rss] ${feed?.name} failed: ${result.reason?.message}`);
    }
  }

  // 按发布时间倒序
  allItems.sort((a, b) => {
    const ta = a.pubDate ? new Date(a.pubDate).getTime() : 0;
    const tb = b.pubDate ? new Date(b.pubDate).getTime() : 0;
    return tb - ta;
  });

  return { items: allItems, errors };
}

/**
 * 简易 XML 解析（不依赖第三方库）
 * 支持 RSS 2.0 (<item>) 和 Atom (<entry>)
 */
function parseXML(xml) {
  const items = [];

  // 检测是 Atom 还是 RSS
  const isAtom = xml.includes('<feed') && xml.includes('<entry');

  if (isAtom) {
    const entries = xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
    for (const entry of entries) {
      items.push({
        title: extractTag(entry, 'title'),
        url: extractAtomLink(entry),
        summary: stripHTML(extractTag(entry, 'summary') || extractTag(entry, 'content')),
        pubDate: extractTag(entry, 'published') || extractTag(entry, 'updated'),
        meta: {
          author: extractTag(entry, 'name'),
        },
      });
    }
  } else {
    const rssItems = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || [];
    for (const item of rssItems) {
      items.push({
        title: extractTag(item, 'title'),
        url: extractTag(item, 'link') || extractTag(item, 'guid'),
        summary: stripHTML(extractTag(item, 'description')),
        pubDate: extractTag(item, 'pubDate') || extractTag(item, 'dc:date'),
        meta: {
          author: extractTag(item, 'dc:creator') || extractTag(item, 'author'),
          category: extractTag(item, 'category'),
        },
      });
    }
  }

  // 截断摘要
  for (const item of items) {
    if (item.summary && item.summary.length > 300) {
      item.summary = item.summary.slice(0, 300) + '...';
    }
    // 清理 title 中的 CDATA 残留
    if (item.title) {
      item.title = item.title.replace(/^\s+|\s+$/g, '');
    }
  }

  return items;
}

/** 提取 XML 标签内容（处理 CDATA） */
function extractTag(xml, tag) {
  // 处理带命名空间的标签
  const re = new RegExp(`<${tag}[^>]*>\\s*(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?\\s*<\\/${tag}>`, 'i');
  const m = xml.match(re);
  if (!m) return '';
  return m[1].replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, '').trim();
}

/** 提取 Atom link href */
function extractAtomLink(entry) {
  // 优先 rel="alternate"
  const altMatch = entry.match(/<link[^>]*rel\s*=\s*["']alternate["'][^>]*href\s*=\s*["']([^"']+)["']/i);
  if (altMatch) return altMatch[1];
  // fallback: 第一个 link
  const linkMatch = entry.match(/<link[^>]*href\s*=\s*["']([^"']+)["']/i);
  return linkMatch ? linkMatch[1] : '';
}
