/**
 * VPS 用户管理器
 * 负责在 VPS 上创建、检查、删除 Linux 用户
 */

import { getSSHPool } from '../ssh/pool.js';
import { sanitizeLinuxUsername, escapeShellArg } from '../utils/validation.js';

export class VPSUserManager {
  /**
   * 检查用户是否存在
   */
  async userExists(linuxUser: string): Promise<boolean> {
    // 验证用户名格式
    sanitizeLinuxUsername(linuxUser);

    const sshPool = getSSHPool();
    const connection = await sshPool.acquire();

    try {
      const result = await sshPool.exec(connection, `id ${escapeShellArg(linuxUser)}`);
      return result.exitCode === 0;
    } catch (err) {
      return false;
    } finally {
      sshPool.release(connection);
    }
  }

  /**
   * 创建用户
   * 1. 创建 Linux 用户（加入 mycc 组）
   * 2. 创建工作目录 /home/{linuxUser}/workspace
   * 3. 配置 sudoers（允许执行 claude 命令）
   */
  async createUser(linuxUser: string): Promise<void> {
    // 验证用户名格式
    sanitizeLinuxUsername(linuxUser);

    const sshPool = getSSHPool();
    const connection = await sshPool.acquire();

    try {
      console.log(`[VPSUserManager] 开始创建用户: ${linuxUser}`);

      // 1. 创建用户（加入 mycc 组）
      const createUserCmd = `sudo useradd -m -g mycc -s /bin/bash ${escapeShellArg(linuxUser)}`;
      const createResult = await sshPool.exec(connection, createUserCmd);

      if (createResult.exitCode !== 0) {
        throw new Error(`创建用户失败: ${createResult.stderr}`);
      }

      // 2. 创建工作目录
      const escapedUser = escapeShellArg(linuxUser);
      const workspaceDir = `/home/${linuxUser}/workspace`;
      const mkdirCmd = `sudo mkdir -p ${escapeShellArg(workspaceDir)}/.claude/projects && sudo chown -R ${escapedUser}:mycc /home/${escapedUser}`;
      const mkdirResult = await sshPool.exec(connection, mkdirCmd);

      if (mkdirResult.exitCode !== 0) {
        throw new Error(`创建工作目录失败: ${mkdirResult.stderr}`);
      }

      console.log(`✅ VPS 用户创建成功: ${linuxUser}`);
    } catch (err) {
      console.error(`❌ 创建 VPS 用户失败:`, err);
      throw err;
    } finally {
      sshPool.release(connection);
    }
  }

  /**
   * 删除用户（管理用）
   */
  async deleteUser(linuxUser: string): Promise<void> {
    // 验证用户名格式
    sanitizeLinuxUsername(linuxUser);

    const sshPool = getSSHPool();
    const connection = await sshPool.acquire();

    try {
      console.log(`[VPSUserManager] 开始删除用户: ${linuxUser}`);

      // 删除用户及其 home 目录
      const deleteCmd = `sudo userdel -r ${escapeShellArg(linuxUser)}`;
      const result = await sshPool.exec(connection, deleteCmd);

      if (result.exitCode !== 0) {
        throw new Error(`删除用户失败: ${result.stderr}`);
      }

      console.log(`✅ VPS 用户删除成功: ${linuxUser}`);
    } catch (err) {
      console.error(`❌ 删除 VPS 用户失败:`, err);
      throw err;
    } finally {
      sshPool.release(connection);
    }
  }
}

// 全局实例
export const vpsUserManager = new VPSUserManager();
