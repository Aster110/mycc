"use strict";
/**
 * 历史记录处理
 * 读取 ~/.claude/projects/{encodedProjectName}/ 下的 JSONL 文件
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.encodeProjectPath = encodeProjectPath;
exports.getHistoryDir = getHistoryDir;
exports.getConversationList = getConversationList;
exports.getConversation = getConversation;
const fs_1 = require("fs");
const os_1 = require("os");
const path_1 = require("path");
/**
 * 过滤系统标签
 */
function stripSystemTags(text) {
    if (!text)
        return "";
    return text
        .replace(/<user-prompt-submit-hook[^>]*>[\s\S]*?<\/user-prompt-submit-hook>/g, "")
        .replace(/<short-term-memory[^>]*>[\s\S]*?<\/short-term-memory>/g, "")
        .replace(/<current-time[^>]*>[\s\S]*?<\/current-time>/g, "")
        .replace(/<system-reminder[^>]*>[\s\S]*?<\/system-reminder>/g, "")
        .replace(/<command-name[^>]*>[\s\S]*?<\/command-name>/g, "")
        .trim();
}
/**
 * 将项目路径编码为 Claude 使用的目录名
 * /Users/aster/AIproject/mylife → -Users-aster-AIproject-mylife
 */
function encodeProjectPath(projectPath) {
    return projectPath.replace(/\/$/, "").replace(/[/\\:._]/g, "-");
}
/**
 * 获取历史记录目录
 */
function getHistoryDir(cwd) {
    const encodedName = encodeProjectPath(cwd);
    return (0, path_1.join)((0, os_1.homedir)(), ".claude", "projects", encodedName);
}
/**
 * 获取对话列表
 */
function getConversationList(cwd) {
    const historyDir = getHistoryDir(cwd);
    if (!(0, fs_1.existsSync)(historyDir)) {
        return [];
    }
    const files = (0, fs_1.readdirSync)(historyDir).filter(f => f.endsWith(".jsonl"));
    const conversations = [];
    for (const file of files) {
        const filePath = (0, path_1.join)(historyDir, file);
        const sessionId = file.replace(".jsonl", "");
        try {
            const summary = parseConversationSummary(filePath, sessionId);
            if (summary) {
                conversations.push(summary);
            }
        }
        catch (err) {
            console.error(`[History] Failed to parse ${file}:`, err);
        }
    }
    // 按最后时间倒序排列（无日期的排到最后）
    conversations.sort((a, b) => {
        const timeA = a.lastTime ? new Date(a.lastTime).getTime() : 0;
        const timeB = b.lastTime ? new Date(b.lastTime).getTime() : 0;
        return timeB - timeA;
    });
    return conversations;
}
/**
 * 解析对话摘要
 */
function parseConversationSummary(filePath, sessionId) {
    const content = (0, fs_1.readFileSync)(filePath, "utf-8");
    const lines = content.trim().split("\n").filter(line => line.trim());
    if (lines.length === 0) {
        return null;
    }
    let startTime = "";
    let lastTime = "";
    let lastMessagePreview = "";
    let messageCount = 0;
    for (const line of lines) {
        try {
            const parsed = JSON.parse(line);
            messageCount++;
            // 跟踪时间戳
            if (!startTime || parsed.timestamp < startTime) {
                startTime = parsed.timestamp;
            }
            if (!lastTime || parsed.timestamp > lastTime) {
                lastTime = parsed.timestamp;
            }
            // 提取最后一条消息预览（user 消息，过滤系统标签）
            if (parsed.type === "user" && parsed.message?.content) {
                const content = parsed.message.content;
                let rawPreview = "";
                if (typeof content === "string") {
                    rawPreview = content;
                }
                else if (Array.isArray(content)) {
                    for (const item of content) {
                        if (typeof item === "object" && item && "text" in item) {
                            rawPreview = String(item.text);
                            break;
                        }
                    }
                }
                // 过滤系统标签后截取
                const cleanPreview = stripSystemTags(rawPreview);
                if (cleanPreview) {
                    lastMessagePreview = cleanPreview.substring(0, 100);
                }
            }
        }
        catch {
            // 忽略解析错误的行
        }
    }
    return {
        sessionId,
        startTime,
        lastTime,
        messageCount,
        lastMessagePreview: lastMessagePreview || "(无预览)",
    };
}
/**
 * 获取具体对话内容
 */
function getConversation(cwd, sessionId) {
    // 验证 sessionId 格式（防止路径遍历攻击）
    if (!sessionId || /[<>:"|?*\x00-\x1f\/\\]/.test(sessionId)) {
        return null;
    }
    const historyDir = getHistoryDir(cwd);
    const filePath = (0, path_1.join)(historyDir, `${sessionId}.jsonl`);
    if (!(0, fs_1.existsSync)(filePath)) {
        return null;
    }
    const content = (0, fs_1.readFileSync)(filePath, "utf-8");
    const lines = content.trim().split("\n").filter(line => line.trim());
    const messages = [];
    for (const line of lines) {
        try {
            const parsed = JSON.parse(line);
            messages.push(parsed);
        }
        catch {
            // 忽略解析错误的行
        }
    }
    return {
        sessionId,
        messages,
    };
}
//# sourceMappingURL=history.js.map