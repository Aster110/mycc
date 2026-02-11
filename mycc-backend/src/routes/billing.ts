import { FastifyInstance } from 'fastify';
import { jwtAuthMiddleware } from '../middleware/jwt.js';
import { getSubscription, getUsageStats, upgradePlan } from '../db/client.js';
import { z } from 'zod';

// 升级套餐请求验证
const upgradePlanSchema = z.object({
  plan: z.enum(['basic', 'pro']),
});

export async function billingRoutes(fastify: FastifyInstance) {
  // GET /api/billing/subscription - 获取订阅信息
  fastify.get('/api/billing/subscription', {
    preHandler: jwtAuthMiddleware,
  }, async (request, reply) => {
    if (!request.user) {
      return reply.status(401).send({ error: '未认证' });
    }

    try {
      const subscription = await getSubscription(request.user.userId);

      if (!subscription) {
        return reply.status(404).send({
          success: false,
          error: '订阅信息不存在',
        });
      }

      return reply.send({
        success: true,
        data: {
          plan: subscription.plan,
          tokens_limit: subscription.tokens_limit,
          tokens_used: subscription.tokens_used,
          tokens_remaining: subscription.tokens_limit - subscription.tokens_used,
          usage_percentage: ((subscription.tokens_used / subscription.tokens_limit) * 100).toFixed(1),
          reset_at: subscription.reset_at,
          expires_at: subscription.expires_at,
        },
      });
    } catch (err) {
      return reply.status(500).send({
        success: false,
        error: err instanceof Error ? err.message : '获取订阅信息失败',
      });
    }
  });

  // GET /api/billing/usage - 获取使用量统计
  fastify.get('/api/billing/usage', {
    preHandler: jwtAuthMiddleware,
  }, async (request, reply) => {
    if (!request.user) {
      return reply.status(401).send({ error: '未认证' });
    }

    try {
      const { startDate, endDate } = request.query as { startDate?: string; endDate?: string };

      const start = startDate ? new Date(startDate) : undefined;
      const end = endDate ? new Date(endDate) : undefined;

      const stats = await getUsageStats(request.user.userId, start, end);

      // 计算总计
      const total = stats.reduce((acc, item) => ({
        tokens: acc.tokens + parseInt(item.tokens as any),
        cost: acc.cost + parseFloat(item.cost as any),
      }), { tokens: 0, cost: 0 });

      return reply.send({
        success: true,
        data: {
          daily: stats,
          total,
        },
      });
    } catch (err) {
      return reply.status(500).send({
        success: false,
        error: err instanceof Error ? err.message : '获取使用统计失败',
      });
    }
  });

  // POST /api/billing/upgrade - 升级套餐
  fastify.post('/api/billing/upgrade', {
    preHandler: jwtAuthMiddleware,
  }, async (request, reply) => {
    if (!request.user) {
      return reply.status(401).send({ error: '未认证' });
    }

    try {
      const body = upgradePlanSchema.parse(request.body);

      // 检查当前套餐
      const currentSubscription = await getSubscription(request.user.userId);
      if (!currentSubscription) {
        return reply.status(404).send({
          success: false,
          error: '订阅信息不存在',
        });
      }

      // 检查是否降级（不允许）
      const planOrder = { free: 0, basic: 1, pro: 2 };
      if (planOrder[body.plan] <= planOrder[currentSubscription.plan as keyof typeof planOrder]) {
        return reply.status(400).send({
          success: false,
          error: '不支持降级或重复升级',
        });
      }

      // 执行升级
      await upgradePlan(request.user.userId, body.plan);

      // 获取新的订阅信息
      const newSubscription = await getSubscription(request.user.userId);

      return reply.send({
        success: true,
        data: {
          plan: newSubscription?.plan,
          tokens_limit: newSubscription?.tokens_limit,
          expires_at: newSubscription?.expires_at,
        },
      });
    } catch (err) {
      if (err instanceof z.ZodError) {
        return reply.status(400).send({
          success: false,
          error: '请求参数错误',
          details: err.errors,
        });
      }

      return reply.status(500).send({
        success: false,
        error: err instanceof Error ? err.message : '升级套餐失败',
      });
    }
  });

  // GET /api/billing/stats - 获取并发统计（管理员）
  fastify.get('/api/billing/stats', {
    preHandler: jwtAuthMiddleware,
  }, async (request, reply) => {
    if (!request.user) {
      return reply.status(401).send({ error: '未认证' });
    }

    // 简单的管理员检查（可以改进）
    if (request.user.role !== 'admin') {
      return reply.status(403).send({
        success: false,
        error: '需要管理员权限',
      });
    }

    try {
      const { concurrencyLimiter } = await import('../concurrency-limiter.js');
      const stats = concurrencyLimiter.getStats();

      return reply.send({
        success: true,
        data: stats,
      });
    } catch (err) {
      return reply.status(500).send({
        success: false,
        error: err instanceof Error ? err.message : '获取统计失败',
      });
    }
  });
}
