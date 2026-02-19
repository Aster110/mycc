/**
 * 通用可执行文件路径探测器
 *
 * 设计目标：
 * - 可扩展：新增探测策略只需添加一个函数
 * - 可测试：依赖注入 ResolveContext，纯单元测试无需 mock 模块
 * - 可复用：Claude CLI 和 cloudflared 共用同一套探测链
 *
 * 策略链（按优先级执行，首个成功即返回）：
 * - envVar(name)         → 环境变量覆盖
 * - npmGlobal(pkg, entry) → npm root -g 动态探测（跨平台）
 * - knownPaths(paths)    → 平台特定已知路径
 * - whichCommand(name)   → which/where 命令
 * - fallback(name)       → 裸命令名兜底
 */

import { join } from "path";

// ============ 类型定义 ============

/** 探测结果 */
export interface ResolveResult {
  /** 执行命令（如 "node"、"claude"、"cloudflared"） */
  executable: string;
  /** 完整路径（如 "/path/to/cli.js"） */
  path: string;
}

/** 依赖上下文（可注入，方便测试） */
export interface ResolveContext {
  env: Record<string, string | undefined>;
  platform: string;
  existsSync: (path: string) => boolean;
  execSync: (cmd: string, opts?: { encoding: BufferEncoding }) => string;
}

/** 探测策略函数 */
export type ResolveStrategy = (ctx: ResolveContext) => ResolveResult | null;

// ============ 核心函数 ============

/**
 * 按顺序执行策略链，返回第一个成功的结果
 * 所有策略都失败时返回 null
 */
export function resolveExecutable(
  strategies: ResolveStrategy[],
  ctx: ResolveContext
): ResolveResult | null {
  for (const strategy of strategies) {
    const result = strategy(ctx);
    if (result) return result;
  }
  return null;
}

// ============ 策略工厂 ============

/**
 * 环境变量策略
 * 用户通过环境变量显式指定路径，最高优先级
 */
export function envVar(varName: string): ResolveStrategy {
  return (ctx) => {
    const value = ctx.env[varName]?.trim();
    if (!value) return null;
    return { executable: value, path: value };
  };
}

/**
 * which/where 命令策略
 * Mac/Linux 用 which，Windows 用 where
 */
export function whichCommand(name: string): ResolveStrategy {
  return (ctx) => {
    try {
      const cmd = ctx.platform === "win32" ? `where ${name}` : `which ${name}`;
      const output = ctx.execSync(cmd, { encoding: "utf-8" });

      // where 可能返回多行，取第一个非空行
      const lines = output.split(/\r?\n/).filter((l) => l.trim());
      const result = lines[0]?.trim();
      if (!result) return null;

      // .js 文件需要用 node 执行
      if (result.endsWith(".js")) {
        return { executable: "node", path: result };
      }

      return { executable: name, path: result };
    } catch {
      return null;
    }
  };
}

/**
 * npm 全局包策略
 * 使用 `npm root -g` 动态获取全局模块路径，跨平台兼容（nvm/volta/标准安装）
 */
export function npmGlobal(
  packageName: string,
  entryFile: string
): ResolveStrategy {
  return (ctx) => {
    try {
      const npmRoot = ctx.execSync("npm root -g", { encoding: "utf-8" }).trim();
      if (!npmRoot) return null;

      const entryPath = join(npmRoot, packageName, entryFile);
      if (ctx.existsSync(entryPath)) {
        return { executable: "node", path: entryPath };
      }
      return null;
    } catch {
      return null;
    }
  };
}

/**
 * 已知路径策略
 * 检查平台特定的常见安装路径
 *
 * @param paths 路径列表或返回路径列表的函数（惰性求值）
 * @param options.executable 指定可执行命令名（如 "node"、"claude"）
 *        不指定时：.js 文件自动用 "node"，其他用路径本身
 */
export function knownPaths(
  paths: string[] | ((ctx: ResolveContext) => string[]),
  options?: { executable?: string }
): ResolveStrategy {
  return (ctx) => {
    let pathList: string[];
    try {
      pathList = typeof paths === "function" ? paths(ctx) : paths;
    } catch {
      return null;
    }

    for (const p of pathList) {
      if (ctx.existsSync(p)) {
        // 确定 executable
        let exe: string;
        if (options?.executable) {
          exe = options.executable;
        } else if (p.endsWith(".js")) {
          exe = "node";
        } else {
          exe = p;
        }
        return { executable: exe, path: p };
      }
    }
    return null;
  };
}

/**
 * 兜底策略
 * 总是成功，返回裸命令名（依赖系统 PATH）
 */
export function fallback(name: string): ResolveStrategy {
  return () => ({ executable: name, path: name });
}
