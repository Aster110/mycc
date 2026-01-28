/**
 * HTTP 服务器
 * 提供 REST API 供小程序调用
 */
export declare class HttpServer {
    private server;
    private state;
    private cwd;
    constructor(pairCode: string, cwd: string, token?: string);
    private handleRequest;
    private handleHealth;
    private handlePair;
    private handleChat;
    private handleHistoryList;
    private handleHistoryDetail;
    private readBody;
    private generateToken;
    start(): Promise<number>;
    setToken(token: string): void;
    stop(): void;
}
//# sourceMappingURL=http-server.d.ts.map