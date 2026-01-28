/**
 * Claude Code SDK 桥接
 * 核心：调用 CC SDK 的 query 函数
 */
export interface ChatOptions {
    message: string;
    sessionId?: string;
    cwd?: string;
    onMessage: (msg: unknown) => void;
    onDone: (sessionId: string) => void;
    onError: (error: string) => void;
}
/**
 * 执行 CC 对话
 */
export declare function executeChat(options: ChatOptions): Promise<void>;
/**
 * 检查 CC CLI 是否可用
 */
export declare function checkCCAvailable(): Promise<boolean>;
//# sourceMappingURL=cc-bridge.d.ts.map