/**
 * 远程 Claude 执行适配器
 * 通过 SSH 在 VPS 上执行 Claude CLI
 */

import { getSSHPool } from '../ssh/pool.js';
import { vpsUserManager } from '../vps/user-manager.js';
import type { SSHConnection } from '../ssh/types.js';
import { parseStreamLine } from './stream-parser.js';
import { sanitizeLinuxUsername, escapeShellArg, validatePathPrefix } from '../utils/validation.js';

export interface ChatParams {
  message: string;
  sessionId?: string;
  cwd: string;
  linuxUser: string;
  images?: Array<{ data: string; mediaType: string }>;
}

export interface SSEEvent {
  type: string;
  [key: string]: any;
}

/**
 * 远程 Claude 适配器
 */
export class RemoteClaudeAdapter {
  /**
   * 发送消息，返回 SSE 事件流
   */
  async *chat(params: ChatParams): AsyncIterable<SSEEvent> {
    const { message, sessionId, cwd, linuxUser, images } = params;

    // 验证 linuxUser 格式
    sanitizeLinuxUsername(linuxUser);

    // 验证 cwd 路径安全性
    if (!validatePathPrefix(cwd, '/home/')) {
      throw new Error(`Invalid working directory: ${cwd}`);
    }

    const sshPool = getSSHPool();
    let connection: SSHConnection | null = null;

    try {
      // 检查用户是否存在，不存在则创建
      const userExists = await vpsUserManager.userExists(linuxUser);
      if (!userExists) {
        console.log(`[RemoteClaudeAdapter] 用户 ${linuxUser} 不存在，正在创建...`);
        await vpsUserManager.createUser(linuxUser);
      }

      // 获取 SSH 连接
      connection = await sshPool.acquire();

      // 注意：图片暂不支持（v1）
      if (images && images.length > 0) {
        throw new Error('远程执行暂不支持图片消息');
      }

      const authToken = process.env.VPS_ANTHROPIC_AUTH_TOKEN || '';
      const baseUrl = process.env.VPS_ANTHROPIC_BASE_URL || '';

      if (!authToken || !baseUrl) {
        throw new Error('VPS Claude 认证配置缺失：VPS_ANTHROPIC_AUTH_TOKEN 或 VPS_ANTHROPIC_BASE_URL');
      }

      // 验证 linuxUser 和 cwd 不含危险字符（已通过 sanitizeLinuxUsername 和 validatePathPrefix 验证）
      sanitizeLinuxUsername(linuxUser);

      // 构建命令
      // 关键1：必须用 SSH exec + PTY 模式，否则 sudo + claude 的 stdout 全缓冲
      // 关键2：环境变量放在 claude 命令前面（不能放在 cd 前面，否则只作用于 cd）
      // 关键3：用 bash -c 包裹，确保 cd 和 claude 在同一个子 shell 中执行
      const safeMessage = message.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`');
      const resumePart = sessionId ? ` --resume '${sessionId}'` : '';

      const command = `sudo -n -u ${linuxUser} bash -c 'cd ${cwd} && ANTHROPIC_AUTH_TOKEN=${authToken} ANTHROPIC_BASE_URL=${baseUrl} claude --print --output-format stream-json --verbose --dangerously-skip-permissions${resumePart} "${safeMessage}"'`;

      console.log(`[RemoteClaudeAdapter] 执行命令: ${command.substring(0, 150)}...`);

      // 执行命令并流式读取输出
      yield* this.execStreamCommand(connection, command);

    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error('[RemoteClaudeAdapter] 错误:', errMsg);
      yield { type: 'error', error: errMsg };
    } finally {
      // 归还连接
      if (connection) {
        sshPool.release(connection);
      }
    }
  }

  /**
   * 执行命令并流式读取输出
   */
  private async *execStreamCommand(
    connection: SSHConnection,
    command: string
  ): AsyncIterable<SSEEvent> {
    let buffer = '';
    let stderrBuffer = '';
    const eventQueue: SSEEvent[] = [];
    let streamClosed = false;
    let resolveNext: (() => void) | null = null;

    // 创建 Promise 用于等待新事件
    const waitForEvent = () => new Promise<void>(resolve => {
      resolveNext = resolve;
    });

    // 执行命令
    const execPromise = new Promise<void>((resolve, reject) => {
      // 必须启用 PTY，否则 sudo + claude 的 stdout 全缓冲，SSH exec 收不到数据
      connection.client.exec(command, { pty: true }, (err: Error | undefined, stream: any) => {
        if (err) {
          return reject(err);
        }

        // 处理 stdout（逐行解析）
        // 注意：PTY 模式下 stdout 可能包含终端控制字符，需要过滤
        stream.on('data', (data: Buffer) => {
          const chunk = data.toString();
          // 过滤 ANSI 控制字符（PTY 产生的终端控制码）
          const cleanChunk = chunk.replace(/\x1b\[[^a-zA-Z]*[a-zA-Z]/g, '')
            .replace(/\x1b\][^\x07]*\x07/g, '')
            .replace(/\x1b\[[\?]?[0-9;]*[a-zA-Z]/g, '')
            .replace(/\r/g, '');
          if (!cleanChunk.trim()) return; // 跳过纯控制字符行

          buffer += cleanChunk;
          const lines = buffer.split('\n');
          buffer = lines.pop() || ''; // 保留最后一个不完整的行

          for (const line of lines) {
            const event = parseStreamLine(line);
            if (event) {
              console.log('[RemoteClaudeAdapter] 解析事件:', event.type);
              eventQueue.push(event);
              if (resolveNext) {
                resolveNext();
                resolveNext = null;
              }
            }
          }
        });

        // 处理 stderr
        stream.stderr.on('data', (data: Buffer) => {
          stderrBuffer += data.toString();
        });

        // 流结束
        stream.on('close', (code: number) => {
          // 处理最后一行
          if (buffer.trim()) {
            const event = parseStreamLine(buffer);
            if (event) {
              eventQueue.push(event);
            }
          }

          // 如果有 stderr 输出，记录日志
          if (stderrBuffer) {
            console.error('[RemoteClaudeAdapter] stderr:', stderrBuffer);
          }

          // 如果退出码非 0，添加错误事件
          if (code !== 0) {
            eventQueue.push({
              type: 'error',
              error: `命令执行失败 (exit code ${code}): ${stderrBuffer || '未知错误'}`,
            });
          }

          streamClosed = true;
          if (resolveNext) {
            resolveNext();
            resolveNext = null;
          }
          resolve();
        });

        stream.on('error', (err: Error) => {
          eventQueue.push({
            type: 'error',
            error: err.message,
          });
          streamClosed = true;
          if (resolveNext) {
            resolveNext();
            resolveNext = null;
          }
          reject(err);
        });
      });
    });

    // 流式 yield 事件
    try {
      while (!streamClosed || eventQueue.length > 0) {
        if (eventQueue.length > 0) {
          yield eventQueue.shift()!;
        } else if (!streamClosed) {
          await waitForEvent();
        }
      }
      await execPromise;
    } catch (err) {
      // 错误已经添加到 eventQueue，这里只需要确保所有事件都被 yield
      while (eventQueue.length > 0) {
        yield eventQueue.shift()!;
      }
    }
  }
}
