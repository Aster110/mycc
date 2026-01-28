/**
 * 历史记录处理
 * 读取 ~/.claude/projects/{encodedProjectName}/ 下的 JSONL 文件
 */
interface RawHistoryLine {
    type: "user" | "assistant" | "system" | "result";
    message?: {
        role?: string;
        content?: unknown;
        id?: string;
    };
    sessionId: string;
    timestamp: string;
    uuid: string;
    parentUuid?: string | null;
    isSidechain?: boolean;
    cwd?: string;
}
export interface ConversationSummary {
    sessionId: string;
    startTime: string;
    lastTime: string;
    messageCount: number;
    lastMessagePreview: string;
}
export interface ConversationHistory {
    sessionId: string;
    messages: RawHistoryLine[];
}
/**
 * 将项目路径编码为 Claude 使用的目录名
 * /Users/aster/AIproject/mylife → -Users-aster-AIproject-mylife
 */
export declare function encodeProjectPath(projectPath: string): string;
/**
 * 获取历史记录目录
 */
export declare function getHistoryDir(cwd: string): string;
/**
 * 获取对话列表
 */
export declare function getConversationList(cwd: string): ConversationSummary[];
/**
 * 获取具体对话内容
 */
export declare function getConversation(cwd: string, sessionId: string): ConversationHistory | null;
export {};
//# sourceMappingURL=history.d.ts.map