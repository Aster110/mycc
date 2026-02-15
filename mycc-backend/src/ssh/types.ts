/**
 * SSH 连接相关类型定义
 */

import type { Client } from 'ssh2';

export interface SSHConfig {
  host: string;
  port: number;
  username: string;
  privateKeyPath: string;
  maxConnections: number;
}

export interface SSHConnection {
  id: string;
  client: Client;
  inUse: boolean;
  lastUsed: number;
}

export interface SSHExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export interface SSHExecOptions {
  timeout?: number; // 超时时间（毫秒）
  cwd?: string; // 工作目录
}
