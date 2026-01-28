"use strict";
/**
 * WebSocket 客户端
 * 连接中转服务器，处理消息转发
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.WSClient = void 0;
const ws_1 = __importDefault(require("ws"));
const cc_bridge_js_1 = require("./cc-bridge.js");
const RELAY_SERVER = process.env.RELAY_SERVER || "wss://cc-relay.your-domain.workers.dev";
const HEARTBEAT_INTERVAL = 30000; // 30 秒心跳
const RECONNECT_DELAY = 5000; // 5 秒重连
class WSClient {
    ws = null;
    deviceId;
    pairCode;
    cwd;
    heartbeatTimer = null;
    reconnectTimer = null;
    isConnected = false;
    isPaired = false;
    onPaired = null;
    onDisconnected = null;
    onError = null;
    constructor(deviceId, pairCode, cwd) {
        this.deviceId = deviceId;
        this.pairCode = pairCode;
        this.cwd = cwd;
    }
    /**
     * 连接到中转服务器
     */
    connect() {
        if (this.ws) {
            this.ws.close();
        }
        console.log(`[WS] 连接中转服务器: ${RELAY_SERVER}`);
        this.ws = new ws_1.default(RELAY_SERVER);
        this.ws.on("open", () => {
            console.log("[WS] 连接成功");
            this.isConnected = true;
            // 注册设备
            this.send({
                type: "register",
                deviceId: this.deviceId,
                pairCode: this.pairCode,
            });
            // 启动心跳
            this.startHeartbeat();
        });
        this.ws.on("message", (data) => {
            try {
                const msg = JSON.parse(data.toString());
                this.handleMessage(msg);
            }
            catch (e) {
                console.error("[WS] 解析消息失败:", e);
            }
        });
        this.ws.on("close", () => {
            console.log("[WS] 连接断开");
            this.isConnected = false;
            this.isPaired = false;
            this.stopHeartbeat();
            this.onDisconnected?.();
            // 自动重连
            this.scheduleReconnect();
        });
        this.ws.on("error", (error) => {
            console.error("[WS] 错误:", error.message);
            this.onError?.(error.message);
        });
    }
    /**
     * 处理收到的消息
     */
    handleMessage(msg) {
        switch (msg.type) {
            case "pair_success":
                console.log("[WS] 配对成功!");
                this.isPaired = true;
                this.onPaired?.();
                break;
            case "chat":
                this.handleChat(msg);
                break;
            case "pong":
                // 心跳响应，忽略
                break;
            default:
                console.log("[WS] 未知消息类型:", msg.type);
        }
    }
    /**
     * 处理聊天请求
     */
    async handleChat(msg) {
        console.log(`[CC] 收到消息: ${msg.message.substring(0, 50)}...`);
        await (0, cc_bridge_js_1.executeChat)({
            message: msg.message,
            sessionId: msg.sessionId,
            cwd: this.cwd,
            onMessage: (data) => {
                const response = {
                    type: "chat_response",
                    requestId: msg.requestId,
                    data,
                };
                this.send(response);
            },
            onDone: (sessionId) => {
                const done = {
                    type: "chat_done",
                    requestId: msg.requestId,
                    sessionId,
                };
                this.send(done);
                console.log(`[CC] 完成: ${msg.requestId}`);
            },
            onError: (error) => {
                const errMsg = {
                    type: "chat_error",
                    requestId: msg.requestId,
                    error,
                };
                this.send(errMsg);
                console.error(`[CC] 错误: ${error}`);
            },
        });
    }
    /**
     * 发送消息
     */
    send(msg) {
        if (this.ws && this.ws.readyState === ws_1.default.OPEN) {
            this.ws.send(JSON.stringify(msg));
        }
    }
    /**
     * 启动心跳
     */
    startHeartbeat() {
        this.stopHeartbeat();
        this.heartbeatTimer = setInterval(() => {
            this.send({ type: "ping" });
        }, HEARTBEAT_INTERVAL);
    }
    /**
     * 停止心跳
     */
    stopHeartbeat() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }
    /**
     * 计划重连
     */
    scheduleReconnect() {
        if (this.reconnectTimer)
            return;
        console.log(`[WS] ${RECONNECT_DELAY / 1000} 秒后重连...`);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, RECONNECT_DELAY);
    }
    /**
     * 关闭连接
     */
    close() {
        this.stopHeartbeat();
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
    }
    /**
     * 获取状态
     */
    getStatus() {
        return {
            connected: this.isConnected,
            paired: this.isPaired,
        };
    }
}
exports.WSClient = WSClient;
//# sourceMappingURL=ws-client.js.map