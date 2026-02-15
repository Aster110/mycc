import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import path from 'path';
import { jwtAuthMiddleware } from '../middleware/jwt.js';
import { concurrencyLimiter } from '../concurrency-limiter.js';
import { checkQuota, logUsage, upsertConversation, updateConversationStats } from '../db/client.js';
import { RemoteClaudeAdapter } from '../adapters/remote-claude-adapter.js';
import { extractSessionId, extractUsage, extractModel } from '../adapters/stream-parser.js';
import { validateLinuxUsername, validatePathPrefix } from '../utils/validation.js';

// 发送消息请求验证
const chatSchema = z.object({
  message: z.string().min(1),
  sessionId: z.string().optional(),
  images: z.array(z.object({
    data: z.string(),
    mediaType: z.string(),
  })).optional(),
});

export async function chatRoutes(fastify: FastifyInstance) {
  // POST /api/chat - 发送消息（SSE 流式响应）
  fastify.post('/api/chat', {
    preHandler: jwtAuthMiddleware,
  }, async (request, reply) => {
    if (!request.user) {
      return reply.status(401).send({ error: '未认证' });
    }

    try {
      const body = chatSchema.parse(request.body);
      const userId = request.user.userId;
      const linuxUser = request.user.linuxUser;

      // 检查额度
      const quota = await checkQuota(userId);
      if (!quota.allowed) {
        return reply.status(403).send({
          success: false,
          error: '额度已用完',
          remaining: 0,
        });
      }

      // 获取并发许可
      await concurrencyLimiter.acquire(userId);

      // 验证 linuxUser 格式
      if (!validateLinuxUsername(linuxUser)) {
        return reply.status(400).send({ error: 'Invalid user format' });
      }

      // 获取用户工作目录（VPS 上统一使用 /home/{linuxUser}/workspace）
      const cwd = path.join('/home', linuxUser, 'workspace');

      // 验证路径安全性
      if (!validatePathPrefix(cwd, '/home/')) {
        return reply.status(400).send({ error: 'Invalid path' });
      }

      // 创建 RemoteClaudeAdapter
      const adapter = new RemoteClaudeAdapter();

      // 设置 SSE 响应头
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });

      let currentSessionId = body.sessionId;
      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      let model = 'claude-sonnet-4-5';

      try {
        console.log(`[Chat] 用户 ${userId} 发送消息: ${body.message.substring(0, 50)}...`);

        // 流式处理响应
        for await (const event of adapter.chat({
          message: body.message,
          sessionId: body.sessionId,
          cwd,
          linuxUser,
          images: body.images,
        })) {
          // 提取 session_id
          const sessionId = extractSessionId(event);
          if (sessionId) {
            currentSessionId = sessionId;
          }

          // 提取 usage 信息
          const usage = extractUsage(event);
          if (usage) {
            totalInputTokens += usage.inputTokens;
            totalOutputTokens += usage.outputTokens;
          }

          // 提取 model 信息
          const modelName = extractModel(event);
          if (modelName) {
            model = modelName;
          }

          // 发送事件
          reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
        }

        // 记录使用量
        if (currentSessionId && (totalInputTokens > 0 || totalOutputTokens > 0)) {
          const costUsd = calculateCost(model, totalInputTokens, totalOutputTokens);

          await logUsage({
            userId,
            sessionId: currentSessionId,
            inputTokens: totalInputTokens,
            outputTokens: totalOutputTokens,
            model,
            costUsd,
          });

          // 更新会话统计
          await updateConversationStats(currentSessionId, totalInputTokens + totalOutputTokens);

          console.log(`[Chat] 用户 ${userId} 使用 ${totalInputTokens + totalOutputTokens} tokens (成本: $${costUsd.toFixed(4)})`);
        }

        // 发送完成事件
        reply.raw.write(`data: ${JSON.stringify({
          type: 'done',
          sessionId: currentSessionId,
          usage: {
            input_tokens: totalInputTokens,
            output_tokens: totalOutputTokens,
            total_tokens: totalInputTokens + totalOutputTokens,
          }
        })}\n\n`);
        reply.raw.end();

      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        reply.raw.write(`data: ${JSON.stringify({ type: 'error', error: errMsg })}\n\n`);
        reply.raw.end();
        console.error(`[Chat] 错误:`, error);
      } finally {
        // 释放并发许可
        concurrencyLimiter.release(userId);
      }

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
        error: err instanceof Error ? err.message : '发送消息失败',
      });
    }
  });

  // GET /api/chat/sessions - 获取会话列表
  fastify.get('/api/chat/sessions', {
    preHandler: jwtAuthMiddleware,
  }, async (request, reply) => {
    if (!request.user) {
      return reply.status(401).send({ error: '未认证' });
    }

    try {
      const { limit = '20', offset = '0' } = request.query as { limit?: string; offset?: string };

      // 验证分页参数
      const limitNum = parseInt(limit);
      const offsetNum = parseInt(offset);
      if (isNaN(limitNum) || isNaN(offsetNum) || limitNum < 0 || offsetNum < 0 || limitNum > 100) {
        return reply.status(400).send({ error: 'Invalid pagination parameters' });
      }

      const { getUserConversations } = await import('../db/client.js');

      const conversations = await getUserConversations(
        request.user.userId,
        limitNum,
        offsetNum
      );

      return reply.send({
        success: true,
        data: {
          conversations,
          total: conversations.length,
          hasMore: conversations.length === parseInt(limit),
        },
      });
    } catch (err) {
      return reply.status(500).send({
        success: false,
        error: err instanceof Error ? err.message : '获取会话列表失败',
      });
    }
  });

  // POST /api/chat/sessions/:sessionId/rename - 重命名会话
  fastify.post('/api/chat/sessions/:sessionId/rename', {
    preHandler: jwtAuthMiddleware,
  }, async (request, reply) => {
    if (!request.user) {
      return reply.status(401).send({ error: '未认证' });
    }

    try {
      const { sessionId } = request.params as { sessionId: string };
      const { newTitle } = request.body as { newTitle: string };

      if (!newTitle || typeof newTitle !== 'string' || newTitle.length === 0 || newTitle.length > 200) {
        return reply.status(400).send({
          success: false,
          error: 'newTitle 必须是 1-200 字符的字符串',
        });
      }

      await upsertConversation({
        userId: request.user.userId,
        sessionId,
        title: newTitle,
      });

      return reply.send({
        success: true,
      });
    } catch (err) {
      return reply.status(500).send({
        success: false,
        error: err instanceof Error ? err.message : '重命名失败',
      });
    }
  });
}

/**
 * 计算 API 成本
 * 基于 Anthropic 定价（2026-02）
 */
function calculateCost(model: string, inputTokens: number, outputTokens: number): number {
  // 价格单位: USD per million tokens
  const pricing: Record<string, { input: number; output: number }> = {
    'claude-opus-4': { input: 15, output: 75 },
    'claude-sonnet-4-5': { input: 3, output: 15 },
    'claude-haiku-4-5': { input: 0.8, output: 4 },
  };

  // 匹配模型（支持部分匹配）
  let modelPricing = pricing['claude-sonnet-4-5']; // 默认
  for (const [key, value] of Object.entries(pricing)) {
    if (model.includes(key)) {
      modelPricing = value;
      break;
    }
  }

  const inputCost = (inputTokens / 1_000_000) * modelPricing.input;
  const outputCost = (outputTokens / 1_000_000) * modelPricing.output;

  return inputCost + outputCost;
}
