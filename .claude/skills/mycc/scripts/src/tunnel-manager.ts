/**
 * TunnelManager - 隧道保活管理器
 *
 * 功能：
 * 1. 进程监控：cloudflared 进程退出时自动重启
 * 2. 心跳检测：定时探测隧道健康状态，连续失败触发重启
 * 3. 防重入锁：避免并发重启冲突
 * 4. 重启限制：超过最大次数后放弃，但保持心跳以便后续恢复
 */

import chalk from "chalk";
import type { ChildProcess } from "child_process";
import type { TunnelProvider, TunnelResult } from "./tunnel-provider.js";

// ============ 配置常量 ============

const HEARTBEAT_INTERVAL = 60_000; // 心跳间隔 60 秒
const HEARTBEAT_FAIL_THRESHOLD = 3; // 连续失败 3 次触发重启
const MAX_RESTART_ATTEMPTS = 5; // 最大重启次数
const RESTART_DELAY = 2000; // 重启前等待时间（毫秒）
const DNS_PROPAGATION_DELAY = 30_000; // DNS 传播等待时间（30 秒）
const WAIT_FOR_READY_TIMEOUT = 60_000; // waitForReady 超时（60 秒）
const WAIT_FOR_READY_INTERVAL = 5_000; // waitForReady 检查间隔（5 秒）
const GIVEUP_RETRY_DELAY = 300_000; // 放弃后的重试间隔（5 分钟）

// ============ 日志辅助 ============

const timestamp = () => new Date().toLocaleString("zh-CN", { hour12: false });

// ============ 类型定义 ============

export interface TunnelManagerOptions {
  /** 本地服务端口 */
  localPort: number;
  /** 重启成功后的回调（用于重新注册 Worker、更新 current.json 等） */
  onRestartSuccess?: (url: string) => Promise<void>;
  /** 放弃重启时的回调 */
  onGiveUp?: () => void;
}

export interface TunnelManagerStatus {
  isRunning: boolean;
  tunnelUrl: string | null;
  isRestarting: boolean;
  failCount: number;
  restartAttempts: number;
  hasGivenUp: boolean;
  heartbeatActive: boolean;
  heartbeatCount: number;
}

// ============ TunnelManager 实现 ============

export class TunnelManager {
  private provider: TunnelProvider | null = null;
  private localPort: number;
  private tunnelUrl: string | null = null;
  private proc: ChildProcess | null = null;

  private isRestarting = false;
  private failCount = 0;
  private restartAttempts = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private isStopped = false;
  private hasGivenUp = false; // 标记是否已放弃重启
  private heartbeatCount = 0; // 心跳计数，用于日志

  private onRestartSuccess?: (url: string) => Promise<void>;
  private onGiveUp?: () => void;

  constructor(options: TunnelManagerOptions) {
    this.localPort = options.localPort;
    this.onRestartSuccess = options.onRestartSuccess;
    this.onGiveUp = options.onGiveUp;
  }

  /**
   * 启动隧道
   */
  async start(provider: TunnelProvider): Promise<string> {
    console.log(chalk.gray(`[TunnelManager] ${timestamp()} 初始化...`));

    this.provider = provider;
    this.isStopped = false;
    this.restartAttempts = 0;
    this.failCount = 0;
    this.hasGivenUp = false;
    this.heartbeatCount = 0;

    const result = await provider.start(this.localPort);
    this.tunnelUrl = result.url;
    this.proc = result.proc || null;

    // 设置进程监控
    this.setupProcMonitor();

    // 启动心跳检测
    this.startHeartbeat();

    console.log(chalk.gray(`[TunnelManager] ${timestamp()} 启动完成`));
    console.log(chalk.gray(`[TunnelManager] 配置: 心跳间隔=${HEARTBEAT_INTERVAL/1000}s, 失败阈值=${HEARTBEAT_FAIL_THRESHOLD}次, 最大重试=${MAX_RESTART_ATTEMPTS}次`));
    return result.url;
  }

  /**
   * 停止隧道
   */
  stop(): void {
    console.log(chalk.gray(`[TunnelManager] 正在停止...`));
    this.isStopped = true;

    // 停止心跳
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    // 停止 provider
    if (this.provider) {
      this.provider.stop();
      this.provider = null;
    }

    this.proc = null;
    this.tunnelUrl = null;
  }

  /**
   * 获取当前状态
   */
  getStatus(): TunnelManagerStatus {
    return {
      isRunning: !this.isStopped && this.tunnelUrl !== null,
      tunnelUrl: this.tunnelUrl,
      isRestarting: this.isRestarting,
      failCount: this.failCount,
      restartAttempts: this.restartAttempts,
      hasGivenUp: this.hasGivenUp,
      heartbeatActive: this.heartbeatTimer !== null,
      heartbeatCount: this.heartbeatCount,
    };
  }

  /**
   * 获取当前隧道 URL
   */
  getUrl(): string | null {
    return this.tunnelUrl;
  }

  // ============ 私有方法 ============

  /**
   * 设置进程退出监控
   */
  private setupProcMonitor(): void {
    if (!this.proc) return;

    this.proc.on("exit", (code) => {
      if (this.isStopped) {
        // 正常停止，不触发重启
        return;
      }

      console.log(
        chalk.yellow(`[TunnelManager] cloudflared 进程退出 (code=${code})`)
      );
      this.restart("proc_exit");
    });

    this.proc.on("error", (err) => {
      if (this.isStopped) return;

      console.error(chalk.red(`[TunnelManager] cloudflared 进程错误:`, err));
      this.restart("proc_error");
    });
  }

  /**
   * 启动心跳检测
   */
  private startHeartbeat(): void {
    // 清理旧的定时器
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      console.log(chalk.gray(`[TunnelManager] ${timestamp()} 清理旧的心跳定时器`));
    }

    this.heartbeatCount = 0;
    console.log(chalk.gray(`[TunnelManager] ${timestamp()} 启动心跳检测 (间隔=${HEARTBEAT_INTERVAL/1000}s)`));

    this.heartbeatTimer = setInterval(async () => {
      this.heartbeatCount++;

      // 重启中或已停止，跳过检测
      if (this.isRestarting || this.isStopped || !this.provider) {
        console.log(chalk.gray(
          `[TunnelManager] ${timestamp()} 心跳#${this.heartbeatCount} 跳过 (restarting=${this.isRestarting}, stopped=${this.isStopped}, provider=${!!this.provider})`
        ));
        return;
      }

      const ok = await this.checkHealth();

      if (ok) {
        // 每 10 次心跳输出一次正常日志，减少日志噪音
        if (this.heartbeatCount % 10 === 0) {
          console.log(chalk.gray(`[TunnelManager] ${timestamp()} 心跳#${this.heartbeatCount} ✓ 正常`));
        }
        if (this.failCount > 0) {
          console.log(chalk.green(`[TunnelManager] ${timestamp()} 心跳恢复正常 (之前失败${this.failCount}次)`));
        }
        this.failCount = 0;
        // 心跳成功时重置放弃标记，允许下次重试
        if (this.hasGivenUp) {
          console.log(chalk.cyan(`[TunnelManager] ${timestamp()} 隧道恢复，重置放弃标记`));
          this.hasGivenUp = false;
          this.restartAttempts = 0;
        }
      } else {
        this.failCount++;
        console.log(
          chalk.yellow(
            `[TunnelManager] ${timestamp()} 心跳#${this.heartbeatCount} 失败 (${this.failCount}/${HEARTBEAT_FAIL_THRESHOLD})`
          )
        );

        if (this.failCount >= HEARTBEAT_FAIL_THRESHOLD) {
          console.log(chalk.red(`[TunnelManager] ${timestamp()} 心跳连续失败，触发重连`));
          this.restart("heartbeat_fail");
          this.failCount = 0;
        }
      }
    }, HEARTBEAT_INTERVAL);
  }

  /**
   * 检测隧道健康状态
   */
  private async checkHealth(): Promise<boolean> {
    if (!this.provider) return false;

    try {
      return await this.provider.healthCheck();
    } catch {
      return false;
    }
  }

  /**
   * 重启隧道（带防重入锁）
   */
  private async restart(reason: string): Promise<boolean> {
    console.log(chalk.cyan(`[TunnelManager] ${timestamp()} restart() 被调用 (reason=${reason})`));

    // 防重入
    if (this.isRestarting) {
      console.log(
        chalk.gray(`[TunnelManager] ${timestamp()} 重启进行中，跳过 (reason=${reason})`)
      );
      return false;
    }

    // 检查重试次数
    this.restartAttempts++;
    console.log(chalk.gray(`[TunnelManager] ${timestamp()} 重试计数: ${this.restartAttempts}/${MAX_RESTART_ATTEMPTS}`));

    if (this.restartAttempts > MAX_RESTART_ATTEMPTS) {
      console.error(
        chalk.red(
          `[TunnelManager] ${timestamp()} 重启次数超限 (${this.restartAttempts}/${MAX_RESTART_ATTEMPTS})，暂时放弃`
        )
      );
      console.error(chalk.yellow(`[TunnelManager] 请手动重启: /mycc`));
      console.error(chalk.gray(`[TunnelManager] ${GIVEUP_RETRY_DELAY/60000} 分钟后会自动重试`));

      this.hasGivenUp = true;
      this.onGiveUp?.();

      // 关键修复：放弃后仍然保持心跳检测，并在一段时间后重置计数允许再次尝试
      this.ensureHeartbeat();

      // 5 分钟后重置重试计数，允许再次尝试
      setTimeout(() => {
        if (this.hasGivenUp && !this.isStopped) {
          console.log(chalk.cyan(`[TunnelManager] ${timestamp()} 重置重试计数，准备再次尝试`));
          this.restartAttempts = 0;
          this.hasGivenUp = false;
        }
      }, GIVEUP_RETRY_DELAY);

      return false;
    }

    this.isRestarting = true;
    console.log(
      chalk.cyan(
        `[TunnelManager] ${timestamp()} 开始重连 (reason=${reason}, attempt=${this.restartAttempts})`
      )
    );

    try {
      // 1. 停止心跳检测
      if (this.heartbeatTimer) {
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
        console.log(chalk.gray(`[TunnelManager] ${timestamp()} 心跳已停止`));
      }

      // 2. 停止旧的 provider
      if (this.provider) {
        console.log(chalk.gray(`[TunnelManager] ${timestamp()} 停止旧的 provider...`));
        this.provider.stop();
      }

      // 3. 等待一下让端口释放
      console.log(chalk.gray(`[TunnelManager] ${timestamp()} 等待 ${RESTART_DELAY}ms...`));
      await this.sleep(RESTART_DELAY);

      // 4. 重新启动
      if (!this.provider) {
        throw new Error("Provider 不存在");
      }

      console.log(chalk.gray(`[TunnelManager] ${timestamp()} 启动新的 tunnel...`));
      const result = await this.provider.start(this.localPort);
      this.tunnelUrl = result.url;
      this.proc = result.proc || null;
      console.log(chalk.cyan(`[TunnelManager] ${timestamp()} 新隧道 URL: ${result.url}`));

      // 5. 等待 DNS 传播（避免 Node.js DNS 负缓存问题）
      console.log(chalk.gray(`[TunnelManager] ${timestamp()} 等待 DNS 传播 (${DNS_PROPAGATION_DELAY / 1000}s)...`));
      await this.sleep(DNS_PROPAGATION_DELAY);

      // 6. 验证隧道可用
      console.log(chalk.gray(`[TunnelManager] ${timestamp()} 验证隧道可用...`));
      const ready = await this.waitForReady();
      if (!ready) {
        throw new Error("隧道验证超时");
      }

      // 7. 重新设置进程监控
      this.setupProcMonitor();

      // 8. 重新启动心跳检测
      this.startHeartbeat();

      // 9. 调用回调（重新注册 Worker、更新 current.json 等）
      if (this.onRestartSuccess && this.tunnelUrl) {
        console.log(chalk.gray(`[TunnelManager] ${timestamp()} 调用 onRestartSuccess...`));
        await this.onRestartSuccess(this.tunnelUrl);
      }

      // 10. 重置重试计数（成功了）
      this.restartAttempts = 0;
      this.hasGivenUp = false;

      console.log(chalk.green(`[TunnelManager] ${timestamp()} ✓ 重连成功: ${this.tunnelUrl}`));
      this.isRestarting = false;
      return true;
    } catch (error) {
      console.error(chalk.red(`[TunnelManager] ${timestamp()} 重连失败:`), error);

      this.isRestarting = false;

      // 关键修复：失败后确保心跳检测恢复
      this.ensureHeartbeat();

      // 延迟后再次尝试（30 秒，避免触发 Cloudflare 限流）
      console.log(chalk.gray(`[TunnelManager] ${timestamp()} 30秒后重试...`));
      setTimeout(() => {
        this.restart("retry_after_fail");
      }, 30000);

      return false;
    }
  }

  /**
   * 确保心跳检测在运行
   */
  private ensureHeartbeat(): void {
    if (!this.heartbeatTimer && !this.isStopped) {
      console.log(chalk.gray(`[TunnelManager] ${timestamp()} 恢复心跳检测`));
      this.startHeartbeat();
    }
  }

  /**
   * 等待隧道就绪
   * DNS 传播后调用，验证隧道实际可用
   */
  private async waitForReady(): Promise<boolean> {
    const startTime = Date.now();

    while (Date.now() - startTime < WAIT_FOR_READY_TIMEOUT) {
      const ok = await this.checkHealth();
      if (ok) {
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        console.log(chalk.green(`[TunnelManager] 隧道验证成功 (${elapsed}s)`));
        return true;
      }
      console.log(chalk.gray(`[TunnelManager] 等待隧道就绪...`));
      await this.sleep(WAIT_FOR_READY_INTERVAL);
    }

    return false;
  }

  /**
   * 延迟辅助函数
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
