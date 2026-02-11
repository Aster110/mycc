/**
 * HTTP 服务器
 * 支持单用户模式（pairCode）和多用户模式（JWT）
 */

import http from "http";
import { readFileSync } from "fs";
import { join } from "path";
import { generateToken } from "./utils.js";
import { adapter } from "./adapters/index.js";
import type { PairState } from "./types.js";
import { validateImages, type ImageData } from "./image-utils.js";
import { renameSession } from "./history.js";
import { verifyToken, register, login, getCurrentUser, type JWTPayload } from "./auth/service.js";
import { checkQuota } from "./db/client.js";
import { concurrencyLimiter } from "./concurrency-limiter.js";

const PORT = process.env.PORT || 8080;

export type ServerMode = "single-user" | "multi-user";

export class HttpServer {
  private server: http.Server;
  private mode: ServerMode;

  // 单用户模式字段
  private state?: PairState;
  private cwd?: string;
  private onPaired?: (token: string) => void;

  constructor(options: { mode: "multi-user" } | { mode?: "single-user"; pairCode: string; cwd: string; authToken?: string }) {
    if ("pairCode" in options) {
      // 单用户模式（兼容原有逻辑）
      this.mode = "single-user";
      this.cwd = options.cwd;
      this.state = {
        pairCode: options.pairCode,
        paired: !!options.authToken,
        token: options.authToken || null,
      };
    } else {
      // 多用户模式
      this.mode = "multi-user";
    }

    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res);
    });
  }

  /** 设置配对成功回调（单用户模式） */
  setOnPaired(callback: (token: string) => void) {
    this.onPaired = callback;
  }

  /** 获取当前 authToken（单用户模式） */
  getAuthToken(): string | null {
    return this.state?.token || null;
  }

  // ============ JWT 认证（多用户模式） ============

  private getUserFromToken(req: http.IncomingMessage): JWTPayload | null {
    const authHeader = req.headers.authorization;
    const token = authHeader?.replace("Bearer ", "");
    if (!token) return null;

    try {
      return verifyToken(token);
    } catch {
      return null;
    }
  }

  private getUserCwd(linuxUser: string): string {
    const isDev = process.env.NODE_ENV === "development";
    return isDev
      ? `/tmp/mycc_dev/${linuxUser}/workspace`
      : `/home/${linuxUser}/workspace`;
  }

  // ============ 认证检查（根据模式） ============

  /** 验证请求认证，返回 cwd。失败返回 null 并写入 401 响应 */
  private authenticateRequest(req: http.IncomingMessage, res: http.ServerResponse): { cwd: string; userId?: number } | null {
    if (this.mode === "single-user") {
      const authHeader = req.headers.authorization;
      const token = authHeader?.replace("Bearer ", "");

      if (!this.state?.paired || token !== this.state.token) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "未授权" }));
        return null;
      }
      return { cwd: this.cwd! };
    } else {
      // 多用户模式
      const user = this.getUserFromToken(req);
      if (!user) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ code: 401, message: "未授权，请登录" }));
        return null;
      }
      return { cwd: this.getUserCwd(user.linuxUser), userId: user.userId };
    }
  }

  // ============ 路由分发 ============

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
      // 公开路由（不需要认证）
      if (url.pathname === "/health" && req.method === "GET") {
        this.handleHealth(res);
        return;
      }

      // 单用户模式：配对路由
      if (this.mode === "single-user" && url.pathname === "/pair" && req.method === "POST") {
        await this.handlePair(req, res);
        return;
      }

      // 多用户模式：认证路由
      if (this.mode === "multi-user") {
        if (url.pathname === "/api/auth/register" && req.method === "POST") {
          await this.handleRegister(req, res);
          return;
        }
        if (url.pathname === "/api/auth/login" && req.method === "POST") {
          await this.handleLogin(req, res);
          return;
        }
        if (url.pathname === "/api/auth/me" && req.method === "GET") {
          await this.handleMe(req, res);
          return;
        }
        if (url.pathname === "/api/billing/subscription" && req.method === "GET") {
          await this.handleBillingSubscription(req, res);
          return;
        }
        if (url.pathname === "/api/billing/usage" && req.method === "GET") {
          await this.handleBillingUsage(req, res);
          return;
        }
        if (url.pathname === "/api/billing/upgrade" && req.method === "POST") {
          await this.handleBillingUpgrade(req, res);
          return;
        }
      }

      // 静态资源路由（不需要认证）
      if (url.pathname.startsWith('/assets/')) {
        this.handleStatic(req, res, url.pathname);
        return;
      }

      // 需要认证的路由
      if (url.pathname === "/api/chat" && req.method === "POST") {
        await this.handleChat(req, res);
      } else if (url.pathname === "/api/projects" && req.method === "GET") {
        await this.handleProjects(req, res);
      } else if (url.pathname.match(/^\/api\/projects\/[^/]+\/histories$/) && req.method === "GET") {
        await this.handleHistoryList(req, res);
      } else if (url.pathname.match(/^\/api\/projects\/[^/]+\/histories\/[^/]+$/) && req.method === "GET") {
        await this.handleHistoryDetail(req, res, url.pathname);
      } else if (url.pathname === "/api/chat/rename" && req.method === "POST") {
        await this.handleRename(req, res);
      } else if (url.pathname === "/" && req.method === "GET") {
        // Serve 前端页面
        this.handleIndex(res);
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

  /** Serve 前端页面 */
  private handleIndex(res: http.ServerResponse) {
    try {
      // 从 scripts/src/ 到 mycc-web-react/dist/
      const indexPath = join(import.meta.dirname, '..', '..', '..', '..', '..', 'mycc-web-react', 'dist', 'index.html');
      const html = readFileSync(indexPath, 'utf-8');
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Frontend not found");
    }
  }

  /** Serve 静态资源 */
  private handleStatic(req: http.IncomingMessage, res: http.ServerResponse, pathname: string) {
    try {
      const staticPath = join(import.meta.dirname, '..', '..', '..', '..', '..', 'mycc-web-react', 'dist', pathname);
      const content = readFileSync(staticPath);
      const ext = pathname.split('.').pop();
      const contentType = {
        'js': 'application/javascript',
        'css': 'text/css',
        'png': 'image/png',
        'jpg': 'image/jpeg',
        'svg': 'image/svg+xml',
      }[ext || ''] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    } catch {
      res.writeHead(404);
      res.end();
    }
  }

  // ============ 公开路由 ============

  private handleHealth(res: http.ServerResponse) {
    res.writeHead(200, { "Content-Type": "application/json" });
    if (this.mode === "single-user") {
      res.end(JSON.stringify({ status: "ok", paired: this.state?.paired }));
    } else {
      res.end(JSON.stringify({ status: "ok", mode: "multi-user" }));
    }
  }

  // ============ 单用户模式路由 ============

  private async handlePair(req: http.IncomingMessage, res: http.ServerResponse) {
    const body = await this.readBody(req);
    const { pairCode } = JSON.parse(body);

    if (pairCode !== this.state!.pairCode) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "配对码错误" }));
      return;
    }

    // 如果已配对，返回相同 token（不覆盖）
    if (this.state!.paired && this.state!.token) {
      console.log("[HTTP] 已配对，返回现有 token");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, token: this.state!.token }));
      return;
    }

    // 首次配对，生成 token
    const token = generateToken();
    this.state!.paired = true;
    this.state!.token = token;

    console.log("[HTTP] 配对成功!");

    // 通知外部保存 authToken
    if (this.onPaired) {
      this.onPaired(token);
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, token }));
  }

  // ============ 多用户模式路由：认证 ============

  private async handleRegister(req: http.IncomingMessage, res: http.ServerResponse) {
    try {
      const body = await this.readBody(req);
      const { phone, email, password, nickname } = JSON.parse(body);

      const result = await register({ phone, email, password, nickname });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: 0, data: result }));
    } catch (error) {
      const message = error instanceof Error ? error.message : "注册失败";
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: 400, message }));
    }
  }

  private async handleLogin(req: http.IncomingMessage, res: http.ServerResponse) {
    try {
      const body = await this.readBody(req);
      const { phone, email, credential, password } = JSON.parse(body);

      // 兼容 phone / email / credential 三种字段
      const loginCredential = credential || phone || email;
      if (!loginCredential) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ code: 400, message: "请提供手机号或邮箱" }));
        return;
      }

      const result = await login({ credential: loginCredential, password });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: 0, data: result }));
    } catch (error) {
      const message = error instanceof Error ? error.message : "登录失败";
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: 401, message }));
    }
  }

  private async handleMe(req: http.IncomingMessage, res: http.ServerResponse) {
    const user = this.getUserFromToken(req);
    if (!user) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: 401, message: "未授权" }));
      return;
    }

    try {
      const userInfo = await getCurrentUser(user.userId);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: 0, data: userInfo }));
    } catch (error) {
      const message = error instanceof Error ? error.message : "获取用户信息失败";
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: 500, message }));
    }
  }

  // ============ 多用户模式路由：计费 ============

  private async handleBillingSubscription(req: http.IncomingMessage, res: http.ServerResponse) {
    const user = this.getUserFromToken(req);
    if (!user) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: 401, message: "未授权" }));
      return;
    }

    try {
      const userInfo = await getCurrentUser(user.userId);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: 0, data: userInfo.subscription }));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: 500, message: "获取订阅信息失败" }));
    }
  }

  private async handleBillingUsage(req: http.IncomingMessage, res: http.ServerResponse) {
    const user = this.getUserFromToken(req);
    if (!user) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: 401, message: "未授权" }));
      return;
    }

    try {
      const { getUsageStats } = await import("./db/client.js");
      const stats = await getUsageStats(user.userId);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: 0, data: stats }));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: 500, message: "获取使用记录失败" }));
    }
  }

  private async handleBillingUpgrade(req: http.IncomingMessage, res: http.ServerResponse) {
    const user = this.getUserFromToken(req);
    if (!user) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: 401, message: "未授权" }));
      return;
    }

    try {
      const body = await this.readBody(req);
      const { plan } = JSON.parse(body);

      // 验证套餐类型
      if (!['basic', 'pro'].includes(plan)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ code: 400, message: "无效的套餐类型" }));
        return;
      }

      // 获取当前订阅信息
      const userInfo = await getCurrentUser(user.userId);
      if (!userInfo.subscription) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ code: 500, message: "用户订阅信息不存在" }));
        return;
      }
      const currentPlan = userInfo.subscription.plan;

      // 检查是否降级（不允许）
      const planOrder: Record<string, number> = { free: 0, basic: 1, pro: 2 };
      if (planOrder[plan] <= planOrder[currentPlan]) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ code: 400, message: "不支持降级或重复升级" }));
        return;
      }

      // 执行升级
      const { upgradePlan } = await import("./db/client.js");
      await upgradePlan(user.userId, plan);

      // 获取新的订阅信息
      const newUserInfo = await getCurrentUser(user.userId);
      if (!newUserInfo.subscription) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ code: 500, message: "升级后订阅信息不存在" }));
        return;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        code: 0,
        data: {
          plan: newUserInfo.subscription.plan,
          tokens_limit: newUserInfo.subscription.tokens_limit,
          expires_at: newUserInfo.subscription.expires_at,
        }
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : "升级套餐失败";
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: 500, message }));
    }
  }

  // ============ 需要认证的路由 ============

  private async handleChat(req: http.IncomingMessage, res: http.ServerResponse) {
    const auth = this.authenticateRequest(req, res);
    if (!auth) return;

    // 多用户模式：检查额度和并发
    if (this.mode === "multi-user" && auth.userId) {
      // 检查额度
      const quota = await checkQuota(auth.userId);
      if (!quota.allowed) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ code: 403, message: "额度已用完，请升级套餐" }));
        return;
      }

      // 并发控制（非阻塞检查，如果已有对话在进行则拒绝）
      try {
        // 使用 Promise.race 实现超时检查
        const acquired = await Promise.race([
          concurrencyLimiter.acquire(auth.userId).then(() => true),
          new Promise<false>((resolve) => setTimeout(() => resolve(false), 100)),
        ]);

        if (!acquired) {
          res.writeHead(429, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ code: 429, message: "您有正在进行的对话，请稍后再试" }));
          return;
        }
      } catch {
        res.writeHead(429, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ code: 429, message: "服务繁忙，请稍后再试" }));
        return;
      }
    }

    const body = await this.readBody(req);
    const { message, sessionId, images } = JSON.parse(body) as {
      message: string;
      sessionId?: string;
      images?: ImageData[];
    };

    // 校验图片
    const imageValidation = validateImages(images);
    if (!imageValidation.valid) {
      if (this.mode === "multi-user" && auth.userId) {
        concurrencyLimiter.release(auth.userId);
      }
      res.writeHead(imageValidation.code || 400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: imageValidation.error }));
      return;
    }

    const hasImages = images && images.length > 0;
    console.log(`[CC] 收到消息: ${message.substring(0, 50)}...${hasImages ? ` (附带 ${images.length} 张图片)` : ""}`);

    // 设置 SSE 响应头
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });

    let currentSessionId = sessionId;

    try {
      // 使用 adapter 的 chat 方法（返回 AsyncIterable）
      for await (const data of adapter.chat({ message, sessionId, cwd: auth.cwd, images })) {
        // 提取 session_id
        if (data && typeof data === "object" && "type" in data) {
          if (data.type === "system" && "session_id" in data) {
            currentSessionId = data.session_id as string;
          }
        }
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      }

      // 完成
      res.write(`data: ${JSON.stringify({ type: "done", sessionId: currentSessionId })}\n\n`);
      res.end();
      console.log(`[CC] 完成`);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      res.write(`data: ${JSON.stringify({ type: "error", error: errMsg })}\n\n`);
      res.end();
      console.error(`[CC] 错误: ${errMsg}`);
    } finally {
      // 多用户模式：释放并发许可
      if (this.mode === "multi-user" && auth.userId) {
        concurrencyLimiter.release(auth.userId);
      }
    }
  }

  private async handleProjects(req: http.IncomingMessage, res: http.ServerResponse) {
    const auth = this.authenticateRequest(req, res);
    if (!auth) return;

    try {
      // 多用户模式：返回用户的工作目录作为项目
      // 单用户模式：返回当前工作目录
      const projectPath = auth.cwd;
      console.log(`[Projects] Original path: ${projectPath}`);

      // 使用和 Claude Code SDK 一致的编码方式
      const { encodeProjectPath } = await import("./history.js");
      const encodedName = encodeProjectPath(projectPath);
      console.log(`[Projects] Encoded name: ${encodedName}`);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        projects: [{
          path: projectPath,
          encodedName: encodedName
        }]
      }));
    } catch (error) {
      console.error("[Projects] Error:", error);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "获取项目列表失败" }));
    }
  }

  private async handleHistoryList(req: http.IncomingMessage, res: http.ServerResponse) {
    const auth = this.authenticateRequest(req, res);
    if (!auth) return;

    try {
      // 解析 limit 参数（默认 20，传 0 或不传数字则返回全部）
      const url = new URL(req.url || "", `http://${req.headers.host}`);
      const limitParam = url.searchParams.get("limit");
      const limit = limitParam ? parseInt(limitParam, 10) : 20;

      // 使用 adapter 的 listHistory 方法
      const result = await adapter.listHistory(auth.cwd, limit);

      console.log(`[History] 返回 ${result.conversations.length}/${result.total} 条历史记录 (cwd: ${auth.cwd})`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (error) {
      console.error("[History] List error:", error);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "获取历史记录失败" }));
    }
  }

  private async handleHistoryDetail(req: http.IncomingMessage, res: http.ServerResponse, pathname: string) {
    const auth = this.authenticateRequest(req, res);
    if (!auth) return;

    // 提取 sessionId: /api/projects/{encodedPath}/histories/{sessionId}
    const match = pathname.match(/^\/api\/projects\/[^/]+\/histories\/([^/]+)$/);
    if (!match) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "无效的路径格式" }));
      return;
    }

    const sessionId = match[1];

    if (!sessionId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "无效的 sessionId" }));
      return;
    }

    try {
      // 使用 adapter 的 getHistory 方法
      const conversation = await adapter.getHistory(auth.cwd, sessionId);
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
    const auth = this.authenticateRequest(req, res);
    if (!auth) return;

    try {
      const body = await this.readBody(req);
      const { sessionId, newTitle } = JSON.parse(body);

      // 验证输入
      if (!sessionId || typeof newTitle !== "string") {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "sessionId and newTitle are required" }));
        return;
      }

      // 执行重命名
      const success = renameSession(sessionId, newTitle, auth.cwd);

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

  // ============ 工具方法 ============

  private readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => resolve(body));
      req.on("error", reject);
    });
  }

  start(): Promise<number> {
    return new Promise((resolve, reject) => {
      // 监听错误事件
      this.server.once('error', (err) => {
        reject(err);
      });

      this.server.listen(PORT, () => {
        console.log(`[HTTP] 服务启动在端口 ${PORT} (${this.mode} 模式)`);
        resolve(Number(PORT));
      });
    });
  }

  stop() {
    this.server.close();
  }
}
