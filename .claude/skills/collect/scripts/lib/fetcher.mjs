/**
 * 共享 HTTP 工具
 * 提供带超时、重试的 fetch 封装
 */

/**
 * 带超时和重试的 fetch
 * @param {string} url
 * @param {object} options - fetch options + { timeout, retries }
 * @returns {Promise<Response>}
 */
export async function fetchWithRetry(url, options = {}) {
  const { timeout = 10000, retries = 1, ...fetchOpts } = options;

  for (let i = 0; i <= retries; i++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      const headers = {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json',
        ...fetchOpts.headers,
      };
      const res = await fetch(url, { ...fetchOpts, headers, signal: controller.signal });
      clearTimeout(timer);
      return res;
    } catch (err) {
      if (i === retries) throw err;
    }
  }
}

/**
 * fetch JSON
 * @param {string} url
 * @param {object} options
 * @returns {Promise<any>}
 */
export async function fetchJSON(url, options = {}) {
  const res = await fetchWithRetry(url, options);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}

/**
 * 读取 token 文件
 * @param {string} path
 * @returns {Promise<string>}
 */
export async function readToken(path) {
  const { readFile } = await import('fs/promises');
  return (await readFile(path, 'utf-8')).trim();
}

/**
 * 去除 HTML 标签
 * @param {string} html
 * @returns {string}
 */
export function stripHTML(html) {
  if (!html) return '';
  return html.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
}

/**
 * 构建标准输出对象
 * @param {string} source
 * @param {Array} items
 * @param {object} metadata
 * @returns {object}
 */
export function makeResult(source, items, metadata = {}) {
  return {
    source,
    timestamp: new Date().toISOString(),
    metadata: { total_fetched: items.length, error: null, ...metadata },
    items,
  };
}

/**
 * 公共提取逻辑：读 JSON → 按序号提取 → 调 formatFn → 输出 markdown
 * @param {string} jsonPath - JSON 文件路径
 * @param {string} indicesStr - 逗号分隔的序号（如 "4,12,19"）或 "all" 提取全部
 * @param {Function} formatFn - (item, idx) => string (markdown)
 * @param {string} sourceName - 源名称
 */
export async function extractItems(jsonPath, indicesStr, formatFn, sourceName) {
  const { readFile } = await import('fs/promises');
  const raw = await readFile(jsonPath, 'utf-8');
  const data = JSON.parse(raw);
  const items = data.items || [];
  const indices = indicesStr === 'all'
    ? items.map((_, i) => i)
    : indicesStr.split(',').map(Number);

  const lines = [`## ${sourceName}（提取 ${indices.length} 条 / 共 ${items.length} 条）`, ''];

  for (const idx of indices) {
    if (idx < 0 || idx >= items.length) {
      lines.push(`> ⚠️ ${sourceName}:${idx} 超出范围（共 ${items.length} 条）`);
      lines.push('');
      continue;
    }
    lines.push(formatFn(items[idx], idx));
  }

  console.log(lines.join('\n'));
}
