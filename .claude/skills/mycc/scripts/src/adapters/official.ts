/**
 * 官方 Claude Code SDK 实现
 */

import { query, type SDKUserMessage } from "@anthropic-ai/claude-code";
import type { CCAdapter, SSEEvent } from "./interface.js";
import type { ChatParams, ConversationSummary, ConversationHistory } from "../types.js";
import { getConversationList, getConversation } from "../history.js";
import { detectClaudeCliPath } from "../platform.js";
import { buildMessageContent, type MessageContent } from "../image-utils.js";

// 检测 Claude CLI 路径（跨平台）
const { executable: CLAUDE_EXECUTABLE, cliPath: CLAUDE_CLI_PATH } = detectClaudeCliPath();

/**
 * 创建 SDKUserMessage 的 AsyncIterable
 * 用于传入图文混合消息
 */
async function* createUserMessageIterable(
  content: MessageContent
): AsyncIterable<SDKUserMessage> {
  yield {
    type: "user",
    session_id: "", // SDK 会自动填充
    message: {
      role: "user",
      content: content as any, // MessageContent 兼容 Anthropic API 格式
    },
    parent_tool_use_id: null,
  };
}

/**
 * 官方 Claude Code SDK Adapter
 */
export class OfficialAdapter implements CCAdapter {
  /**
   * 发送消息，返回 SSE 事件流
   */
  async *chat(params: ChatParams): AsyncIterable<SSEEvent> {
    const { message, sessionId, cwd, images } = params;

    // 构造 SDK 选项（Windows 不指定 executable，使用 native binary）
    const sdkOptions: Parameters<typeof query>[0]["options"] = {
      pathToClaudeCodeExecutable: CLAUDE_CLI_PATH,
      cwd: cwd || process.cwd(),
      resume: sessionId || undefined,
      permissionMode: "bypassPermissions",
    };

    // 如果检测到需要用 node 执行（npm 全局安装），设置 executable
    if (CLAUDE_EXECUTABLE === "node") {
      sdkOptions.executable = "node" as const;
    }

    // 构造消息内容（纯文本或图文混合）
    const content = buildMessageContent(message, images);

    // 根据内容类型选择 prompt 格式
    let prompt: string | AsyncIterable<SDKUserMessage>;

    if (typeof content === "string") {
      // 纯文本，直接传字符串
      prompt = content;
    } else {
      // 图文混合，需要构造 SDKUserMessage
      prompt = createUserMessageIterable(content);
    }

    for await (const sdkMessage of query({
      prompt,
      options: sdkOptions,
    })) {
      yield sdkMessage as SSEEvent;
    }
  }

  /**
   * 获取历史记录列表
   */
  async listHistory(cwd: string, limit?: number): Promise<{
    conversations: ConversationSummary[];
    total: number;
    hasMore: boolean;
  }> {
    let conversations = getConversationList(cwd);
    const total = conversations.length;

    // 如果 limit > 0，只返回前 limit 条
    if (limit && limit > 0) {
      conversations = conversations.slice(0, limit);
    }

    return {
      conversations,
      total,
      hasMore: conversations.length < total,
    };
  }

  /**
   * 获取单个对话详情
   */
  async getHistory(cwd: string, sessionId: string): Promise<ConversationHistory | null> {
    return getConversation(cwd, sessionId);
  }
}
