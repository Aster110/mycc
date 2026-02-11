/**
 * 跨平台工具函数
 * 从原有 mycc 代码中提取，用于检测 Claude CLI 路径
 */

import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';

/**
 * 是否是 Windows 平台
 */
export const isWindows = process.platform === 'win32';

/**
 * 检测 Claude CLI 路径
 * 返回 { executable, cliPath }
 * - Mac/Linux: { executable: "node", cliPath: "/path/to/cli.js" } 或 { executable: "claude", cliPath: "/path/to/claude" }
 * - Windows: { executable: "claude", cliPath: "claude" } 使用 native binary，不转换
 */
export function detectClaudeCliPath(): { executable: string; cliPath: string } {
  const fallback = { executable: 'claude', cliPath: 'claude' };

  try {
    if (isWindows) {
      // Windows: npm 全局安装的 claude 需要用 node + cli.js 方式调用
      // 因为 .cmd/.ps1 文件不能直接被 spawn
      const npmGlobalDir = join(process.env.APPDATA || '', 'npm');

      // 尝试找到 cli.js 入口文件
      const cliJsPath = join(npmGlobalDir, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
      if (existsSync(cliJsPath)) {
        return { executable: 'node', cliPath: cliJsPath };
      }

      // 检查常见安装路径（native binary）
      const commonPaths = [
        join(process.env.LOCALAPPDATA || '', 'Programs', 'Claude', 'claude.exe'),
        join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'claude.exe'),
      ];
      for (const p of commonPaths) {
        if (existsSync(p)) {
          return { executable: 'claude', cliPath: p };
        }
      }

      // 回退到 "claude"，依赖 PATH
      return { executable: 'claude', cliPath: 'claude' };
    } else {
      // Mac/Linux: 使用 which 命令，可能需要 node + cli.js
      try {
        const result = execSync('which claude', { encoding: 'utf-8' }).trim();
        if (result) {
          // 方法1: 用 npm root -g 获取全局模块路径（最可靠）
          try {
            const npmGlobalRoot = execSync('npm root -g', { encoding: 'utf-8' }).trim();
            const cliJsPath = join(npmGlobalRoot, '@anthropic-ai', 'claude-code', 'cli.js');
            if (existsSync(cliJsPath)) {
              return { executable: 'node', cliPath: cliJsPath };
            }
          } catch {
            // npm root -g 失败，继续尝试其他方法
          }

          // 方法2: 检查常见的全局安装路径
          const commonGlobalPaths = [
            '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js',
            '/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js',
          ];
          for (const p of commonGlobalPaths) {
            if (existsSync(p)) {
              return { executable: 'node', cliPath: p };
            }
          }

          // 方法3: which claude 返回的直接就是 cli.js（symlink 解析后）
          if (result.endsWith('cli.js')) {
            return { executable: 'node', cliPath: result };
          }

          // 都没找到，用 claude 命令本身
          return { executable: 'claude', cliPath: result };
        }
      } catch {
        // which 失败
      }
      return fallback;
    }
  } catch {
    return fallback;
  }
}
