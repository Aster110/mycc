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
import { renameSession } from "./history.js";
import { listSkills } from "./skills.js";

const PORT = process.env.PORT || 8080;

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
  private onPaired?: (token: string) => void;
  private isTls: boolean;

  constructor(pairCode: string, cwd: string, authToken?: string, tls?: TlsConfig) {
    this.cwd = cwd;
    // 如果传入了 authToken，说明之前已配对过
    this.state = {
      pairCode,
      paired: !!authToken,
      token: authToken || null,
    };

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
    const { message, sessionId, images, model } = parsed as {
      message: string;
      sessionId?: string;
      images?: ImageData[];
      model?: string;
    };

    // 校验图片
    const imageValidation = validateImages(images);
    if (!imageValidation.valid) {
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
      for await (const data of adapter.chat({ message, sessionId, cwd: this.cwd, images, model: model || undefined })) {
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

  start(): Promise<number> {
    return new Promise((resolve, reject) => {
      // 监听错误事件
      this.server.once('error', (err) => {
        reject(err);
      });

      const port = Number(process.env.PORT || 8080);
      this.server.listen(port, () => {
        console.log(`[${this.isTls ? "HTTPS" : "HTTP"}] 服务启动在端口 ${port}`);
        resolve(port);
      });
    });
  }

  stop() {
    this.server.close();
  }
}
