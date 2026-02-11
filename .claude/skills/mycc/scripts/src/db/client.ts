import pg from 'pg';
import dotenv from 'dotenv';
import { join } from 'path';

// 加载 mycc-backend/.env（复用已有配置）
// 从 scripts/src/db/ 往上 6 级到项目根目录 mycc/
dotenv.config({ path: join(import.meta.dirname, '..', '..', '..', '..', '..', '..', 'mycc-backend', '.env') });

const { Pool } = pg;

// 数据库连接池
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// 测试连接
pool.on('connect', () => {
  console.log('✅ 数据库连接成功');
});

pool.on('error', (err) => {
  console.error('❌ 数据库连接错误:', err);
});

// 用户相关操作
export interface User {
  id: number;
  phone?: string;
  email?: string;
  password_hash: string;
  nickname?: string;
  linux_user: string;
  status: string;
  created_at: Date;
  updated_at: Date;
}

export interface Subscription {
  id: number;
  user_id: number;
  plan: 'free' | 'basic' | 'pro';
  tokens_limit: number;
  tokens_used: number;
  reset_at: Date;
  expires_at?: Date;
  created_at: Date;
}

export interface UsageLog {
  id: number;
  user_id: number;
  session_id: string;
  input_tokens: number;
  output_tokens: number;
  model: string;
  cost_usd: number;
  created_at: Date;
}

export interface Conversation {
  id: number;
  user_id: number;
  session_id: string;
  title?: string;
  message_count: number;
  total_tokens: number;
  created_at: Date;
  updated_at: Date;
}

// 创建用户
export async function createUser(params: {
  phone?: string;
  email?: string;
  password_hash: string;
  nickname?: string;
}): Promise<User> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 生成 Linux 用户名
    const result = await client.query<User>(
      `INSERT INTO users (phone, email, password_hash, nickname, linux_user)
       VALUES ($1, $2, $3, $4, 'mycc_u' || currval(pg_get_serial_sequence('users', 'id')))
       RETURNING *`,
      [params.phone, params.email, params.password_hash, params.nickname]
    );

    const user = result.rows[0];

    // 创建默认订阅（免费版）
    await client.query(
      `INSERT INTO subscriptions (user_id, plan, tokens_limit, tokens_used, reset_at)
       VALUES ($1, 'free', $2, 0, date_trunc('month', NOW()) + interval '1 month')`,
      [user.id, parseInt(process.env.PLAN_FREE_TOKENS || '10000')]
    );

    await client.query('COMMIT');
    return user;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// 根据手机号或邮箱查找用户
export async function findUserByCredential(credential: string): Promise<User | null> {
  const result = await pool.query<User>(
    `SELECT * FROM users WHERE phone = $1 OR email = $1 LIMIT 1`,
    [credential]
  );
  return result.rows[0] || null;
}

// 根据 ID 查找用户
export async function findUserById(userId: number): Promise<User | null> {
  const result = await pool.query<User>(
    `SELECT * FROM users WHERE id = $1`,
    [userId]
  );
  return result.rows[0] || null;
}

// 获取用户订阅信息
export async function getSubscription(userId: number): Promise<Subscription | null> {
  const result = await pool.query<Subscription>(
    `SELECT * FROM subscriptions WHERE user_id = $1`,
    [userId]
  );
  return result.rows[0] || null;
}

// 记录使用量
export async function logUsage(params: {
  userId: number;
  sessionId: string;
  inputTokens: number;
  outputTokens: number;
  model: string;
  costUsd: number;
}): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 插入使用记录
    await client.query(
      `INSERT INTO usage_logs (user_id, session_id, input_tokens, output_tokens, model, cost_usd)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [params.userId, params.sessionId, params.inputTokens, params.outputTokens, params.model, params.costUsd]
    );

    // 更新订阅使用量
    await client.query(
      `UPDATE subscriptions
       SET tokens_used = tokens_used + $1
       WHERE user_id = $2`,
      [params.inputTokens + params.outputTokens, params.userId]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// 检查用户是否超额
export async function checkQuota(userId: number): Promise<{ allowed: boolean; remaining: number }> {
  const subscription = await getSubscription(userId);
  if (!subscription) {
    return { allowed: false, remaining: 0 };
  }

  const remaining = subscription.tokens_limit - subscription.tokens_used;
  return {
    allowed: remaining > 0,
    remaining: Math.max(0, remaining),
  };
}

// 重置月度额度（定时任务调用）
export async function resetMonthlyQuota(): Promise<number> {
  const result = await pool.query(
    `UPDATE subscriptions
     SET tokens_used = 0, reset_at = reset_at + interval '1 month'
     WHERE reset_at <= NOW()
     RETURNING user_id`
  );
  return result.rowCount || 0;
}

// 创建或更新会话
export async function upsertConversation(params: {
  userId: number;
  sessionId: string;
  title?: string;
}): Promise<void> {
  await pool.query(
    `INSERT INTO conversations (user_id, session_id, title, message_count, total_tokens)
     VALUES ($1, $2, $3, 0, 0)
     ON CONFLICT (session_id)
     DO UPDATE SET title = COALESCE($3, conversations.title), updated_at = NOW()`,
    [params.userId, params.sessionId, params.title]
  );
}

// 更新会话统计
export async function updateConversationStats(sessionId: string, tokens: number): Promise<void> {
  await pool.query(
    `UPDATE conversations
     SET message_count = message_count + 1,
         total_tokens = total_tokens + $1,
         updated_at = NOW()
     WHERE session_id = $2`,
    [tokens, sessionId]
  );
}

// 获取用户会话列表
export async function getUserConversations(
  userId: number,
  limit: number = 20,
  offset: number = 0
): Promise<Conversation[]> {
  const result = await pool.query<Conversation>(
    `SELECT * FROM conversations
     WHERE user_id = $1
     ORDER BY updated_at DESC
     LIMIT $2 OFFSET $3`,
    [userId, limit, offset]
  );
  return result.rows;
}

// 获取使用统计
export async function getUsageStats(
  userId: number,
  startDate?: Date,
  endDate?: Date
): Promise<{ date: string; tokens: number; cost: number }[]> {
  const result = await pool.query(
    `SELECT
       DATE(created_at) as date,
       SUM(total_tokens) as tokens,
       SUM(cost_usd) as cost
     FROM usage_logs
     WHERE user_id = $1
       AND ($2::timestamp IS NULL OR created_at >= $2)
       AND ($3::timestamp IS NULL OR created_at <= $3)
     GROUP BY DATE(created_at)
     ORDER BY date DESC`,
    [userId, startDate, endDate]
  );
  return result.rows;
}

// 升级套餐
export async function upgradePlan(userId: number, plan: 'basic' | 'pro'): Promise<void> {
  const tokensLimit = plan === 'basic'
    ? parseInt(process.env.PLAN_BASIC_TOKENS || '100000')
    : parseInt(process.env.PLAN_PRO_TOKENS || '500000');

  await pool.query(
    `UPDATE subscriptions
     SET plan = $1, tokens_limit = $2, expires_at = NOW() + interval '1 month'
     WHERE user_id = $3`,
    [plan, tokensLimit, userId]
  );
}
