/**
 * Tunnel Provider 接口抽象
 *
 * 为未来支持多种隧道方案预留接口：
 * - CloudflareProvider（当前实现）
 * - SSHProvider（待实现）
 */

import type { ChildProcess } from "child_process";
import { spawn, execSync } from "child_process";
import { detectCloudflaredPath, NULL_DEVICE } from "./platform.js";

const isWindows = process.platform === "win32";

// ============ 接口定义 ============

export interface TunnelResult {
  url: string;
  proc?: ChildProcess;
}

export interface TunnelProvider {
  /**
   * 启动隧道
   * @param localPort 本地服务端口
   * @returns 隧道 URL 和进程引用
   */
  start(localPort: number): Promise<TunnelResult>;

  /**
   * 停止隧道
   */
  stop(): void;

  /**
   * 健康检查
   * @returns true 表示隧道正常
   */
  healthCheck(): Promise<boolean>;

  /**
   * 获取 Provider 名称
   */
  getName(): string;
}

// ============ CloudflareProvider 实现 ============

export class CloudflareProvider implements TunnelProvider {
  private proc: ChildProcess | null = null;
  private tunnelUrl: string | null = null;
  private startTimeout: number;
  private localPort: number = 0;

  /**
   * @param startTimeout 启动超时时间（毫秒），默认 60 秒
   * cloudflared 连接 Cloudflare Edge 可能需要较长时间，特别是网络不稳定时
   */
  constructor(startTimeout: number = 60000) {
    this.startTimeout = startTimeout;
  }

  async start(localPort: number): Promise<TunnelResult> {
    this.localPort = localPort;  // 保存端口号用于后续清理
    return new Promise((resolve, reject) => {
      // 获取 cloudflared 路径
      const cloudflaredPath = detectCloudflaredPath();
      const proc = spawn(cloudflaredPath, [
        'tunnel',
        '--config', NULL_DEVICE,
        '--url', `http://localhost:${localPort}`
      ], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });

      this.proc = proc;
      let resolved = false;
      // quick tunnel URL 格式: word1-word2-word3-word4.trycloudflare.com
      // 必须包含至少一个连字符，排除 api.trycloudflare.com 等系统域名
      const urlPattern = /https:\/\/[a-z0-9]+-[a-z0-9-]+\.trycloudflare\.com/;

      const handleOutput = (data: Buffer) => {
        const output = data.toString();
        const match = output.match(urlPattern);
        if (match && !resolved) {
          resolved = true;
          this.tunnelUrl = match[0];
          resolve({ url: match[0], proc });
        }
      };

      proc.stdout?.on("data", handleOutput);
      proc.stderr?.on("data", handleOutput);

      proc.on("error", (err) => {
        if (!resolved) {
          resolved = true;
          this.proc = null;
          reject(new Error(`Tunnel 启动失败: ${err.message}`));
        }
      });

      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          // 超时，杀掉进程
          try {
            proc.kill();
          } catch {}
          this.proc = null;
          reject(new Error("Tunnel 启动超时"));
        }
      }, this.startTimeout);
    });
  }

  stop(): void {
    if (this.proc) {
      try {
        // 直接强杀，不搞优雅那套
        this.proc.kill("SIGKILL");
      } catch {}
      this.proc = null;
    }

    // 杀掉所有 cloudflared 子进程（shell spawn 可能留下孤儿）
    // 注意：killPortProcess 杀的是 HTTP Server，不是 cloudflared！
    // cloudflared 不占用 localPort，它只是转发到 localhost:localPort
    try {
      if (isWindows) {
        // Windows: 按进程名杀
        execSync('taskkill /F /IM cloudflared.exe 2>nul', { stdio: 'ignore' });
      } else {
        // Unix: 按命令行模式匹配杀
        execSync("pkill -9 -f 'cloudflared tunnel' 2>/dev/null || true", { stdio: 'ignore' });
      }
    } catch {
      // 静默处理失败
    }

    this.tunnelUrl = null;
    this.localPort = 0;
  }

  async healthCheck(): Promise<boolean> {
    if (!this.tunnelUrl) {
      return false;
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      const response = await fetch(`${this.tunnelUrl}/health`, {
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      return response.ok;
    } catch {
      return false;
    }
  }

  getName(): string {
    return "cloudflare";
  }

  /**
   * 获取当前隧道 URL
   */
  getUrl(): string | null {
    return this.tunnelUrl;
  }

  /**
   * 获取进程引用（用于外部监控）
   */
  getProc(): ChildProcess | null {
    return this.proc;
  }
}
