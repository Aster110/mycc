"use strict";
/**
 * HTTP 服务器
 * 提供 REST API 供小程序调用
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.HttpServer = void 0;
const http_1 = __importDefault(require("http"));
const cc_bridge_js_1 = require("./cc-bridge.js");
const history_js_1 = require("./history.js");
const PORT = process.env.PORT || 8080;
class HttpServer {
    server;
    state;
    cwd;
    constructor(pairCode, cwd, token) {
        this.cwd = cwd;
        this.state = {
            pairCode,
            paired: token ? true : false,
            token: token || null,
        };
        this.server = http_1.default.createServer((req, res) => {
            this.handleRequest(req, res);
        });
    }
    async handleRequest(req, res) {
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
            }
            else if (url.pathname === "/pair" && req.method === "POST") {
                await this.handlePair(req, res);
            }
            else if (url.pathname === "/chat" && req.method === "POST") {
                await this.handleChat(req, res);
            }
            else if (url.pathname === "/history/list" && req.method === "GET") {
                this.handleHistoryList(req, res);
            }
            else if (url.pathname.startsWith("/history/") && req.method === "GET") {
                this.handleHistoryDetail(req, res, url.pathname);
            }
            else {
                res.writeHead(404, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "Not Found" }));
            }
        }
        catch (error) {
            console.error("[HTTP] Error:", error);
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Internal Server Error" }));
        }
    }
    handleHealth(res) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", paired: this.state.paired }));
    }
    async handlePair(req, res) {
        const body = await this.readBody(req);
        const { pairCode } = JSON.parse(body);
        if (pairCode !== this.state.pairCode) {
            res.writeHead(401, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "配对码错误" }));
            return;
        }
        // 如果已配对（通过构造函数传入 token），返回现有 token
        if (this.state.paired && this.state.token) {
            console.log(`[HTTP] 已配对，返回现有 token: ${this.state.token}`);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: true, token: this.state.token }));
            return;
        }
        // 理论上不会走到这里，因为 token 应该在构造函数中传入
        // 但保留 fallback 逻辑
        const token = this.state.token || this.generateToken();
        this.state.paired = true;
        this.state.token = token;
        console.log(`[HTTP] 配对成功! Token: ${token}`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, token }));
    }
    async handleChat(req, res) {
        // 验证 token
        const authHeader = req.headers.authorization;
        const token = authHeader?.replace("Bearer ", "");
        console.log(`[HTTP] 聊天请求: token=${token}, paired=${this.state.paired}, expected token=${this.state.token}`);
        if (!this.state.paired || token !== this.state.token) {
            console.log(`[HTTP] 未授权: token mismatch or not paired`);
            res.writeHead(401, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "未授权" }));
            return;
        }
        const body = await this.readBody(req);
        const { message, sessionId } = JSON.parse(body);
        console.log(`[CC] 收到消息: ${message.substring(0, 50)}... (sessionId: ${sessionId})`);
        // 设置 SSE 响应头
        res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
        });
        let currentSessionId = sessionId;
        await (0, cc_bridge_js_1.executeChat)({
            message,
            sessionId,
            cwd: this.cwd,
            onMessage: (data) => {
                // 提取 session_id
                if (data && typeof data === "object" && "type" in data) {
                    if (data.type === "system" && "session_id" in data) {
                        currentSessionId = data.session_id;
                    }
                }
                res.write(`data: ${JSON.stringify(data)}\n\n`);
            },
            onDone: (sid) => {
                res.write(`data: ${JSON.stringify({ type: "done", sessionId: sid })}\n\n`);
                res.end();
                console.log(`[CC] 完成`);
            },
            onError: (error) => {
                res.write(`data: ${JSON.stringify({ type: "error", error })}\n\n`);
                res.end();
                console.error(`[CC] 错误: ${error}`);
            },
        });
    }
    handleHistoryList(req, res) {
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
            let conversations = (0, history_js_1.getConversationList)(this.cwd);
            const total = conversations.length;
            // 如果 limit > 0，只返回前 limit 条
            if (limit > 0) {
                conversations = conversations.slice(0, limit);
            }
            console.log(`[History] 返回 ${conversations.length}/${total} 条历史记录 (cwd: ${this.cwd})`);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ conversations, total, hasMore: conversations.length < total }));
        }
        catch (error) {
            console.error("[History] List error:", error);
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "获取历史记录失败" }));
        }
    }
    handleHistoryDetail(req, res, pathname) {
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
            const conversation = (0, history_js_1.getConversation)(this.cwd, sessionId);
            if (!conversation) {
                res.writeHead(404, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "对话不存在" }));
                return;
            }
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(conversation));
        }
        catch (error) {
            console.error("[History] Detail error:", error);
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "获取对话详情失败" }));
        }
    }
    readBody(req) {
        return new Promise((resolve, reject) => {
            let body = "";
            req.on("data", (chunk) => (body += chunk));
            req.on("end", () => resolve(body));
            req.on("error", reject);
        });
    }
    generateToken() {
        // 大写字母+数字，6位，去掉易混淆的 I/O/0/1
        const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
        let token = "";
        for (let i = 0; i < 6; i++) {
            token += chars[Math.floor(Math.random() * chars.length)];
        }
        return token;
    }
    start() {
        return new Promise((resolve) => {
            this.server.listen(PORT, () => {
                console.log(`[HTTP] 服务启动在端口 ${PORT}`);
                resolve(Number(PORT));
            });
        });
    }
    setToken(token) {
        this.state.token = token;
        this.state.paired = true;
        console.log(`[HTTP] Token 已更新: ${token}`);
    }
    stop() {
        this.server.close();
    }
}
exports.HttpServer = HttpServer;
//# sourceMappingURL=http-server.js.map