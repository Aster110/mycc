/**
 * 跨平台工具函数
 * 集中处理 Windows / Mac / Linux 的差异
 *
 * 路径探测使用 resolve-executable.ts 的通用策略链
 */

import { execSync, spawn } from "child_process";
import { existsSync } from "fs";
import { parse, join } from "path";
import {
  resolveExecutable,
  envVar,
  whichCommand,
  npmGlobal,
  knownPaths,
  fallback,
  type ResolveContext,
} from "./resolve-executable.js";

// ============ 平台常量 ============

export const isWindows = process.platform === "win32";

/** 空设备路径：Windows: NUL, Mac/Linux: /dev/null */
export const NULL_DEVICE = isWindows ? "NUL" : "/dev/null";

// ============ 通用工具 ============

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 获取路径的根目录
 * Mac/Linux: "/"  Windows: "C:\\"
 */
export function getRoot(filePath: string): string {
  return parse(filePath).root;
}

// ============ 端口管理 ============

export async function killPortProcess(port: number): Promise<void> {
  const maxRetries = 3;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const pid = isWindows
        ? getWindowsPortPid(port)
        : getUnixPortPid(port);

      if (!pid) return;

      if (isWindows) {
        execSync(`taskkill /PID ${pid} /F`, { stdio: "ignore" });
      } else {
        execSync(`kill -9 ${pid}`, { stdio: "ignore" });
      }

      await sleep(1000);

      const stillOccupied = isWindows
        ? getWindowsPortPid(port)
        : getUnixPortPid(port);

      if (!stillOccupied) return;

      if (attempt < maxRetries) {
        console.log(`端口 ${port} 仍被占用，重试 ${attempt}/${maxRetries}...`);
      }
    } catch {
      return;
    }
  }

  throw new Error(`无法释放端口 ${port}，请手动检查并关闭占用进程`);
}

function getUnixPortPid(port: number): string | null {
  try {
    const pid = execSync(`lsof -i :${port} -t -sTCP:LISTEN 2>/dev/null`, {
      encoding: "utf-8",
    }).trim();
    return pid || null;
  } catch {
    return null;
  }
}

function getWindowsPortPid(port: number): string | null {
  try {
    const result = execSync(
      `netstat -ano | findstr :${port} | findstr LISTENING`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
    );
    const lines = result.trim().split("\n");
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      const pid = parts[parts.length - 1];
      if (pid && /^\d+$/.test(pid) && pid !== "0") {
        return pid;
      }
    }
    return null;
  } catch {
    return null;
  }
}

// ============ 运行时 ResolveContext ============

/** 创建真实运行环境的 context */
function createRealContext(): ResolveContext {
  return {
    env: process.env as Record<string, string | undefined>,
    platform: process.platform,
    existsSync,
    execSync: (cmd: string, opts?: { encoding: BufferEncoding }) =>
      execSync(cmd, { encoding: "utf-8", ...opts }) as string,
  };
}

// ============ cloudflared 路径探测 ============

/**
 * 检测 cloudflared 路径
 * 策略链：环境变量 → 已知路径 → which/where → 裸命令名
 */
export function detectCloudflaredPath(): string {
  const result = resolveExecutable(
    [
      envVar("CLOUDFLARED_PATH"),
      knownPaths((ctx) => {
        if (ctx.platform === "win32") return [];
        return [
          "/opt/homebrew/bin/cloudflared", // macOS ARM
          "/usr/local/bin/cloudflared",    // macOS Intel / Linux
        ];
      }),
      whichCommand("cloudflared"),
      fallback("cloudflared"),
    ],
    createRealContext()
  );
  return result!.path;
}

// ============ Claude CLI 路径探测 ============

/**
 * 检测 Claude CLI 路径
 * 策略链：环境变量 → npm root -g → 已知 cli.js 路径 → which/where → 已知 native 路径 → 裸命令名
 *
 * 返回 { executable, cliPath }：
 * - npm 安装：{ executable: "node", cliPath: "/path/to/cli.js" }
 * - native 安装：{ executable: "claude", cliPath: "/path/to/claude" }
 */
export function detectClaudeCliPath(): { executable: string; cliPath: string } {
  const result = resolveExecutable(
    [
      envVar("CLAUDE_PATH"),
      // 动态探测：npm root -g（跨平台，覆盖 nvm/volta/标准安装）
      npmGlobal("@anthropic-ai/claude-code", "cli.js"),
      // 已知 cli.js 路径（npm root -g 失败时的 fallback）
      knownPaths(
        (ctx) => {
          if (ctx.platform === "win32") return [];
          return [
            "/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js",
            "/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js",
          ];
        },
        { executable: "node" }
      ),
      // which/where（可能找到 wrapper script 或 native binary）
      whichCommand("claude"),
      // 已知 native binary 路径（Windows 特有）
      knownPaths(
        (ctx) => {
          if (ctx.platform !== "win32") return [];
          const home = ctx.env.USERPROFILE || "";
          const localAppData = ctx.env.LOCALAPPDATA || "";
          return [
            join(home, ".local", "bin", "claude.exe"),          // #9 修复
            join(localAppData, "Programs", "Claude", "claude.exe"),
            join(localAppData, "Microsoft", "WinGet", "Links", "claude.exe"),
          ];
        },
        { executable: "claude" }
      ),
      fallback("claude"),
    ],
    createRealContext()
  );

  return { executable: result!.executable, cliPath: result!.path };
}

// ============ 安装提示 ============

export function getCloudflaredInstallHint(): string {
  if (isWindows) {
    return `请下载 cloudflared 并添加到 PATH:
1. 访问 https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
2. 下载 Windows 版本 (cloudflared-windows-amd64.exe)
3. 重命名为 cloudflared.exe
4. 放到一个目录（如 C:\\Tools\\）
5. 将该目录添加到系统 PATH 环境变量`;
  } else {
    return "安装方法: brew install cloudflare/cloudflare/cloudflared";
  }
}

// ============ 可用性检测 ============

/**
 * 检查 Claude Code CLI 是否可用
 * 使用 detectClaudeCliPath 的结果，不硬编码命令名
 */
export async function checkCCAvailable(): Promise<boolean> {
  try {
    const { executable, cliPath } = detectClaudeCliPath();
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

/**
 * 检查 cloudflared 是否可用
 */
export async function checkCloudflared(): Promise<boolean> {
  return new Promise((resolve) => {
    const cloudflaredPath = detectCloudflaredPath();
    const proc = spawn(cloudflaredPath, ["--version"]);

    proc.on("close", (code: number) => {
      resolve(code === 0);
    });

    proc.on("error", () => {
      resolve(false);
    });
  });
}
