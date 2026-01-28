/**
 * WebSocket 客户端
 * 连接中转服务器，处理消息转发
 */
export declare class WSClient {
    private ws;
    private deviceId;
    private pairCode;
    private cwd;
    private heartbeatTimer;
    private reconnectTimer;
    private isConnected;
    private isPaired;
    onPaired: (() => void) | null;
    onDisconnected: (() => void) | null;
    onError: ((error: string) => void) | null;
    constructor(deviceId: string, pairCode: string, cwd: string);
    /**
     * 连接到中转服务器
     */
    connect(): void;
    /**
     * 处理收到的消息
     */
    private handleMessage;
    /**
     * 处理聊天请求
     */
    private handleChat;
    /**
     * 发送消息
     */
    private send;
    /**
     * 启动心跳
     */
    private startHeartbeat;
    /**
     * 停止心跳
     */
    private stopHeartbeat;
    /**
     * 计划重连
     */
    private scheduleReconnect;
    /**
     * 关闭连接
     */
    close(): void;
    /**
     * 获取状态
     */
    getStatus(): {
        connected: boolean;
        paired: boolean;
    };
}
//# sourceMappingURL=ws-client.d.ts.map