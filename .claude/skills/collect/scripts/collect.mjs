#!/usr/bin/env node
/**
 * 采集系统协调器
 * 自动发现 collectors/*.mjs，并行运行，合并输出统一 JSON
 *
 * 用法：
 *   node collect.mjs                    # 运行全部 collector
 *   node collect.mjs --sources fxb,trends  # 只运行指定的
 *   node collect.mjs --save /path/to/dir   # 同时保存各源 JSON 到目录
 */

import { readdir } from 'fs/promises';
import { spawn } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { writeFile, mkdir } from 'fs/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COLLECTORS_DIR = join(__dirname, 'collectors');
const TIMEOUT_MS = 60000; // 单个 collector 最大 60 秒

// 解析命令行参数
function parseArgs() {
  const args = process.argv.slice(2);
  const result = { sources: null, saveDir: null };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--sources' && args[i + 1]) {
      result.sources = args[++i].split(',');
    } else if (args[i] === '--save' && args[i + 1]) {
      result.saveDir = args[++i];
    }
  }

  return result;
}

// 运行单个 collector，返回解析后的 JSON
function runCollector(scriptPath) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';

    const proc = spawn('node', [scriptPath], {
      timeout: TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });

    proc.on('close', (code) => {
      if (stderr) console.error(stderr.trim());

      try {
        resolve(JSON.parse(stdout));
      } catch {
        const name = scriptPath.split('/').pop().replace('.mjs', '');
        resolve({
          source: name,
          timestamp: new Date().toISOString(),
          metadata: { total_fetched: 0, error: `parse_error: exit code ${code}` },
          items: [],
        });
      }
    });

    proc.on('error', (err) => {
      const name = scriptPath.split('/').pop().replace('.mjs', '');
      resolve({
        source: name,
        timestamp: new Date().toISOString(),
        metadata: { total_fetched: 0, error: err.message },
        items: [],
      });
    });
  });
}

async function main() {
  const { sources: requestedSources, saveDir } = parseArgs();

  // 发现所有 collector
  const files = (await readdir(COLLECTORS_DIR))
    .filter(f => f.endsWith('.mjs') && !f.startsWith('_'))
    .sort();

  // 过滤
  const toRun = requestedSources
    ? files.filter(f => requestedSources.includes(f.replace('.mjs', '')))
    : files;

  if (toRun.length === 0) {
    console.error('[collect] No collectors to run');
    console.log(JSON.stringify({ collected_at: new Date().toISOString(), sources: [] }));
    return;
  }

  console.error(`[collect] Running ${toRun.length} collectors: ${toRun.map(f => f.replace('.mjs', '')).join(', ')}`);

  // 并行运行
  const results = await Promise.all(
    toRun.map(f => runCollector(join(COLLECTORS_DIR, f)))
  );

  // 保存各源 JSON（如果指定了 --save）
  if (saveDir) {
    await mkdir(saveDir, { recursive: true });
    for (const r of results) {
      await writeFile(
        join(saveDir, `${r.source}.json`),
        JSON.stringify(r, null, 2),
        'utf-8'
      );
    }
    console.error(`[collect] Saved raw JSON to ${saveDir}`);
  }

  // 统计
  for (const r of results) {
    const status = r.metadata?.error ? `error: ${r.metadata.error}` : `${r.metadata?.total_fetched || 0} items`;
    console.error(`[collect]   ${r.source}: ${status}`);
  }

  // 输出合并结果
  const output = {
    collected_at: new Date().toISOString(),
    sources: results,
  };

  console.log(JSON.stringify(output));
}

main().catch(err => {
  console.error(`[collect] Fatal: ${err.message}`);
  process.exit(1);
});
