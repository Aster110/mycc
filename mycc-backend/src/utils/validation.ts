/**
 * 输入验证工具
 */

/**
 * 验证 Linux 用户名格式
 * 规则：小写字母或下划线开头，后跟字母、数字、下划线、连字符，长度 1-32
 */
export function validateLinuxUsername(username: string): boolean {
  return /^[a-z_][a-z0-9_-]{0,31}$/.test(username);
}

/**
 * 清理并验证 Linux 用户名
 * @throws Error 如果格式不合法
 */
export function sanitizeLinuxUsername(username: string): string {
  if (!validateLinuxUsername(username)) {
    throw new Error(`Invalid Linux username format: ${username}`);
  }
  return username;
}

/**
 * 转义 shell 参数，防止注入
 */
export function escapeShellArg(arg: string): string {
  // 使用单引号包裹，并转义内部的单引号
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

/**
 * 验证路径是否在允许的基础路径下
 */
export function validatePathPrefix(path: string, allowedPrefix: string): boolean {
  const normalized = path.replace(/\/+/g, '/');
  return normalized.startsWith(allowedPrefix);
}
