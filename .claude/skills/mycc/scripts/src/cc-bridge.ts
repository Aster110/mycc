/**
 * Claude Code SDK 桥接
 * 核心：调用 CC SDK 的 query 函数
 */

import { query } from "@anthropic-ai/claude-code";
import { execSync } from "child_process";
import path from "path";
import fs from "fs";

// 检测 Claude CLI 路径
function detectClaudeCliPath(): string {
  const isWindows = process.platform === "win32";

  if (isWindows) {
    // Windows: 清理路径，移除回车符
    try {
      const result = execSync("where claude", { encoding: "utf-8" });
      // 处理 Windows 行结束符 \r\n
      const lines = result.split(/\r?\n/).filter(line => line.trim());

      console.log(`[CC] where claude 结果:`, lines);

      // 优先选择全局安装的 .cmd 文件（在 AppData 目录中）
      let selectedPath: string | null = null;
      for (const line of lines) {
        const trimmed = line.trim();
        // 检查是否是全局安装的路径（在 AppData 目录中）
        if (trimmed.toLowerCase().includes('appdata\\roaming\\npm\\') &&
            trimmed.toLowerCase().endsWith('.cmd')) {
          selectedPath = trimmed;
          console.log(`[CC] 选择全局安装的 claude.cmd: "${selectedPath}"`);
          break;
        }
      }

      // 如果没有找到全局安装的 .cmd，选择第一个 .cmd 文件
      if (!selectedPath) {
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.toLowerCase().endsWith('.cmd')) {
            selectedPath = trimmed;
            console.log(`[CC] 选择第一个 .cmd 文件: "${selectedPath}"`);
            break;
          }
        }
      }

      // 如果还没有找到，选择第一个结果
      if (!selectedPath && lines.length > 0) {
        selectedPath = lines[0].trim();
        console.log(`[CC] 选择第一个结果: "${selectedPath}"`);
      }

      if (selectedPath) {
        console.log(`[CC] Windows Claude 路径: "${selectedPath}"`);
        return selectedPath;
      }
    } catch (error) {
      console.log(`[CC] where claude 失败: ${error}`);
    }
    return "claude";
  } else {
    // Unix/Linux
    try {
      return execSync("which claude", { encoding: "utf-8" }).trim();
    } catch {
      return "/usr/local/bin/claude"; // fallback
    }
  }
}

const CLAUDE_CLI_PATH = detectClaudeCliPath();

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
export async function executeChat(options: ChatOptions): Promise<void> {
  const { message, sessionId, cwd, onMessage, onDone, onError } = options;

  let currentSessionId = sessionId || "";

  // 规范化路径，确保 Windows 兼容性
  const normalizedCliPath = CLAUDE_CLI_PATH.replace(/\\/g, '/');
  // 规范化工作目录
  const normalizedCwd = (cwd || process.cwd()).replace(/\\/g, '/');

  console.log(`[CC] executeChat 开始: message="${message.substring(0, 50)}..."`);
  console.log(`[CC] CLAUDE_CLI_PATH: "${CLAUDE_CLI_PATH}"`);
  console.log(`[CC] normalizedCliPath: "${normalizedCliPath}"`);
  console.log(`[CC] normalizedCwd: "${normalizedCwd}"`);
  console.log(`[CC] sessionId: "${sessionId || '(none)'}"`);

  // Windows 特殊处理：如果路径是 .cmd 文件，尝试使用 node + cli.js
  let finalExecutable = "claude";
  let finalCliPath = normalizedCliPath;
  const isWindows = process.platform === "win32";

  console.log(`[CC] isWindows: ${isWindows}, normalizedCliPath ends with .cmd: ${normalizedCliPath.toLowerCase().endsWith('.cmd')}`);

  if (isWindows && normalizedCliPath.toLowerCase().endsWith('.cmd')) {
    // 尝试找到 cli.js 路径
    const cmdDir = path.dirname(normalizedCliPath);
    console.log(`[CC] cmdDir: "${cmdDir}"`);
    const cliJsPath = path.join(cmdDir, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
    console.log(`[CC] cliJsPath: "${cliJsPath}"`);
    if (fs.existsSync(cliJsPath)) {
      console.log(`[CC] cli.js 存在，使用 node + cli.js`);
      console.log(`[CC] 使用 cli.js 路径: "${cliJsPath}"`);
      finalExecutable = "node";
      finalCliPath = cliJsPath;
    } else {
      console.log(`[CC] cli.js 未找到，继续使用 .cmd 文件`);
    }
  }

  console.log(`[CC] finalExecutable: "${finalExecutable}"`);
  console.log(`[CC] finalCliPath: "${finalCliPath}"`);

  try {
    const queryOptions = {
      prompt: message,
      options: {
        // 指定 CLI 路径，确保完整加载配置（包括 skills）
        executable: finalExecutable as any,
        pathToClaudeCodeExecutable: finalCliPath,
        cwd: normalizedCwd,
        resume: sessionId || undefined,
        // 小程序端无法交互确认权限，使用 bypassPermissions
        // 注意：这需要用户信任，后续可以改成更安全的模式
        permissionMode: "bypassPermissions" as "bypassPermissions",
      },
    };
    console.log(`[CC] 调用 query 函数，options:`, JSON.stringify(queryOptions, null, 2));

    for await (const sdkMessage of query(queryOptions)) {
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
    console.error(`[CC] executeChat 捕获错误:`, error);
    if (error instanceof Error) {
      console.error(`[CC] 错误堆栈:`, error.stack);
    }
    onError(error instanceof Error ? error.message : String(error));
  }
}

/**
 * 检查 CC CLI 是否可用
 */
export async function checkCCAvailable(): Promise<boolean> {
  try {
    const { execSync } = await import("child_process");
    execSync("claude --version", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}
