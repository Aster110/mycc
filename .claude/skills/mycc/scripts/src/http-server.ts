/**
 * HTTP 服务器
 * 提供 REST API 供小程序调用
 */

import http from "http";
import { generateToken } from "./utils.js";
import { adapter } from "./adapters/index.js";
import type { PairState } from "./types.js";
import { validateImages, type ImageData } from "./image-utils.js";

const PORT = process.env.PORT || 8080;

export class HttpServer {
  private server: http.Server;
  private state: PairState;
  private cwd: string;
  private onPaired?: (token: string) => void;

  constructor(pairCode: string, cwd: string, authToken?: string) {
    this.cwd = cwd;
    // 如果传入了 authToken，说明之前已配对过
    this.state = {
      pairCode,
      paired: !!authToken,
      token: authToken || null,
    };

    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res);
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
    res.end(JSON.stringify({ status: "ok", paired: this.state.paired }));
  }

  private async handlePair(req: http.IncomingMessage, res: http.ServerResponse) {
    const body = await this.readBody(req);
    const { pairCode } = JSON.parse(body);

    if (pairCode !== this.state.pairCode) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "配对码错误" }));
      return;
    }

    // 如果已配对，返回相同 token（不覆盖）
    if (this.state.paired && this.state.token) {
      console.log("[HTTP] 已配对，返回现有 token");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, token: this.state.token }));
      return;
    }

    // 首次配对，生成 token
    const token = generateToken();
    this.state.paired = true;
    this.state.token = token;

    console.log("[HTTP] 配对成功!");

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
    const { message, sessionId, images } = JSON.parse(body) as {
      message: string;
      sessionId?: string;
      images?: ImageData[];
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
      for await (const data of adapter.chat({ message, sessionId, cwd: this.cwd, images })) {
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

  private readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => resolve(body));
      req.on("error", reject);
    });
  }

  start(): Promise<number> {
    return new Promise((resolve) => {
      this.server.listen(PORT, () => {
        console.log(`[HTTP] 服务启动在端口 ${PORT}`);
        resolve(Number(PORT));
      });
    });
  }

  stop() {
    this.server.close();
  }
}
