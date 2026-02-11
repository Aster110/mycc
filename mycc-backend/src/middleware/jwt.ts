import { FastifyRequest, FastifyReply } from 'fastify';
import { verifyToken, JWTPayload } from '../auth/service.js';

// 扩展 FastifyRequest 类型
declare module 'fastify' {
  interface FastifyRequest {
    user?: JWTPayload;
  }
}

// JWT 认证中间件
export async function jwtAuthMiddleware(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  try {
    // 从 Authorization header 获取 token
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.status(401).send({ error: '未提供认证 token' });
    }

    const token = authHeader.substring(7); // 移除 "Bearer " 前缀

    // 验证 token
    const payload = verifyToken(token);

    // 将用户信息附加到 request
    request.user = payload;
  } catch (err) {
    return reply.status(401).send({
      error: 'Token 无效或已过期',
      message: err instanceof Error ? err.message : 'Unknown error'
    });
  }
}

// 可选的 JWT 认证（不强制要求）
export async function optionalJwtAuth(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  try {
    const authHeader = request.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.substring(7);
      const payload = verifyToken(token);
      request.user = payload;
    }
  } catch (err) {
    // 忽略错误，继续处理请求
  }
}
