/**
 * HTTP 服务器
 * 提供 REST API 供小程序调用
 */

import http from "http";
import https from "https";
import os from "os";
import { join } from "path";
import { readFileSync, existsSync } from "fs";
import { generateToken } from "./utils.js";
import { adapter } from "./adapters/index.js";
import type { PairState } from "./types.js";
import { validateImages, type ImageData } from "./image-utils.js";
import { renameSession, getHistoryDir, scanSessionFiles } from "./history.js";
import { listSkills } from "./skills.js";
import { ChannelManager } from "./channels/manager.js";
import { WebChannel } from "./channels/web.js";
import { loadConfig } from "./config.js";
import { SessionStats } from "./session-stats.js";
import { FeishuCommands } from "./channels/feishu-commands.js";
import { resolveAgentDir, listAgents } from "./agent-resolver.js";
import type { WeixinChannel } from "./channels/weixin.js";

const PORT = process.env.PORT || 18080;

export interface TlsConfig {
  certPath: string;
  keyPath: string;
}

// 配对速率限制：每 IP 5 次失败后锁定 5 分钟
const PAIR_MAX_ATTEMPTS = 5;
const PAIR_LOCK_MS = 5 * 60 * 1000;
const pairAttempts = new Map<string, { count: number; lockedUntil: number }>();

/** 测试用：重置速率限制状态 */
export function _resetPairAttempts() { pairAttempts.clear(); }

export class HttpServer {
  private server: http.Server | https.Server;
  private state: PairState;
  private cwd: string;
  private agentsDir: string | null;
  private onPaired?: (token: string) => void;
  private isTls: boolean;
  private channelManager: ChannelManager;
  private feishuChannel: any = null;
  private weixinChannel: WeixinChannel | null = null;
  private feishuCommands: FeishuCommands;
  private stats: SessionStats;

  /** 代理：暴露底层 Map 供内部/测试访问 */
  private get toolStats() { return this.stats.toolStatsMap; }
  private get messageCount() { return this.stats.messageCountMap; }

  /** SSE 事件监听者集合 */
  private eventListeners: Set<http.ServerResponse> = new Set();

  /** 后端启动时间（用于 uptime 计算） */
  private startTime: number = Date.now();

  /** 心跳定时器 */
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  /** 心跳间隔：30 秒 */
  private static readonly HEARTBEAT_INTERVAL_MS = 30 * 1000;

  /** 最近一次 tool_use 的时间（用于计算 duration） */
  private lastToolUseTime: number = 0;

  /** 最近一次 tool_use 的工具名 */
  private lastToolName: string = "";

  /** tunnel 状态获取函数 */
  private getTunnelStatusFn: (() => string) | null = null;

  constructor(pairCode: string, cwd: string, authToken?: string, tls?: TlsConfig, agentsDir?: string) {
    this.cwd = cwd;
    this.agentsDir = agentsDir || process.env.AGENTS_DIR || null;
    // 如果传入了 authToken，说明之前已配对过
    this.state = {
      pairCode,
      paired: !!authToken,
      token: authToken || null,
    };

    // 初始化通道管理器
    this.channelManager = new ChannelManager();

    // 初始化统计模块
    this.stats = new SessionStats();

    // 初始化飞书命令模块（feishuChannel 延迟注入，start() 中完成）
    this.feishuCommands = new FeishuCommands({
      adapter,
      channelManager: this.channelManager,
      cwd: this.cwd,
      feishuChannel: null,
      loadConfig,
    });

    const handler = (req: http.IncomingMessage, res: http.ServerResponse) => {
      this.handleRequest(req, res);
    };

    // 如果提供了 TLS 证书，使用 HTTPS
    if (tls && existsSync(tls.certPath) && existsSync(tls.keyPath)) {
      this.server = https.createServer({
        cert: readFileSync(tls.certPath),
        key: readFileSync(tls.keyPath),
      }, handler);
      this.isTls = true;
    } else {
      this.server = http.createServer(handler);
      this.isTls = false;
    }

    // 注册 session 生命周期回调
    adapter.setLifecycleCallbacks({
      onSessionCreate: (sessionId: string) => {
        this.broadcastEvent("sessionStart", { sessionId, ts: Date.now() });
      },
      onSessionClose: (sessionId: string) => {
        this.broadcastEvent("sessionEnd", {
          sessionId,
          finalState: "completed",
          ts: Date.now(),
        });
        // 清理统计数据
        this.stats.cleanup(sessionId);
      },
    });
  }

  /** 设置配对成功回调（用于持久化 authToken） */
  setOnPaired(callback: (token: string) => void) {
    this.onPaired = callback;
  }

  /** 获取当前 authToken */
  getAuthToken(): string | null {
    return this.state.token;
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    // CORS
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
      res.writeHead(200);
      res.end();
      return;
    }

    const url = new URL(req.url || "/", `http://localhost:${PORT}`);

    try {
      if (url.pathname === "/health" && req.method === "GET") {
        this.handleHealth(res);
      } else if (url.pathname === "/pair" && req.method === "POST") {
        await this.handlePair(req, res);
      } else if (url.pathname === "/chat" && req.method === "POST") {
        await this.handleChat(req, res);
      } else if (url.pathname === "/history/list" && req.method === "GET") {
        await this.handleHistoryList(req, res);
      } else if (url.pathname.startsWith("/history/") && req.method === "GET") {
        await this.handleHistoryDetail(req, res, url.pathname);
      } else if (url.pathname === "/chat/rename" && req.method === "POST") {
        await this.handleRename(req, res);
      } else if (url.pathname === "/skills/list" && req.method === "GET") {
        await this.handleSkillsList(req, res, url);
      } else if (url.pathname === "/agents/list" && req.method === "GET") {
        this.handleAgentsList(req, res);
      } else if (url.pathname === "/events" && req.method === "GET") {
        this.handleEvents(req, res);
      } else if (url.pathname === "/status" && req.method === "GET") {
        await this.handleStatus(req, res);
      } else if (url.pathname === "/weixin/send-media" && req.method === "POST") {
        await this.handleWeixinSendMedia(req, res);
      } else if (url.pathname === "/weixin/send" && req.method === "POST") {
        await this.handleWeixinSend(req, res);
      } else if (url.pathname === "/weixin/users" && req.method === "GET") {
        this.handleWeixinUsers(req, res);
      } else {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not Found" }));
      }
    } catch (error) {
      console.error("[HTTP] Error:", error);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal Server Error" }));
    }
  }

  private handleHealth(res: http.ServerResponse) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", paired: this.state.paired, hostname: os.hostname() }));
  }

  private async handlePair(req: http.IncomingMessage, res: http.ServerResponse) {
    // 速率限制检查
    const ip = req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
    const record = pairAttempts.get(ip);
    if (record && Date.now() < record.lockedUntil) {
      const waitSec = Math.ceil((record.lockedUntil - Date.now()) / 1000);
      console.log(`[Pair] IP ${ip} 被锁定，剩余 ${waitSec}s`);
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `请求过于频繁，请 ${waitSec} 秒后重试` }));
      return;
    }

    const body = await this.readBody(req);
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }
    const { pairCode } = parsed;

    if (pairCode !== this.state.pairCode) {
      // 记录失败次数
      const attempts = record || { count: 0, lockedUntil: 0 };
      attempts.count++;
      if (attempts.count >= PAIR_MAX_ATTEMPTS) {
        attempts.lockedUntil = Date.now() + PAIR_LOCK_MS;
        attempts.count = 0;
        console.log(`[Pair] IP ${ip} 失败 ${PAIR_MAX_ATTEMPTS} 次，锁定 5 分钟`);
      }
      pairAttempts.set(ip, attempts);

      console.log(`[Pair] 配对失败: 配对码错误 (${attempts.count}/${PAIR_MAX_ATTEMPTS})`);
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "配对码错误" }));
      return;
    }

    // 配对成功，清除该 IP 的失败记录
    pairAttempts.delete(ip);

    // 如果已配对，返回相同 token（不覆盖）
    if (this.state.paired && this.state.token) {
      console.log("[Pair] 重复配对，返回现有 token");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, token: this.state.token }));
      return;
    }

    // 首次配对，生成 token
    const token = generateToken();
    this.state.paired = true;
    this.state.token = token;

    console.log("[Pair] 首次配对成功");

    // 通知外部保存 authToken
    if (this.onPaired) {
      this.onPaired(token);
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, token }));
  }

  private async handleChat(req: http.IncomingMessage, res: http.ServerResponse) {
    // 渠道开关检查
    if (process.env.CHANNEL_WEB === "false") {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Web channel is disabled" }));
      return;
    }

    // 验证 token
    const authHeader = req.headers.authorization;
    const token = authHeader?.replace("Bearer ", "");

    if (!this.state.paired || token !== this.state.token) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "未授权" }));
      return;
    }

    const body = await this.readBody(req);
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }
    const { message, sessionId, images, model, agentId } = parsed as {
      message: string;
      sessionId?: string;
      images?: ImageData[];
      model?: string;
      agentId?: string;
    };

    // agentId 路由：解析为 Agent 目录
    let effectiveCwd = this.cwd;
    let settingSources: string[] | undefined;
    if (agentId) {
      if (!this.agentsDir) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Agent 路由未配置" }));
        return;
      }
      const agentDir = resolveAgentDir(agentId, this.agentsDir);
      if (!agentDir) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `Agent '${agentId}' 不存在` }));
        return;
      }
      effectiveCwd = agentDir;
      settingSources = ["project"];
    }

    // 校验图片
    const imageValidation = validateImages(images);
    if (!imageValidation.valid) {
      res.writeHead(imageValidation.code || 400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: imageValidation.error }));
      return;
    }

    // INJECT_HOSTNAME：可选，默认关闭
    const injectHostname = process.env.INJECT_HOSTNAME === "true";
    const chatMessage = injectHostname
      ? `[当前机器: ${os.hostname()}] ${message}`
      : message;

    const hasImages = images && images.length > 0;
    console.log(`[CC] 收到消息: ${message.substring(0, 50)}...${hasImages ? ` (附带 ${images.length} 张图片)` : ""}`);

    // 设置 SSE 响应头
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });

    // 创建 Web 通道
    const webChannel = new WebChannel({ res });
    const webChannelId = `web-${Date.now()}-${Math.random()}`;
    Object.defineProperty(webChannel, 'id', { value: webChannelId, writable: false });
    this.channelManager.register(webChannel);

    let currentSessionId = sessionId;

    // 独立心跳定时器：防止 CLI 长时间无输出导致浏览器 SSE 超时断连
    const chatHeartbeatInterval = setInterval(() => {
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ type: "heartbeat", ts: Date.now() })}\n\n`);
      }
    }, 30_000);

    try {
      // 使用 adapter 的 chat 方法（返回 AsyncIterable）
      for await (const data of adapter.chat({ message: chatMessage, sessionId, cwd: effectiveCwd, images, model: model || undefined, settingSources })) {
        if (data && typeof data === "object" && "type" in data) {
          // 提取 session_id
          if (data.type === "system" && "session_id" in data) {
            currentSessionId = data.session_id as string;
            this.feishuCommands.currentSessionId = currentSessionId;
            webChannel.setSessionId(currentSessionId);
          }

          // 拦截 tool_use 事件 → 广播 + 统计
          if (data.type === "tool_use" && "name" in data) {
            const toolName = data.name as string;
            this.incrementToolStat(currentSessionId, toolName);
            this.broadcastEvent("toolUse", {
              sessionId: currentSessionId,
              tool: toolName,
              ts: Date.now(),
            });
          }

          // 拦截 tool_result 事件 → 广播
          if (data.type === "tool_result") {
            const isError = !!(data as any).is_error;
            this.broadcastEvent("toolResult", {
              sessionId: currentSessionId,
              tool: (data as any).name || "",
              status: isError ? "error" : "success",
              ts: Date.now(),
            });
          }

          // 拦截 assistant 消息 → 累计消息计数
          if (data.type === "assistant") {
            this.incrementMessageCount(currentSessionId);
          }
        }

        // 发送到 Web 通道（不广播到飞书，飞书走自己的流程）
        await webChannel.send(data);
      }

      // user 消息也算一条
      this.incrementMessageCount(currentSessionId);

      // 完成
      clearInterval(chatHeartbeatInterval);
      await webChannel.sendDone();
      this.channelManager.unregister(webChannelId);
      console.log(`[CC] 完成`);
    } catch (error) {
      clearInterval(chatHeartbeatInterval);
      const errMsg = error instanceof Error ? error.message : String(error);

      // 关闭死掉的 session，防止污染池（下次请求复用死 session 导致级联崩溃）
      if (currentSessionId) {
        adapter.closeSession(currentSessionId);
        console.log(`[CC] 已关闭异常 session: ${currentSessionId}`);
      }

      try {
        await webChannel.sendError(errMsg);
      } catch {
        // 忽略发送错误
      }
      this.channelManager.unregister(webChannelId);
      console.error(`[CC] 错误: ${errMsg}`);
    }
  }

  private async handleHistoryList(req: http.IncomingMessage, res: http.ServerResponse) {
    // 验证 token
    const authHeader = req.headers.authorization;
    const token = authHeader?.replace("Bearer ", "");

    if (!this.state.paired || token !== this.state.token) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "未授权" }));
      return;
    }

    try {
      // 解析 limit 参数（默认 20，传 0 或不传数字则返回全部）
      const url = new URL(req.url || "", `http://${req.headers.host}`);
      const limitParam = url.searchParams.get("limit");
      const limit = limitParam ? parseInt(limitParam, 10) : 20;

      // 使用 adapter 的 listHistory 方法
      const result = await adapter.listHistory(this.cwd, limit);

      console.log(`[History] 返回 ${result.conversations.length}/${result.total} 条历史记录 (cwd: ${this.cwd})`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (error) {
      console.error("[History] List error:", error);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "获取历史记录失败" }));
    }
  }

  private async handleHistoryDetail(req: http.IncomingMessage, res: http.ServerResponse, pathname: string) {
    // 验证 token
    const authHeader = req.headers.authorization;
    const token = authHeader?.replace("Bearer ", "");

    if (!this.state.paired || token !== this.state.token) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "未授权" }));
      return;
    }

    // 提取 sessionId: /history/{sessionId}
    const sessionId = pathname.replace("/history/", "");

    if (!sessionId || sessionId === "list") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "无效的 sessionId" }));
      return;
    }

    try {
      // 使用 adapter 的 getHistory 方法
      const conversation = await adapter.getHistory(this.cwd, sessionId);
      if (!conversation) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "对话不存在" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(conversation));
    } catch (error) {
      console.error("[History] Detail error:", error);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "获取对话详情失败" }));
    }
  }

  private async handleRename(req: http.IncomingMessage, res: http.ServerResponse) {
    // 验证 token
    const authHeader = req.headers.authorization;
    const token = authHeader?.replace("Bearer ", "");

    if (!this.state.paired || token !== this.state.token) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "未授权" }));
      return;
    }

    try {
      const body = await this.readBody(req);
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON" }));
        return;
      }
      const { sessionId, newTitle } = parsed;

      // 验证输入
      if (!sessionId || typeof newTitle !== "string") {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "sessionId and newTitle are required" }));
        return;
      }

      // 执行重命名
      const success = renameSession(sessionId, newTitle, this.cwd);

      if (success) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true }));
      } else {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Session not found or title is empty" }));
      }
    } catch (error) {
      console.error("[Rename] Error:", error);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "重命名失败" }));
    }
  }

  private async handleSkillsList(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
    const authHeader = req.headers.authorization;
    const token = authHeader?.replace("Bearer ", "");

    if (!this.state.paired || token !== this.state.token) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "未授权" }));
      return;
    }

    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(url.searchParams.get("pageSize") || "20", 10) || 20));

    const skillsDir = join(this.cwd, ".claude", "skills");
    const allItems = listSkills(skillsDir);
    const total = allItems.length;
    const start = (page - 1) * pageSize;
    const items = allItems.slice(start, start + pageSize);
    const hasMore = start + pageSize < total;

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ items, total, page, pageSize, hasMore }));
  }

  private handleAgentsList(req: http.IncomingMessage, res: http.ServerResponse) {
    const authHeader = req.headers.authorization;
    const token = authHeader?.replace("Bearer ", "");

    if (!this.state.paired || token !== this.state.token) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "未授权" }));
      return;
    }

    const agents = this.agentsDir ? listAgents(this.agentsDir) : [];
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ agents }));
  }

  /**
   * 向所有 /events 监听者广播事件
   */
  private broadcastEvent(eventType: string, data: Record<string, unknown>): void {
    if (this.eventListeners.size === 0) return;

    const payload = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of this.eventListeners) {
      try {
        res.write(payload);
      } catch {
        this.eventListeners.delete(res);
      }
    }
  }

  /**
   * SSE 实时广播端点
   */
  private handleEvents(req: http.IncomingMessage, res: http.ServerResponse): void {
    const authHeader = req.headers.authorization;
    const token = authHeader?.replace("Bearer ", "");

    if (!this.state.paired || token !== this.state.token) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "未授权" }));
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });

    this.eventListeners.add(res);

    req.on("close", () => {
      this.eventListeners.delete(res);
    });

    // 发送初始心跳
    this.sendHeartbeat(res);
  }

  /**
   * 系统状态快照端点
   */
  private async handleStatus(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const authHeader = req.headers.authorization;
    const token = authHeader?.replace("Bearer ", "");

    if (!this.state.paired || token !== this.state.token) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "未授权" }));
      return;
    }

    // 构建 sessions 列表
    const sessions: Array<{
      id: string;
      title: string;
      lastActive: string;
      state: string;
      toolStats: { Write: number; Read: number; Bash: number };
      messageCount: number;
    }> = [];

    const knownSessionIds = this.stats.getAllSessionIds();
    const now = Date.now();

    for (const id of knownSessionIds) {
      const stats = this.stats.getToolStats(id);
      const msgCount = this.stats.getMessageCount(id);

      sessions.push({
        id,
        title: "Untitled",
        lastActive: new Date(now).toISOString(),
        state: "working", // 已知 sessions 默认 working
        toolStats: stats,
        messageCount: msgCount,
      });
    }

    // 历史统计
    let totalCompleted = 0;
    try {
      const historyDir = getHistoryDir(this.cwd);
      const files = scanSessionFiles(historyDir);
      totalCompleted = files.size;
    } catch {
      // 忽略
    }

    const status = {
      sessions,
      system: {
        hostname: os.hostname(),
        uptime: Math.floor((Date.now() - this.startTime) / 1000),
        tunnelStatus: this.getTunnelStatusFn ? this.getTunnelStatusFn() : "disconnected",
      },
      history: {
        totalCompleted,
      },
    };

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(status));
  }

  /** 通过微信通道发送媒体文件（内部 API，仅 localhost） */
  private async handleWeixinSendMedia(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // 仅允许 localhost 访问
    const remote = req.socket.remoteAddress ?? "";
    if (!remote.includes("127.0.0.1") && !remote.includes("::1") && !remote.includes("::ffff:127.0.0.1")) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "仅允许本机访问" }));
      return;
    }

    if (!this.weixinChannel) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "微信通道未启动" }));
      return;
    }

    const body = await this.readBody(req);
    const { filePath, text } = JSON.parse(body) as { filePath: string; text?: string };

    if (!filePath) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "缺少 filePath 参数" }));
      return;
    }

    try {
      await (this.weixinChannel as any).sendLastReply(text ?? "", filePath);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    }
  }

  /** 主动发微信消息（内部 API，仅 localhost） */
  private async handleWeixinSend(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const remote = req.socket.remoteAddress ?? "";
    if (!remote.includes("127.0.0.1") && !remote.includes("::1") && !remote.includes("::ffff:127.0.0.1")) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "仅允许本机访问" }));
      return;
    }

    if (!this.weixinChannel) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "微信通道未启动" }));
      return;
    }

    const body = await this.readBody(req);
    const { to, text, filePath } = JSON.parse(body) as { to?: string; text?: string; filePath?: string };

    if (!text && !filePath) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "需要 text 或 filePath 参数" }));
      return;
    }

    try {
      const channel = this.weixinChannel as any;
      // 如果未指定 to，使用最近消息的发送者
      const targetUser = to || channel.getLastFromUserId?.();
      if (!targetUser) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "缺少 to 参数且没有最近的消息发送者" }));
        return;
      }

      await channel.sendProactive(targetUser, text ?? "", filePath);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, to: targetUser }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    }
  }

  /** 获取微信已知用户列表（内部 API，仅 localhost） */
  private handleWeixinUsers(req: http.IncomingMessage, res: http.ServerResponse): void {
    const remote = req.socket.remoteAddress ?? "";
    if (!remote.includes("127.0.0.1") && !remote.includes("::1") && !remote.includes("::ffff:127.0.0.1")) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "仅允许本机访问" }));
      return;
    }

    if (!this.weixinChannel) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "微信通道未启动" }));
      return;
    }

    const channel = this.weixinChannel as any;
    const users = channel.getKnownUsers?.() ?? [];
    const lastFrom = channel.getLastFromUserId?.() ?? null;

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ users, lastFrom }));
  }

  /**
   * 向所有连接广播心跳
   */
  private broadcastHeartbeat(): void {
    this.broadcastEvent("heartbeat", {
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
      tunnelStatus: this.getTunnelStatusFn ? this.getTunnelStatusFn() : "disconnected",
      activeSessions: this.stats.getActiveCount(),
      ts: Date.now(),
    });
  }

  /**
   * 向单个连接发送心跳（用于新连接初始化）
   */
  private sendHeartbeat(res: http.ServerResponse): void {
    const payload = `event: heartbeat\ndata: ${JSON.stringify({
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
      tunnelStatus: this.getTunnelStatusFn ? this.getTunnelStatusFn() : "disconnected",
      activeSessions: this.stats.getActiveCount(),
      ts: Date.now(),
    })}\n\n`;
    res.write(payload);
  }

  /** 代理：工具统计累计（供测试访问） */
  private incrementToolStat(sessionId: string | undefined, toolName: string): void {
    this.stats.incrementToolStat(sessionId, toolName);
  }

  /** 代理：消息计数累计（供测试访问） */
  private incrementMessageCount(sessionId: string | undefined): void {
    this.stats.incrementMessageCount(sessionId);
  }

  /** 设置 tunnel 状态获取函数 */
  setTunnelStatusFn(fn: () => string): void {
    this.getTunnelStatusFn = fn;
  }

  private readBody(req: http.IncomingMessage, maxBytes: number = 10 * 1024 * 1024): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = "";
      let size = 0;
      req.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) {
          req.destroy();
          reject(new Error("Request body too large"));
          return;
        }
        body += chunk;
      });
      req.on("end", () => resolve(body));
      req.on("error", reject);
    });
  }

  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      // 监听错误事件
      this.server.once('error', (err) => {
        reject(err);
      });

      const port = Number(process.env.PORT || 18080);
      this.server.listen(port, async () => {
        console.log(`[${this.isTls ? "HTTPS" : "HTTP"}] 服务启动在端口 ${port}`);

        // 动态加载并注册飞书通道（如果配置了环境变量）
        if (process.env.CHANNEL_FEISHU !== "false" && process.env.FEISHU_APP_ID && process.env.FEISHU_APP_SECRET) {
          try {
            const { FeishuChannel } = await import("./channels/feishu.js");
            this.feishuChannel = new FeishuChannel();
            this.feishuChannel.onMessage(async (message: string, images?: Array<{ data: string; mediaType: string }>, messageId?: string) => {
              await this.feishuCommands.processMessage(message, images, messageId);
            });
            this.channelManager.register(this.feishuChannel);
            // 注入 feishuChannel 到 FeishuCommands（延迟注入）
            (this.feishuCommands as any).deps.feishuChannel = this.feishuChannel;
            console.log("[Channels] 飞书通道已注册");
          } catch (err) {
            console.warn("[Channels] 飞书通道加载失败:", err);
          }
        } else {
          console.log("[Channels] 飞书通道未配置");
        }

        // 动态加载并注册微信通道（如果已登录）
        if (process.env.CHANNEL_WEIXIN !== "false") {
          try {
            const { WeixinChannel } = await import("./channels/weixin.js");
            const stateDir = join(this.cwd, ".claude", "skills", "mycc");
            this.weixinChannel = new WeixinChannel({ stateDir });

            if (this.weixinChannel.isLoggedIn()) {
              this.weixinChannel.onMessage(async (message: string) => {
                // 微信消息路由到 CC
                console.log(`[WeixinChannel] 转发消息到 CC: ${message.substring(0, 50)}...`);
                try {
                  const chunks: string[] = [];
                  for await (const data of adapter.chat({ message, cwd: this.cwd })) {
                    // 收集 assistant 回复文本
                    if (data && typeof data === "object" && "type" in data) {
                      if (data.type === "assistant" && "message" in data) {
                        const msg = (data as any).message;
                        if (msg?.content && Array.isArray(msg.content)) {
                          for (const block of msg.content) {
                            if (block?.type === "text" && block.text) {
                              chunks.push(block.text);
                            }
                          }
                        }
                      }
                    }
                  }
                  // 发送完整回复
                  if (chunks.length > 0 && this.weixinChannel) {
                    const fullReply = chunks.join("");
                    // 获取最近一个发消息的用户（从 channel 内部获取）
                    await (this.weixinChannel as any).sendLastReply(fullReply);
                  }
                } catch (err) {
                  console.error("[WeixinChannel] 处理消息失败:", err);
                }
              });

              this.channelManager.register(this.weixinChannel);
              console.log("[Channels] 微信通道已注册");
            } else {
              console.log("[Channels] 微信通道未登录，跳过（使用 /mycc-weixin 登录）");
            }
          } catch (err) {
            console.warn("[Channels] 微信通道加载失败:", err);
          }
        }

        // 启动所有通道（包括飞书长连接）
        await this.channelManager.startAll();

        // 启动心跳定时器
        this.heartbeatTimer = setInterval(() => {
          this.broadcastHeartbeat();
        }, HttpServer.HEARTBEAT_INTERVAL_MS);

        if (this.heartbeatTimer.unref) {
          this.heartbeatTimer.unref();
        }

        resolve(port);
      });
    });
  }

  stop() {
    // 清理心跳定时器
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    // 关闭所有 SSE 连接
    for (const res of this.eventListeners) {
      try { res.end(); } catch {}
    }
    this.eventListeners.clear();

    // 停止所有通道
    this.channelManager.stopAll();

    this.server.close();
  }
}
