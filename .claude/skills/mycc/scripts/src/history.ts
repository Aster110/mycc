/**
 * 历史记录处理
 * 读取 ~/.claude/projects/{encodedProjectName}/ 下的 JSONL 文件
 */

import { readFileSync, readdirSync, existsSync, writeFileSync, renameSync, appendFileSync, statSync, realpathSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { RawHistoryLine, ConversationSummary, ConversationHistory } from "./types.js";
import { findProjectRoot } from "./config.js";

// 重新导出类型（保持兼容）
export type { ConversationSummary, ConversationHistory };

// ============ sessions-index.json 相关类型 ============

/** sessions-index.json 中的单个会话条目 */
interface SessionEntry {
  sessionId: string;
  fullPath: string;
  fileMtime: number;
  firstPrompt: string;
  customTitle?: string | null;
  messageCount: number;
  created: string;
  modified: string;
  gitBranch?: string;
  projectPath: string;
  isSidechain: boolean;
}

/** sessions-index.json 文件格式 */
interface SessionsIndex {
  version: number;
  entries: SessionEntry[];
}

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
    .trim();
}

/**
 * 将项目路径编码为 Claude 使用的目录名
 * /Users/aster/AIproject/mylife → -Users-aster-AIproject-mylife
 *
 * 自动检测项目根目录（查找 .claude/ 或 CLAUDE.md），确保历史记录路径一致性
 */
export function encodeProjectPath(projectPath: string): string {
  // 解析符号链接，确保路径一致性（例如 /tmp -> /private/tmp）
  let resolvedPath = projectPath;
  try {
    resolvedPath = realpathSync(projectPath);
  } catch {
    // 如果路径不存在或无法解析，使用原路径
  }

  // 先找到项目根目录（统一逻辑，避免历史记录分散）
  const root = findProjectRoot(resolvedPath) || resolvedPath;

  // 再编码
  return root.replace(/\/$/, "").replace(/[/\\:._]/g, "-");
}

/**
 * 获取历史记录目录
 */
export function getHistoryDir(cwd: string): string {
  const encodedName = encodeProjectPath(cwd);
  return join(homedir(), ".claude", "projects", encodedName);
}

/**
 * 获取对话列表（旧版本，只扫描本地文件）
 * @deprecated 使用 getConversationListWithActive 获取完整列表
 */
export function getConversationListLegacy(cwd: string): ConversationSummary[] {
  const historyDir = getHistoryDir(cwd);

  if (!existsSync(historyDir)) {
    return [];
  }

  const files = readdirSync(historyDir).filter(f => f.endsWith(".jsonl"));
  const conversations: ConversationSummary[] = [];

  for (const file of files) {
    const filePath = join(historyDir, file);
    const sessionId = file.replace(".jsonl", "");

    try {
      const summary = parseConversationSummary(filePath, sessionId);
      if (summary) {
        conversations.push(summary);
      }
    } catch (err) {
      console.error(`[History] Failed to parse ${file}:`, err);
    }
  }

  // 按最后时间倒序排列（无日期的排到最后）
  conversations.sort((a, b) => {
    const timeA = a.lastTime ? new Date(a.lastTime).getTime() : 0;
    const timeB = b.lastTime ? new Date(b.lastTime).getTime() : 0;
    return timeB - timeA;
  });

  return conversations;
}

/**
 * 解析对话摘要
 */
function parseConversationSummary(
  filePath: string,
  sessionId: string
): ConversationSummary | null {
  const content = readFileSync(filePath, "utf-8");
  const lines = content.trim().split("\n").filter(line => line.trim());

  if (lines.length === 0) {
    return null;
  }

  let startTime = "";
  let lastTime = "";
  let lastMessagePreview = "";
  let messageCount = 0;

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as RawHistoryLine;
      messageCount++;

      // 跟踪时间戳（summary 消息没有 timestamp，跳过）
      if (parsed.timestamp) {
        if (!startTime || parsed.timestamp < startTime) {
          startTime = parsed.timestamp;
        }
        if (!lastTime || parsed.timestamp > lastTime) {
          lastTime = parsed.timestamp;
        }
      }

      // 提取最后一条消息预览（user 消息，过滤系统标签）
      if (parsed.type === "user" && parsed.message?.content) {
        const content = parsed.message.content;
        let rawPreview = "";
        if (typeof content === "string") {
          rawPreview = content;
        } else if (Array.isArray(content)) {
          for (const item of content) {
            if (typeof item === "object" && item && "text" in item) {
              rawPreview = String((item as { text: string }).text);
              break;
            }
          }
        }
        // 过滤系统标签后截取
        const cleanPreview = stripSystemTags(rawPreview);
        if (cleanPreview) {
          lastMessagePreview = cleanPreview.substring(0, 100);
        }
      }
    } catch {
      // 忽略解析错误的行
    }
  }

  return {
    sessionId,
    startTime,
    lastTime,
    messageCount,
    lastMessagePreview: lastMessagePreview || "(无预览)",
  };
}

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

/**
 * 获取对话列表（新实现：从 sessions-index.json 读取）
 * 性能提升 10-100x
 */
export function getConversationListFromIndex(cwd: string): ConversationSummary[] {
  const historyDir = getHistoryDir(cwd);
  const indexPath = join(historyDir, "sessions-index.json");

  if (!existsSync(indexPath)) {
    return [];
  }

  try {
    const content = readFileSync(indexPath, "utf-8");
    const index: SessionsIndex = JSON.parse(content);

    // 按修改时间倒序排列
    const sorted = index.entries.sort((a, b) =>
      new Date(b.modified).getTime() - new Date(a.modified).getTime()
    );

    // 转换为前端需要的格式
    return sorted.map(entry => ({
      sessionId: entry.sessionId,
      customTitle: entry.customTitle || null,  // 确保是 null 而不是 undefined
      firstPrompt: entry.firstPrompt,
      messageCount: entry.messageCount,
      startTime: entry.created,
      lastTime: entry.modified,
      lastMessagePreview: entry.firstPrompt?.substring(0, 100) || "(无预览)",
      modified: entry.modified,  // 新增字段，与活跃会话格式一致
      isActive: false           // 索引会话都是已完成的
    }));
  } catch (error) {
    console.error("[History] Failed to read sessions-index.json:", error);
    return [];
  }
}

/**
 * 重命名会话
 * @param sessionId 会话 ID
 * @param newTitle 新标题（trim 后不能为空）
 * @param projectPath 项目路径
 * @returns 是否成功
 */
export function renameSession(
  sessionId: string,
  newTitle: string,
  projectPath: string
): boolean {
  // 验证标题（trim 后不能为空）
  const trimmed = newTitle.trim();
  if (!trimmed) {
    console.error("[Rename] Title cannot be empty");
    return false;
  }

  try {
    // 1. 获取项目目录路径
    const encodedPath = encodeProjectPath(projectPath);
    const projectDir = join(homedir(), ".claude", "projects", encodedPath);
    const indexPath = join(projectDir, "sessions-index.json");
    const jsonlPath = join(projectDir, `${sessionId}.jsonl`);

    // 2. 检查 jsonl 文件是否存在（必须）
    if (!existsSync(jsonlPath)) {
      console.error("[Rename] Session file not found:", jsonlPath);
      return false;
    }

    // 3. 读取索引文件（可选，活跃会话可能不在索引中）
    let index: SessionsIndex | null = null;
    if (existsSync(indexPath)) {
      index = JSON.parse(readFileSync(indexPath, "utf-8"));
    }

    // 4. 写入 custom-title 到 jsonl 文件（无论是否在索引中）
    const customTitleEntry = JSON.stringify({
      type: "custom-title",
      customTitle: trimmed,
      sessionId: sessionId
    });
    appendFileSync(jsonlPath, customTitleEntry + "\n", "utf-8");

    // 5. 如果索引存在且包含此会话，同时更新索引
    if (index) {
      const entry = index.entries.find(e => e.sessionId === sessionId);
      if (entry) {
        entry.customTitle = trimmed;
        entry.modified = new Date().toISOString();

        // 原子性写回索引文件（临时文件 + rename）
        const tempPath = `${indexPath}.tmp`;
        writeFileSync(tempPath, JSON.stringify(index, null, 2), "utf-8");
        renameSync(tempPath, indexPath);
      } else {
        // 会话不在索引中（活跃会话）
        console.log(`[Rename] Active session (not in index): ${sessionId}`);
      }
    } else {
      // 索引文件不存在（所有会话都是活跃的）
      console.log(`[Rename] No index file, active session: ${sessionId}`);
    }

    console.log(`[Rename] Session renamed: ${sessionId} -> "${trimmed}"`);
    return true;
  } catch (error) {
    console.error("[Rename] Failed:", error);
    return false;
  }
}

// ============ 活跃会话扫描功能 ============

/**
 * 检查文件是否为活跃状态（644权限）
 */
function isActiveSession(filePath: string): boolean {
  try {
    const stats = statSync(filePath);
    // 644 = 0o644 = owner:rw, group:r, other:r
    // 600 = 0o600 = owner:rw, group:-, other:-
    // 检查 group/other 是否有权限（644有，600没有）
    return (stats.mode & 0o077) !== 0;
  } catch (error) {
    return false;
  }
}

/**
 * 解析单个活跃会话文件，返回摘要
 */
function parseActiveSessionSummary(filePath: string, sessionId: string, cwd: string): ConversationSummary | null {
  try {
    const content = readFileSync(filePath, "utf-8");
    const lines = content.trim().split("\n").filter(line => line.trim());

    if (lines.length === 0) {
      return null;
    }

    let firstPrompt = "";
    let messageCount = 0;
    let startTime = "";
    let lastTime = "";
    let lastMessagePreview = "";
    let customTitle: string | null = null;

    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as RawHistoryLine;

        // 解析 customTitle entry（改名时写入的）
        // 格式：{ type: "custom-title", customTitle: "xxx" }
        if (parsed.type === "custom-title" && parsed.customTitle) {
          customTitle = parsed.customTitle;
          continue;
        }

        // 跳过系统消息和非标准格式
        if (!parsed.type || !parsed.sessionId) {
          continue;
        }

        // 只统计有效消息
        if (["user", "assistant"].includes(parsed.type)) {
          messageCount++;
        }

        // 记录时间戳
        if (parsed.timestamp) {
          if (!startTime || parsed.timestamp < startTime) {
            startTime = parsed.timestamp;
          }
          if (!lastTime || parsed.timestamp > lastTime) {
            lastTime = parsed.timestamp;
          }
        }

        // 提取第一条用户消息作为 firstPrompt
        if (!firstPrompt && parsed.type === "user" && parsed.message?.content) {
          const content = parsed.message.content;
          if (typeof content === "string") {
            firstPrompt = stripSystemTags(content).substring(0, 100);
          } else if (Array.isArray(content)) {
            // 处理数组格式：[{type: "text", text: "..."}]
            const textBlock = content.find((b: any) => b.type === "text" && b.text);
            if (textBlock) {
              firstPrompt = stripSystemTags(textBlock.text).substring(0, 100);
            }
          }
        }

        // 提取最后一条用户消息预览
        if (parsed.type === "user" && parsed.message?.content) {
          const content = parsed.message.content;
          if (typeof content === "string") {
            lastMessagePreview = stripSystemTags(content).substring(0, 100);
          } else if (Array.isArray(content)) {
            // 处理数组格式
            const textBlock = content.find((b: any) => b.type === "text" && b.text);
            if (textBlock) {
              lastMessagePreview = stripSystemTags(textBlock.text).substring(0, 100);
            }
          }
        }
      } catch (parseError) {
        // 跳过无法解析的行
        continue;
      }
    }

    // 必须有有效的内容才返回
    if (messageCount === 0 || !firstPrompt) {
      return null;
    }

    // 获取文件修改时间作为默认时间
    const stats = statSync(filePath);
    const fileModified = stats.mtime.toISOString();

    return {
      sessionId,
      startTime: startTime || fileModified,
      lastTime: lastTime || fileModified,
      messageCount,
      lastMessagePreview: lastMessagePreview || firstPrompt,
      customTitle,  // 从 .jsonl 中解析的 customTitle（可能为 null）
      firstPrompt,
      modified: lastTime || fileModified,
      isActive: true
    };
  } catch (error) {
    console.error(`[Active] Failed to parse ${filePath}:`, error);
    return null;
  }
}

/**
 * 扫描活跃会话（644权限的会话文件）
 */
export function scanActiveConversations(cwd: string): ConversationSummary[] {
  try {
    const historyDir = getHistoryDir(cwd);

    if (!existsSync(historyDir)) {
      return [];
    }

    const files = readdirSync(historyDir).filter(f => f.endsWith(".jsonl"));
    const activeConversations: ConversationSummary[] = [];
    const encodedProjectPath = encodeProjectPath(cwd);

    for (const file of files) {
      const filePath = join(historyDir, file);

      // 只处理活跃会话（644权限）
      if (!isActiveSession(filePath)) {
        continue;
      }

      const sessionId = file.replace(".jsonl", "");

      // 解析会话内容，确保属于当前项目
      const summary = parseActiveSessionSummary(filePath, sessionId, cwd);
      if (summary) {
        activeConversations.push(summary);
      }
    }

    // 按修改时间倒序排序
    activeConversations.sort((a, b) => {
      const timeA = a.modified ? new Date(a.modified).getTime() : 0;
      const timeB = b.modified ? new Date(b.modified).getTime() : 0;
      return timeB - timeA;
    });

    return activeConversations;
  } catch (error) {
    console.error("[Active] Failed to scan active sessions:", error);
    return [];
  }
}

/**
 * 合并索引会话和活跃会话列表
 * 规则：相同 sessionId 时，活跃版本优先
 */
export function mergeConversationLists(
  indexedList: ConversationSummary[],
  activeList: ConversationSummary[]
): ConversationSummary[] {
  const merged = new Map<string, ConversationSummary>();

  // 先添加索引会话
  for (const session of indexedList) {
    merged.set(session.sessionId, { ...session, isActive: false });
  }

  // 活跃会话覆盖同名的索引会话
  for (const session of activeList) {
    merged.set(session.sessionId, { ...session, isActive: true });
  }

  // 转为数组并按修改时间倒序
  const result = Array.from(merged.values());
  result.sort((a, b) => {
    const timeA = a.modified ? new Date(a.modified).getTime() :
                  a.lastTime ? new Date(a.lastTime).getTime() : 0;
    const timeB = b.modified ? new Date(b.modified).getTime() :
                  b.lastTime ? new Date(b.lastTime).getTime() : 0;
    return timeB - timeA;
  });

  return result;
}

/**
 * 获取完整会话列表（索引 + 活跃会话）
 * 这是新的主函数，替代旧的 getConversationList
 */
export function getConversationList(cwd: string): ConversationSummary[] {
  try {
    // 从索引读取已完成会话
    const indexedSessions = getConversationListFromIndex(cwd);

    // 扫描活跃会话
    const activeSessions = scanActiveConversations(cwd);

    // 如果两者都为空，尝试降级扫描所有文件
    if (indexedSessions.length === 0 && activeSessions.length === 0) {
      console.log("[getConversationList] No indexed or active sessions, trying scanAllConversations");
      return scanAllConversations(cwd);
    }

    // 合并并返回
    return mergeConversationLists(indexedSessions, activeSessions);
  } catch (error) {
    console.error("[getConversationList] Failed:", error);
    // 降级处理：尝试从索引读取
    try {
      const indexed = getConversationListFromIndex(cwd);
      if (indexed.length > 0) {
        return indexed;
      }
    } catch {}

    // 如果索引也失败，降级扫描所有文件（不管权限）
    try {
      return scanAllConversations(cwd);
    } catch {
      return [];
    }
  }
}

/**
 * 降级方案：扫描所有会话文件（不管权限）
 */
function scanAllConversations(cwd: string): ConversationSummary[] {
  console.log(`[scanAllConversations] Scanning cwd: ${cwd}`);
  const historyDir = getHistoryDir(cwd);
  console.log(`[scanAllConversations] History dir: ${historyDir}`);

  if (!existsSync(historyDir)) {
    console.log(`[scanAllConversations] History dir does not exist`);
    return [];
  }

  const files = readdirSync(historyDir).filter(f => f.endsWith(".jsonl"));
  console.log(`[scanAllConversations] Found ${files.length} .jsonl files`);
  const conversations: ConversationSummary[] = [];

  for (const file of files) {
    const filePath = join(historyDir, file);
    const sessionId = file.replace(".jsonl", "");

    try {
      console.log(`[scanAllConversations] Parsing ${file}...`);
      const summary = parseActiveSessionSummary(filePath, sessionId, cwd);
      if (summary) {
        console.log(`[scanAllConversations] Successfully parsed ${file}`);
        conversations.push(summary);
      } else {
        console.log(`[scanAllConversations] parseActiveSessionSummary returned null for ${file}`);
      }
    } catch (error) {
      console.error(`[scanAllConversations] Failed to parse ${file}:`, error);
    }
  }

  console.log(`[scanAllConversations] Total conversations: ${conversations.length}`);

  // 按修改时间倒序排序
  conversations.sort((a, b) => {
    const timeA = a.modified ? new Date(a.modified).getTime() : 0;
    const timeB = b.modified ? new Date(b.modified).getTime() : 0;
    return timeB - timeA;
  });

  return conversations;
}
