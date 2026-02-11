/**
 * Claude Code SDK 桥接
 * 核心：调用 CC SDK 的 query 函数
 */

import { query } from "@anthropic-ai/claude-code";
import { execSync } from "child_process";
import type { ChatOptions } from "./types.js";

// 检测 Claude CLI 路径
function detectClaudeCliPath(): string {
  try {
    return execSync("which claude", { encoding: "utf-8" }).trim();
  } catch {
    return "/usr/local/bin/claude"; // fallback
  }
}

const CLAUDE_CLI_PATH = detectClaudeCliPath();

/**
 * 执行 CC 对话
 */
export async function executeChat(options: ChatOptions): Promise<void> {
  const { message, sessionId, cwd, onMessage, onDone, onError } = options;

  let currentSessionId = sessionId || "";

  try {
    for await (const sdkMessage of query({
      prompt: message,
      options: {
        // 指定 CLI 路径，确保完整加载配置（包括 skills）
        executable: "node" as const,
        pathToClaudeCodeExecutable: CLAUDE_CLI_PATH,
        cwd: cwd || process.cwd(),
        resume: sessionId || undefined,
        // 小程序端无法交互确认权限，使用 bypassPermissions
        // 注意：这需要用户信任，后续可以改成更安全的模式
        permissionMode: "bypassPermissions",
        // SDK 不支持 Skill 工具，工蚁需手动读取 skill 文件执行
      },
    })) {
      // 提取 session_id
      if (
        sdkMessage &&
        typeof sdkMessage === "object" &&
        "type" in sdkMessage &&
        sdkMessage.type === "system" &&
        "session_id" in sdkMessage
      ) {
        currentSessionId = sdkMessage.session_id as string;
      }

      // 流式发送消息
      onMessage(sdkMessage);
    }

    // 完成
    onDone(currentSessionId);
  } catch (error) {
    onError(error instanceof Error ? error.message : String(error));
  }
}

/**
 * 检查 CC CLI 是否可用
 * 使用 detectClaudeCliPath 跨平台检测，避免 PATH 不完整导致找不到
 */
export async function checkCCAvailable(): Promise<boolean> {
  try {
    const { detectClaudeCliPath } = await import("./platform.js");
    const { executable, cliPath } = detectClaudeCliPath();
    const { execSync } = await import("child_process");

    if (executable === "node") {
      execSync(`node "${cliPath}" --version`, { stdio: "pipe" });
    } else {
      execSync(`"${cliPath}" --version`, { stdio: "pipe" });
    }
    return true;
  } catch {
    return false;
  }
}
