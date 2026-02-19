/**
 * CCAdapter 接口定义
 *
 * 不同的 Claude Code 版本可以实现这个接口
 * - official.ts: 官方 Claude Code SDK 实现
 * - custom.ts: 用户自定义实现
 */

import type { ChatParams, ConversationSummary, ConversationHistory } from "../types.js";
import type { SDKSession } from "@anthropic-ai/claude-agent-sdk";

/** SSE 事件 */
export type SSEEvent = Record<string, unknown>;

/** Session 参数 */
export interface SessionParams {
  sessionId?: string;
  model?: string;
  cwd?: string;
}

/** Adapter 接口 */
export interface CCAdapter {
  /**
   * 发送消息，返回 SSE 事件流
   */
  chat(params: ChatParams): AsyncIterable<SSEEvent>;

  /**
   * 获取历史记录列表
   */
  listHistory(cwd: string, limit?: number): Promise<{
    conversations: ConversationSummary[];
    total: number;
    hasMore: boolean;
  }>;

  /**
   * 获取单个对话详情
   */
  getHistory(cwd: string, sessionId: string): Promise<ConversationHistory | null>;

  /**
   * 获取或创建 v2 Session
   * - 池中有 → 复用
   * - 有 sessionId 但不在池中 → resumeSession
   * - 无 sessionId → createSession
   */
  getOrCreateSession(params: SessionParams): SDKSession;

  /**
   * 关闭指定 session
   */
  closeSession(sessionId: string): void;

  /**
   * 关闭所有 session（退出时调用）
   */
  closeAllSessions(): void;
}
