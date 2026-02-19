/**
 * Skills 模块
 * 扫描并解析 skill 目录
 */

import { readdirSync, readFileSync, existsSync, statSync } from "fs";
import { join } from "path";

export interface SkillItem {
  name: string;
  description: string;
}

// 缓存：key = dir, value = { items, timestamp, dirMtime }
const cache = new Map<string, { items: SkillItem[]; ts: number; dirMtime: number }>();
const CACHE_TTL = 60_000; // 60 秒

/**
 * 解析 SKILL.md 的 YAML frontmatter（零外部依赖）
 * 必须以 --- 开头，需要两个 --- 才有效
 */
export function parseFrontmatter(content: string): Record<string, string> {
  if (!content.startsWith("---\n")) return {};

  const endIdx = content.indexOf("\n---", 4);
  if (endIdx === -1) return {};

  const block = content.slice(4, endIdx);
  const result: Record<string, string> = {};

  for (const line of block.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (key) result[key] = value;
  }

  return result;
}

/**
 * 扫描指定目录下的 skills，返回按 name 排序的列表
 */
export function listSkills(skillsDir: string): SkillItem[] {
  if (!existsSync(skillsDir)) {
    cache.delete(skillsDir);
    return [];
  }

  // 检查缓存（用 mtime 防止目录被重建后返回旧数据）
  const dirMtime = statSync(skillsDir).mtimeMs;
  const cached = cache.get(skillsDir);
  if (cached && Date.now() - cached.ts < CACHE_TTL && cached.dirMtime === dirMtime) {
    return cached.items;
  }

  const entries = readdirSync(skillsDir, { withFileTypes: true });
  const items: SkillItem[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const skillMdPath = join(skillsDir, entry.name, "SKILL.md");
    if (!existsSync(skillMdPath)) continue;

    const content = readFileSync(skillMdPath, "utf-8");
    const meta = parseFrontmatter(content);

    items.push({
      name: meta.name || entry.name,
      description: meta.description || "",
    });
  }

  items.sort((a, b) => a.name.localeCompare(b.name));
  cache.set(skillsDir, { items, ts: Date.now(), dirMtime });
  return items;
}

/** 清除缓存（测试用） */
export function clearSkillsCache() {
  cache.clear();
}
