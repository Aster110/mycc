/**
 * SSH 连接池管理
 * 复用 SSH 连接，避免每次握手开销
 */

import { Client } from 'ssh2';
import { readFileSync } from 'fs';
import type { SSHConfig, SSHConnection, SSHExecResult, SSHExecOptions } from './types.js';

export class SSHPool {
  private connections: SSHConnection[] = [];
  private config: SSHConfig;
  private privateKey: Buffer;
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(config: SSHConfig) {
    this.config = config;
    this.privateKey = readFileSync(config.privateKeyPath);

    // 每 5 分钟清理空闲连接
    this.cleanupInterval = setInterval(() => {
      this.cleanupIdleConnections();
    }, 5 * 60 * 1000);
  }

  /**
   * 获取一个可用连接
   */
  async acquire(): Promise<SSHConnection> {
    // 查找空闲连接
    const idle = this.connections.find(conn => !conn.inUse);
    if (idle) {
      idle.inUse = true;
      idle.lastUsed = Date.now();
      return idle;
    }

    // 如果未达到最大连接数，创建新连接
    if (this.connections.length < this.config.maxConnections) {
      const conn = await this.createConnection();
      conn.inUse = true;
      conn.lastUsed = Date.now();
      this.connections.push(conn);
      return conn;
    }

    // 等待连接释放（最多等待 30 秒）
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        clearInterval(checkInterval);
        reject(new Error('Timeout waiting for SSH connection (30s)'));
      }, 30000);

      const checkInterval = setInterval(() => {
        const idle = this.connections.find(conn => !conn.inUse);
        if (idle) {
          clearTimeout(timeout);
          clearInterval(checkInterval);
          idle.inUse = true;
          idle.lastUsed = Date.now();
          resolve(idle);
        }
      }, 100);
    });
  }

  /**
   * 释放连接
   */
  release(connection: SSHConnection): void {
    connection.inUse = false;
    connection.lastUsed = Date.now();
  }

  /**
   * 执行命令
   */
  async exec(
    connection: SSHConnection,
    command: string,
    options: SSHExecOptions = {}
  ): Promise<SSHExecResult> {
    const { timeout = 30000 } = options;

    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let exitCode: number | null = null;
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        reject(new Error(`命令执行超时 (${timeout}ms): ${command}`));
      }, timeout);

      connection.client.exec(command, (err: Error | undefined, stream: any) => {
        if (err) {
          clearTimeout(timer);
          return reject(err);
        }

        stream.on('data', (data: Buffer) => {
          stdout += data.toString();
        });

        stream.stderr.on('data', (data: Buffer) => {
          stderr += data.toString();
        });

        stream.on('close', (code: number) => {
          clearTimeout(timer);
          if (!timedOut) {
            exitCode = code;
            resolve({ stdout, stderr, exitCode });
          }
        });

        stream.on('error', (err: Error) => {
          clearTimeout(timer);
          if (!timedOut) {
            reject(err);
          }
        });
      });
    });
  }

  /**
   * 创建新连接
   */
  private async createConnection(): Promise<SSHConnection> {
    return new Promise((resolve, reject) => {
      const client = new Client();
      const id = `ssh-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

      client.on('ready', () => {
        console.log(`✅ SSH 连接已建立: ${id}`);
        resolve({
          id,
          client,
          inUse: false,
          lastUsed: Date.now(),
        });
      });

      client.on('error', (err) => {
        console.error(`❌ SSH 连接失败: ${err.message}`);
        reject(err);
      });

      client.connect({
        host: this.config.host,
        port: this.config.port,
        username: this.config.username,
        privateKey: this.privateKey,
        readyTimeout: 10000,
      });
    });
  }

  /**
   * 清理空闲连接（超过 5 分钟未使用）
   */
  private cleanupIdleConnections(): void {
    const now = Date.now();
    const idleTimeout = 5 * 60 * 1000; // 5 分钟

    this.connections = this.connections.filter(conn => {
      if (!conn.inUse && now - conn.lastUsed > idleTimeout) {
        console.log(`🧹 清理空闲 SSH 连接: ${conn.id}`);
        conn.client.end();
        return false;
      }
      return true;
    });
  }

  /**
   * 测试连接
   */
  async testConnection(): Promise<boolean> {
    try {
      const conn = await this.acquire();
      const result = await this.exec(conn, 'echo "test"');
      this.release(conn);
      return result.exitCode === 0;
    } catch (err) {
      console.error('SSH 连接测试失败:', err);
      return false;
    }
  }

  /**
   * 销毁连接池
   */
  async destroy(): Promise<void> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    for (const conn of this.connections) {
      conn.client.end();
    }
    this.connections = [];
    console.log('✅ SSH 连接池已销毁');
  }
}

// 全局实例（延迟初始化）
let sshPool: SSHPool | null = null;

export function initSSHPool(config: SSHConfig): SSHPool {
  if (sshPool) {
    throw new Error('SSH 连接池已初始化');
  }
  sshPool = new SSHPool(config);
  return sshPool;
}

export function getSSHPool(): SSHPool {
  if (!sshPool) {
    throw new Error('SSH 连接池未初始化，请先调用 initSSHPool()');
  }
  return sshPool;
}
