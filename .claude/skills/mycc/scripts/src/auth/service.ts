import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { createUser, findUserByCredential, findUserById, getSubscription } from '../db/client.js';

const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret_change_in_production';
const JWT_EXPIRES_IN = '24h';

export interface JWTPayload {
  userId: number;
  linuxUser: string;
  role: string;
  plan: string;
  iat: number;
  exp: number;
}

// 注册用户
export async function register(params: {
  phone?: string;
  email?: string;
  password: string;
  nickname?: string;
}): Promise<{ token: string; user: any }> {
  // 验证输入
  if (!params.phone && !params.email) {
    throw new Error('手机号或邮箱必须提供一个');
  }

  if (params.password.length < 6) {
    throw new Error('密码长度至少 6 位');
  }

  // 检查用户是否已存在
  const credential = params.phone || params.email!;
  const existingUser = await findUserByCredential(credential);
  if (existingUser) {
    throw new Error('用户已存在');
  }

  // 加密密码
  const password_hash = await bcrypt.hash(params.password, 10);

  // 创建用户（将空字符串转换为 undefined，避免 UNIQUE 约束冲突）
  const user = await createUser({
    phone: params.phone || undefined,
    email: params.email || undefined,
    password_hash,
    nickname: params.nickname || undefined,
  });

  // 获取订阅信息
  const subscription = await getSubscription(user.id);

  // 生成 JWT
  const token = jwt.sign(
    {
      userId: user.id,
      linuxUser: user.linux_user,
      role: 'user',
      plan: subscription?.plan || 'free',
    } as Omit<JWTPayload, 'iat' | 'exp'>,
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );

  // 在开发环境创建用户工作目录
  if (process.env.NODE_ENV === 'development') {
    await createDevUserWorkspace(user.linux_user);
  }

  return {
    token,
    user: {
      id: user.id,
      phone: user.phone,
      email: user.email,
      nickname: user.nickname,
      linux_user: user.linux_user,
      plan: subscription?.plan,
    },
  };
}

// 登录
export async function login(params: {
  credential: string; // 手机号或邮箱
  password: string;
}): Promise<{ token: string; user: any }> {
  // 查找用户
  const user = await findUserByCredential(params.credential);
  if (!user) {
    throw new Error('用户不存在');
  }

  // 验证密码
  const isValid = await bcrypt.compare(params.password, user.password_hash);
  if (!isValid) {
    throw new Error('密码错误');
  }

  // 获取订阅信息
  const subscription = await getSubscription(user.id);

  // 生成 JWT
  const token = jwt.sign(
    {
      userId: user.id,
      linuxUser: user.linux_user,
      role: 'user',
      plan: subscription?.plan || 'free',
    } as Omit<JWTPayload, 'iat' | 'exp'>,
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );

  return {
    token,
    user: {
      id: user.id,
      phone: user.phone,
      email: user.email,
      nickname: user.nickname,
      linux_user: user.linux_user,
      plan: subscription?.plan,
    },
  };
}

// 验证 JWT
export function verifyToken(token: string): JWTPayload {
  try {
    return jwt.verify(token, JWT_SECRET) as JWTPayload;
  } catch (err) {
    throw new Error('Token 无效或已过期');
  }
}

// 获取当前用户信息
export async function getCurrentUser(userId: number) {
  const user = await findUserById(userId);
  if (!user) {
    throw new Error('用户不存在');
  }

  const subscription = await getSubscription(userId);

  return {
    id: user.id,
    phone: user.phone,
    email: user.email,
    nickname: user.nickname,
    linux_user: user.linux_user,
    status: user.status,
    subscription: subscription ? {
      plan: subscription.plan,
      tokens_limit: subscription.tokens_limit,
      tokens_used: subscription.tokens_used,
      tokens_remaining: subscription.tokens_limit - subscription.tokens_used,
      reset_at: subscription.reset_at,
      expires_at: subscription.expires_at,
    } : null,
  };
}

// 开发环境：创建用户工作目录
async function createDevUserWorkspace(linuxUser: string): Promise<void> {
  const { exec } = await import('child_process');
  const { promisify } = await import('util');
  const execAsync = promisify(exec);

  const workspaceDir = `/tmp/mycc_dev/${linuxUser}/workspace`;

  try {
    await execAsync(`mkdir -p ${workspaceDir}/.claude/projects`);
    await execAsync(`mkdir -p /tmp/mycc_dev/${linuxUser}/.mycc`);
    console.log(`✅ 创建开发环境工作目录: ${workspaceDir}`);
  } catch (err) {
    console.error(`❌ 创建工作目录失败:`, err);
  }
}
