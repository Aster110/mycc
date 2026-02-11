import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { register, login, getCurrentUser } from '../auth/service.js';
import { jwtAuthMiddleware } from '../middleware/jwt.js';

// 注册请求验证
const registerSchema = z.object({
  phone: z.string().optional(),
  email: z.string().email().optional(),
  password: z.string().min(6),
  nickname: z.string().optional(),
}).refine(data => data.phone || data.email, {
  message: '手机号或邮箱必须提供一个',
});

// 登录请求验证
const loginSchema = z.object({
  credential: z.string(), // 手机号或邮箱
  password: z.string(),
});

export async function authRoutes(fastify: FastifyInstance) {
  // POST /api/auth/register - 用户注册
  fastify.post('/api/auth/register', async (request, reply) => {
    try {
      const body = registerSchema.parse(request.body);
      const result = await register(body);

      return reply.status(201).send({
        success: true,
        data: result,
      });
    } catch (err) {
      if (err instanceof z.ZodError) {
        return reply.status(400).send({
          success: false,
          error: '请求参数错误',
          details: err.errors,
        });
      }

      return reply.status(400).send({
        success: false,
        error: err instanceof Error ? err.message : '注册失败',
      });
    }
  });

  // POST /api/auth/login - 用户登录
  fastify.post('/api/auth/login', async (request, reply) => {
    try {
      const body = loginSchema.parse(request.body);
      const result = await login(body);

      return reply.send({
        success: true,
        data: result,
      });
    } catch (err) {
      if (err instanceof z.ZodError) {
        return reply.status(400).send({
          success: false,
          error: '请求参数错误',
          details: err.errors,
        });
      }

      return reply.status(401).send({
        success: false,
        error: err instanceof Error ? err.message : '登录失败',
      });
    }
  });

  // GET /api/auth/me - 获取当前用户信息（需要认证）
  fastify.get('/api/auth/me', {
    preHandler: jwtAuthMiddleware,
  }, async (request, reply) => {
    try {
      if (!request.user) {
        return reply.status(401).send({
          success: false,
          error: '未认证',
        });
      }

      const user = await getCurrentUser(request.user.userId);

      return reply.send({
        success: true,
        data: user,
      });
    } catch (err) {
      return reply.status(500).send({
        success: false,
        error: err instanceof Error ? err.message : '获取用户信息失败',
      });
    }
  });
}
