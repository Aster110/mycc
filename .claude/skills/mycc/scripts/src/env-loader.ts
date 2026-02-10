/**
 * .env 文件加载 + PUBLIC_URL 检测
 *
 * 公网直连模式的核心：
 * - 读取 .env 文件中的 PUBLIC_URL
 * - 有 PUBLIC_URL → 公网模式（跳过 Tunnel）
 * - 没有 → 内网模式（启动 cloudflared）
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";

/**
 * 解析 .env 文件内容为 key-value 对
 *
 * 支持：
 * - 注释行（# 开头）
 * - 空行
 * - 值的双引号 / 单引号
 * - 值中包含等号
 */
export function parseEnvFile(content: string): Record<string, string> {
  const env: Record<string, string> = {};

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;

    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
    env[key] = value;
  }

  return env;
}

/**
 * 加载 PUBLIC_URL
 *
 * 优先级：
 *   1. process.env.PUBLIC_URL（环境变量直接传入）
 *   2. searchDirs 中的 .env 文件（按顺序查找，第一个找到即返回）
 *
 * 验证：
 *   - 必须 https:// 开头
 *   - 去除尾部斜杠
 *
 * @param searchDirs 搜索目录列表（按优先级排列）
 * @returns PUBLIC_URL 或 null
 */
export function loadPublicUrl(...searchDirs: string[]): string | null {
  // 环境变量优先
  if (process.env.PUBLIC_URL) {
    return validateUrl(process.env.PUBLIC_URL);
  }

  // 搜索 .env 文件
  for (const dir of searchDirs) {
    const envPath = join(dir, ".env");
    if (!existsSync(envPath)) continue;

    try {
      const content = readFileSync(envPath, "utf-8");
      const parsed = parseEnvFile(content);
      if (parsed.PUBLIC_URL) {
        return validateUrl(parsed.PUBLIC_URL);
      }
    } catch {
      // 读取失败，跳过
    }
  }

  return null;
}

/**
 * 验证并清理 URL
 * - 必须 https:// 开头
 * - 去除尾部斜杠和空格
 */
function validateUrl(raw: string): string | null {
  const url = raw.trim().replace(/\/+$/, "");
  if (!url.startsWith("https://")) {
    return null;
  }
  return url;
}
