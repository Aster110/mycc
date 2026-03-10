/**
 * Agent 解析器
 * 解析 agentId 为 Agent 目录路径
 */

import { existsSync, readdirSync } from "fs";
import { join } from "path";

/**
 * 解析 agentId 为 Agent 目录
 * @param {string} agentId Agent ID
 * @param {string} agentsDir Agents 根目录
 * @returns {string|null} Agent 目录路径，不存在返回 null
 */
export function resolveAgentDir(agentId, agentsDir) {
  if (!agentId || !agentsDir) return null;

  // 直接用 agentId 作为目录名
  const agentDir = join(agentsDir, agentId);
  if (existsSync(agentDir)) {
    return agentDir;
  }

  return null;
}

/**
 * 列出所有 Agents
 * @param {string} agentsDir Agents 根目录
 * @returns {string[]} Agent 列表
 */
export function listAgents(agentsDir) {
  if (!agentsDir) return [];

  try {
    const items = readdirSync(agentsDir, { withFileTypes: true });

    // 只返回目录（不含 . 开头的隐藏目录）
    return items
      .filter((item) => item.isDirectory && !item.name.startsWith("."))
      .map((item) => item.name);
  } catch {
    return [];
  }
}