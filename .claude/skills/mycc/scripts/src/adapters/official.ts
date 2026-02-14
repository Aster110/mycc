/**
 * 官方 Claude Code SDK 实现（v2 Session API）
 */

import {
  unstable_v2_createSession,
  unstable_v2_resumeSession,
  type SDKSession,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { CCAdapter, SSEEvent, SessionParams } from "./interface.js";
import type { ChatParams, ConversationSummary, ConversationHistory } from "../types.js";
import { getConversationList, getConversation } from "../history.js";
import { detectClaudeCliPath } from "../platform.js";
import { buildMessageContent, type MessageContent } from "../image-utils.js";

// 检测 Claude CLI 路径（跨平台）
const { executable: CLAUDE_EXECUTABLE, cliPath: CLAUDE_CLI_PATH } = detectClaudeCliPath();

/** v2 SDKSessionOptions 必须提供 model，这是默认值 */
const DEFAULT_MODEL = "claude-sonnet";

/** Session 超时时间：30 分钟无活动自动关闭 */
const SESSION_TIMEOUT_MS = 30 * 60 * 1000;

/** 总安全阀超时：防止异常时 SSE 永远不关闭（30 分钟） */
const MAX_DURATION_MS = 30 * 60 * 1000;

/** 轮间超时：两轮之间等待的最长时间（5 分钟） */
const BETWEEN_TURN_TIMEOUT_MS = 5 * 60 * 1000;

/** 超时清理间隔：每 5 分钟检查一次 */
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * 构造 v2 SDKSessionOptions
 */
function buildSessionOptions(model?: string) {
  const options: Parameters<typeof unstable_v2_createSession>[0] = {
    model: model || DEFAULT_MODEL,
    pathToClaudeCodeExecutable: CLAUDE_CLI_PATH,
    permissionMode: "bypassPermissions",
    env: {
      ...process.env,
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1",
    },
  };

  // 如果检测到需要用 node 执行（npm 全局安装），设置 executable
  if (CLAUDE_EXECUTABLE === "node") {
    options.executable = "node" as const;
  }

  return options;
}

/**
 * 官方 Claude Code SDK Adapter（v2 Session 模式）
 */
export class OfficialAdapter implements CCAdapter {
  /** Session 池 */
  private sessions = new Map<string, SDKSession>();

  /** 每个 session 最后活跃时间 */
  private lastActivity = new Map<string, number>();

  /** 超时清理定时器 */
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    // 启动定时清理
    this.cleanupTimer = setInterval(() => {
      this.cleanupExpiredSessions();
    }, CLEANUP_INTERVAL_MS);

    // 不阻止进程退出
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
  }

  /**
   * 获取或创建 v2 Session
   * 注意：新建的 session 不立即存池（sessionId 要收到第一条消息后才可用）
   * 由 chat() 在 stream 中拿到 sessionId 后调 registerSession 存入池
   */
  getOrCreateSession(params: SessionParams): SDKSession {
    const { sessionId, model, cwd } = params;

    // 池中有 → 复用
    if (sessionId && this.sessions.has(sessionId)) {
      this.lastActivity.set(sessionId, Date.now());
      return this.sessions.get(sessionId)!;
    }

    const options = buildSessionOptions(model);

    // v2 SDKSessionOptions 没有 cwd 字段，子进程通过 process.cwd() 继承工作目录
    // 必须在创建 session（spawn 子进程）前 chdir 到正确目录，否则 skills 等功能失效
    const originalCwd = process.cwd();
    const needsChdir = cwd && cwd !== originalCwd;
    if (needsChdir) {
      process.chdir(cwd);
    }

    let session: SDKSession;
    try {
      if (sessionId) {
        // 有 sessionId 但不在池中 → resumeSession（sessionId 立即可用）
        session = unstable_v2_resumeSession(sessionId, options);
        this.sessions.set(sessionId, session);
        this.lastActivity.set(sessionId, Date.now());
      } else {
        // 全新对话 → createSession（sessionId 要等第一条消息后才可用）
        session = unstable_v2_createSession(options);
        // 不存池，等 chat() 中从 stream 拿到 sessionId 后再存
      }
    } finally {
      // 恢复原始 cwd
      if (needsChdir) {
        process.chdir(originalCwd);
      }
    }

    return session;
  }

  /**
   * 将 session 注册到池中（新 session 收到 sessionId 后调用）
   */
  registerSession(sessionId: string, session: SDKSession): void {
    this.sessions.set(sessionId, session);
    this.lastActivity.set(sessionId, Date.now());
  }

  /**
   * 关闭指定 session
   */
  closeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      try {
        session.close();
      } catch {
        // 静默处理
      }
      this.sessions.delete(sessionId);
      this.lastActivity.delete(sessionId);
    }
  }

  /**
   * 关闭所有 session
   */
  closeAllSessions(): void {
    for (const session of this.sessions.values()) {
      try {
        session.close();
      } catch {
        // 静默处理，继续关闭其他 session
      }
    }
    this.sessions.clear();
    this.lastActivity.clear();

    // 停止清理定时器
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /**
   * 发送消息，返回 SSE 事件流（v2 Session 模式）
   *
   * 支持多轮推送（Agent Teams + 后台 Task subagent）：
   * - 普通对话：一轮 result 后直接结束 SSE
   * - Teams 对话：检测到 TeamCreate → 持续等待 → TeamDelete 后结束
   * - 后台 Task：检测到 Task(run_in_background) → 持续等待 → 所有任务完成后结束
   *
   * stream() 遇到 result 就 return，但底层 queryIterator 是共享的，
   * 每次调 stream() 从断点继续消费。后续消息由 CLI 内部注入触发新一轮处理。
   *
   * 退出条件（按优先级）：
   * 1. 非多轮模式 → 第一轮结束即退出
   * 2. Teams + TeamDelete → 退出
   * 3. 后台 Task + 全部完成（pending 计数归零）→ 退出
   * 4. 轮间超时（5 分钟无新消息）→ 退出
   * 5. 总安全阀（30 分钟）→ 强制退出
   */
  async *chat(params: ChatParams): AsyncIterable<SSEEvent> {
    const { message, sessionId, images, model, cwd } = params;

    // 获取或创建 session
    const session = this.getOrCreateSession({ sessionId, model, cwd });
    const isNewSession = !sessionId;

    // 构造消息内容（纯文本或图文混合）
    const content = buildMessageContent(message, images);

    // 根据内容类型选择 send 格式
    if (typeof content === "string") {
      await session.send(content);
    } else {
      if (isNewSession) {
        await session.send(message);
      } else {
        const userMessage: SDKUserMessage = {
          type: "user",
          session_id: sessionId!,
          message: {
            role: "user",
            content: content as any,
          },
          parent_tool_use_id: null,
        };
        await session.send(userMessage);
      }
    }

    // === 多轮循环核心 ===
    let resolvedSessionId = sessionId;
    let isTeamsMode = false;
    let teamsFinished = false;
    let pendingBgTasks = 0;       // 后台 Task 计数
    let isMultiTurnMode = false;  // 是否进入多轮模式
    const startTime = Date.now();
    let isFirstTurn = true;

    while (true) {
      // 总安全阀
      if (Date.now() - startTime > MAX_DURATION_MS) {
        console.log("[CC] 总安全阀触发，强制结束 SSE");
        break;
      }

      if (isFirstTurn) {
        // 第一轮：直接消费 stream
        for await (const sdkMessage of session.stream()) {
          this.extractSessionId(sdkMessage, resolvedSessionId, session, (id) => { resolvedSessionId = id; });
          const signals = detectMultiTurnSignals(sdkMessage);
          if (signals.teamsStarted) { isTeamsMode = true; isMultiTurnMode = true; }
          if (signals.teamsFinished) teamsFinished = true;
          if (signals.bgTaskLaunched) { pendingBgTasks++; isMultiTurnMode = true; }
          if (signals.bgTaskCompleted) pendingBgTasks--;
          yield sdkMessage as SSEEvent;
        }
        isFirstTurn = false;
      } else {
        // 后续轮：用 Promise.race 加轮间超时
        // 防止 stream() 永远阻塞（没有更多消息时）
        const streamGen = session.stream();
        const firstResult = await Promise.race([
          streamGen.next(),
          sleep(BETWEEN_TURN_TIMEOUT_MS).then(() => TIMEOUT_SENTINEL),
        ]);

        if (firstResult === TIMEOUT_SENTINEL) {
          console.log("[CC] 轮间超时（5分钟无新消息），结束 SSE");
          break;
        }

        const { done, value } = firstResult as IteratorResult<unknown>;
        if (done) break;

        // 处理首条消息
        this.extractSessionId(value, resolvedSessionId, session, (id) => { resolvedSessionId = id; });
        const firstSignals = detectMultiTurnSignals(value);
        if (firstSignals.teamsStarted) { isTeamsMode = true; isMultiTurnMode = true; }
        if (firstSignals.teamsFinished) teamsFinished = true;
        if (firstSignals.bgTaskLaunched) { pendingBgTasks++; isMultiTurnMode = true; }
        if (firstSignals.bgTaskCompleted) pendingBgTasks--;
        yield value as SSEEvent;

        // 消费本轮剩余消息
        for await (const sdkMessage of streamGen) {
          this.extractSessionId(sdkMessage, resolvedSessionId, session, (id) => { resolvedSessionId = id; });
          const signals = detectMultiTurnSignals(sdkMessage);
          if (signals.teamsStarted) { isTeamsMode = true; isMultiTurnMode = true; }
          if (signals.teamsFinished) teamsFinished = true;
          if (signals.bgTaskLaunched) { pendingBgTasks++; isMultiTurnMode = true; }
          if (signals.bgTaskCompleted) pendingBgTasks--;
          yield sdkMessage as SSEEvent;
        }
      }

      // 通知前端一轮结束
      yield { type: "turn_complete" } as SSEEvent;

      // 更新活跃时间
      if (resolvedSessionId) {
        this.lastActivity.set(resolvedSessionId, Date.now());
      }

      // === 退出判断 ===
      if (!isMultiTurnMode) break;                           // 普通对话
      if (isTeamsMode && teamsFinished) break;                // Teams 已结束
      if (!isTeamsMode && pendingBgTasks <= 0) break;         // 后台 Task 全部完成

      console.log(`[CC] 多轮模式：等待下一轮（teams=${isTeamsMode}, pending=${pendingBgTasks}）`);
    }

    // 最终更新活跃时间
    if (resolvedSessionId) {
      this.lastActivity.set(resolvedSessionId, Date.now());
    }
  }

  /**
   * 从 system 消息中提取 sessionId
   */
  private extractSessionId(
    msg: unknown,
    current: string | undefined,
    session: SDKSession,
    setter: (id: string) => void,
  ): void {
    if (current) return;
    if (!msg || typeof msg !== "object" || !("type" in msg)) return;
    const m = msg as Record<string, unknown>;
    if (m.type === "system" && "session_id" in m && typeof m.session_id === "string") {
      setter(m.session_id);
      this.registerSession(m.session_id, session);
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

  /**
   * 清理超时 session
   */
  private cleanupExpiredSessions(): void {
    const now = Date.now();
    for (const [id, lastTime] of this.lastActivity.entries()) {
      if (now - lastTime > SESSION_TIMEOUT_MS) {
        console.log(`[Session] 清理超时 session: ${id}`);
        this.closeSession(id);
      }
    }
  }
}

/** sleep 辅助 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 超时哨兵值 */
const TIMEOUT_SENTINEL = Symbol("TIMEOUT");

/**
 * 检测多轮信号
 * - TeamCreate/TeamDelete：Agent Teams 生命周期
 * - Task + run_in_background：后台 subagent 启动
 * - task-notification + completed：后台 subagent 完成
 */
function detectMultiTurnSignals(msg: unknown): {
  teamsStarted: boolean;
  teamsFinished: boolean;
  bgTaskLaunched: boolean;
  bgTaskCompleted: boolean;
} {
  const none = { teamsStarted: false, teamsFinished: false, bgTaskLaunched: false, bgTaskCompleted: false };
  if (!msg || typeof msg !== "object") return none;

  try {
    const str = JSON.stringify(msg);
    return {
      teamsStarted: str.includes('"name":"TeamCreate"'),
      teamsFinished: str.includes('"name":"TeamDelete"'),
      bgTaskLaunched: str.includes('"name":"Task"') && str.includes('"run_in_background":true'),
      bgTaskCompleted: str.includes("task-notification") && str.includes("completed"),
    };
  } catch {
    return none;
  }
}
