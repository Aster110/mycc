/**
 * 历史记录处理
 * 读取 ~/.claude/projects/{encodedProjectName}/ 下的 JSONL 文件
 *
 * v2.0：纯文件系统扫描（兼容 CC 2.1.33+）
 * - 不再依赖 sessions-index.json
 * - 不再依赖文件权限判断活跃状态
 * - 使用 head/tail 16KB 快速读取（与 CC 官方实现一致）
 */

import { readFileSync, readdirSync, existsSync, appendFileSync, statSync, openSync, readSync, closeSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { RawHistoryLine, ConversationSummary, ConversationHistory } from "./types.js";
import { findProjectRoot } from "./config.js";

// 重新导出类型（保持兼容）
export type { ConversationSummary, ConversationHistory };

/** Head/Tail 读取缓冲大小（与 CC 2.1.33 AN6 常量一致） */
const BUFFER_SIZE = 16384; // 16KB

/**
 * 过滤系统标签
 */
function stripSystemTags(text: string): string {
  if (!text) return "";
  return text
    .replace(/<user-prompt-submit-hook[^>]*>[\s\S]*?<\/user-prompt-submit-hook>/g, "")
    .replace(/<short-term-memory[^>]*>[\s\S]*?<\/short-term-memory>/g, "")
    .replace(/<current-time[^>]*>[\s\S]*?<\/current-time>/g, "")
    .replace(/<system-reminder[^>]*>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<command-name[^>]*>[\s\S]*?<\/command-name>/g, "")
    .replace(/<command-message[^>]*>[\s\S]*?<\/command-message>/g, "")
    .trim();
}

/**
 * 将项目路径编码为 Claude 使用的目录名
 * /Users/aster/AIproject/mylife → -Users-aster-AIproject-mylife
 *
 * 自动检测项目根目录（查找 .claude/ 或 CLAUDE.md），确保历史记录路径一致性
 */
export function encodeProjectPath(projectPath: string): string {
  // 先找到项目根目录（统一逻辑，避免历史记录分散）
  const root = findProjectRoot(projectPath) || projectPath;

  // 与 CC 官方编码逻辑对齐：只保留字母和数字，其他全部替换为 "-"
  return root.replace(/\/$/, "").replace(/[^a-zA-Z0-9]/g, "-");
}

/**
 * 获取历史记录目录
 */
export function getHistoryDir(cwd: string): string {
  const encodedName = encodeProjectPath(cwd);
  return join(homedir(), ".claude", "projects", encodedName);
}

// ============ 文件系统扫描（CC 2.1.33 方案） ============

/**
 * 扫描目录中所有 .jsonl 会话文件
 * 对应 CC 源码的 g$q 函数
 */
export function scanSessionFiles(dir: string): Map<string, { path: string; mtime: number; ctime: number; size: number }> {
  const result = new Map<string, { path: string; mtime: number; ctime: number; size: number }>();

  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return result;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;

    const sessionId = entry.name.slice(0, -6); // 去掉 ".jsonl"
    const filePath = join(dir, entry.name);

    try {
      const stats = statSync(filePath);
      result.set(sessionId, {
        path: filePath,
        mtime: stats.mtime.getTime(),
        ctime: stats.birthtime.getTime(),
        size: stats.size,
      });
    } catch {
      // 跳过无法 stat 的文件
    }
  }

  return result;
}

/**
 * 从 head 内容中提取第一条 user 消息
 * 对应 CC 源码的 b5z 函数
 *
 * 跳过：file-history-snapshot、tool_result、isMeta: true
 */
export function extractFirstPrompt(headContent: string): string {
  if (!headContent) return "";

  const lines = headContent.split("\n");

  for (const line of lines) {
    if (!line.trim()) continue;

    try {
      const parsed = JSON.parse(line);

      // 只看 user 消息
      if (parsed.type !== "user") continue;

      // 跳过 isMeta 消息（CC 内部系统消息）
      if (parsed.isMeta) continue;

      const content = parsed.message?.content;
      if (!content) continue;

      // 跳过 tool_result 类型的消息
      if (Array.isArray(content)) {
        const hasToolResult = content.some((b: any) => b.type === "tool_result");
        if (hasToolResult) continue;

        // 找第一个 text block
        const textBlock = content.find((b: any) => b.type === "text" && b.text);
        if (textBlock) {
          const text = stripSystemTags(textBlock.text);
          if (text) {
            return text.length > 200 ? text.substring(0, 200) + "\u2026" : text;
          }
        }
      } else if (typeof content === "string") {
        const text = stripSystemTags(content);
        if (text) {
          return text.length > 200 ? text.substring(0, 200) + "\u2026" : text;
        }
      }
    } catch {
      // 跳过无法解析的行
    }
  }

  return "";
}

/**
 * 从内容中提取最后一个匹配的 JSON 字段值
 * 对应 CC 源码的 rP1 函数
 *
 * 用于从 tail 内容中找 customTitle 等字段
 */
export function extractLastField(content: string, fieldName: string): string | undefined {
  // 匹配 "fieldName":"value" 或 "fieldName": "value"（支持转义引号）
  const pattern = new RegExp(`"${fieldName}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`, "g");

  let lastMatch: string | undefined;
  let match;

  while ((match = pattern.exec(content)) !== null) {
    // 反转义
    lastMatch = match[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }

  return lastMatch;
}

/**
 * 读取文件摘要（head + tail 16KB）
 * 对应 CC 源码的 x5z 函数
 */
export function readFileSummary(filePath: string, fileSize: number): { firstPrompt: string; customTitle?: string } {
  if (fileSize === 0) {
    return { firstPrompt: "" };
  }

  const fd = openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(BUFFER_SIZE);

    // 读 head 16KB
    const headBytes = readSync(fd, buffer, 0, Math.min(BUFFER_SIZE, fileSize), 0);
    const headContent = buffer.toString("utf-8", 0, headBytes);

    const firstPrompt = extractFirstPrompt(headContent);

    // 读 tail 16KB（复用 buffer）
    let tailContent: string;
    const tailOffset = Math.max(0, fileSize - BUFFER_SIZE);

    if (tailOffset === 0) {
      // 小文件，tail 和 head 相同
      tailContent = headContent;
    } else {
      const tailBytes = readSync(fd, buffer, 0, BUFFER_SIZE, tailOffset);
      tailContent = buffer.toString("utf-8", 0, tailBytes);
    }

    const customTitle = extractLastField(tailContent, "customTitle");

    return { firstPrompt, customTitle };
  } finally {
    closeSync(fd);
  }
}

// ============ 对话详情（不变） ============

/**
 * 获取具体对话内容
 * 优化：只返回最后一个 summary 之后的消息，节省流量
 */
export function getConversation(
  cwd: string,
  sessionId: string
): ConversationHistory | null {
  // 验证 sessionId 格式（防止路径遍历攻击）
  if (!sessionId || /[<>:"|?*\x00-\x1f\/\\]/.test(sessionId)) {
    return null;
  }

  const historyDir = getHistoryDir(cwd);
  const filePath = join(historyDir, `${sessionId}.jsonl`);

  if (!existsSync(filePath)) {
    return null;
  }

  const content = readFileSync(filePath, "utf-8");
  const lines = content.trim().split("\n").filter(line => line.trim());
  const allMessages: unknown[] = [];
  let lastSummaryIndex = -1;

  // 第一遍：解析所有消息，记录所有 summary 的位置
  const summaryIndexes: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    try {
      const parsed = JSON.parse(lines[i]);
      allMessages.push(parsed);

      // 记录所有 summary 的索引
      if (parsed.type === "summary") {
        summaryIndexes.push(i);
      }
    } catch {
      // 忽略解析错误的行
      allMessages.push(null);
    }
  }

  // 找到"之后有实际消息"的最后一个 summary
  // 从后往前遍历 summary，找到第一个后面有实际消息的
  lastSummaryIndex = -1;
  for (let j = summaryIndexes.length - 1; j >= 0; j--) {
    const summaryIdx = summaryIndexes[j];
    // 检查这个 summary 之后是否有实际消息（非 summary）
    let hasMessagesAfter = false;
    for (let k = summaryIdx + 1; k < allMessages.length; k++) {
      const msg = allMessages[k];
      if (msg && typeof msg === "object" && "type" in msg && (msg as any).type !== "summary") {
        hasMessagesAfter = true;
        break;
      }
    }
    if (hasMessagesAfter) {
      lastSummaryIndex = summaryIdx;
      break;
    }
  }

  // 第二遍：只收集最后一个有效 summary 之后的消息
  const messages: RawHistoryLine[] = [];
  const startIndex = lastSummaryIndex + 1; // summary 之后开始（如果没有 summary 则从 0 开始）

  for (let i = startIndex; i < allMessages.length; i++) {
    const msg = allMessages[i];
    if (msg && typeof msg === "object" && "type" in msg && (msg as any).type !== "summary") {
      messages.push(msg as RawHistoryLine);
    }
  }

  return {
    sessionId,
    messages,
  };
}

// ============ 对话列表（v2.0 重写） ============

/**
 * 获取对话列表
 * 纯文件系统扫描 + head/tail 16KB 快速读取（CC 2.1.33 方案）
 *
 * @param cwd 工作目录
 * @param limit 限制返回数量（在 hydrate 前应用，提升性能）
 */
export function getConversationList(cwd: string, limit?: number): ConversationSummary[] {
  const historyDir = getHistoryDir(cwd);
  const files = scanSessionFiles(historyDir);

  if (files.size === 0) return [];

  // 按 mtime 降序排序
  let sorted = [...files.entries()].sort((a, b) => b[1].mtime - a[1].mtime);

  // 在 hydrate 前应用 limit（只读取 top N 文件）
  if (limit && limit > 0) {
    sorted = sorted.slice(0, limit);
  }

  // Hydrate：读取每个文件的 head/tail 提取摘要
  const result: ConversationSummary[] = [];

  for (const [sessionId, info] of sorted) {
    const summary = readFileSummary(info.path, info.size);

    // 过滤无内容的会话（既没有 firstPrompt 也没有 customTitle）
    if (!summary.firstPrompt && !summary.customTitle) continue;

    result.push({
      sessionId,
      customTitle: summary.customTitle || null,
      firstPrompt: summary.firstPrompt,
      messageCount: 0, // 不再计算，太昂贵
      startTime: new Date(info.ctime).toISOString(),
      lastTime: new Date(info.mtime).toISOString(),
      lastMessagePreview: summary.firstPrompt || "(无预览)",
      modified: new Date(info.mtime).toISOString(),
    });
  }

  return result;
}

// ============ 会话改名（简化版） ============

/**
 * 重命名会话
 * 简化版：只追加 custom-title 到 .jsonl，不更新索引
 */
export function renameSession(
  sessionId: string,
  newTitle: string,
  projectPath: string
): boolean {
  const trimmed = newTitle.trim();
  if (!trimmed) return false;

  try {
    const historyDir = getHistoryDir(projectPath);
    const jsonlPath = join(historyDir, `${sessionId}.jsonl`);

    if (!existsSync(jsonlPath)) return false;

    const entry = JSON.stringify({
      type: "custom-title",
      customTitle: trimmed,
      sessionId,
    });
    appendFileSync(jsonlPath, entry + "\n", "utf-8");

    return true;
  } catch {
    return false;
  }
}
