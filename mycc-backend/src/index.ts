import Fastify from 'fastify';
import cors from '@fastify/cors';
import dotenv from 'dotenv';
import { authRoutes } from './routes/auth.js';
import { chatRoutes } from './routes/chat.js';
import { billingRoutes } from './routes/billing.js';
import { pool } from './db/client.js';

// 加载环境变量
dotenv.config();

const PORT = parseInt(process.env.PORT || '8080');
const HOST = '0.0.0.0';

// 创建 Fastify 实例
const fastify = Fastify({
  logger: {
    level: process.env.NODE_ENV === 'development' ? 'info' : 'warn',
  },
});

// 注册 CORS
await fastify.register(cors, {
  origin: ['http://localhost:3001', 'http://localhost:3000', 'http://127.0.0.1:3001'],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
});

// 健康检查
fastify.get('/health', async () => {
  return { status: 'ok', timestamp: new Date().toISOString() };
});

// 注册路由
await fastify.register(authRoutes);
await fastify.register(chatRoutes);
await fastify.register(billingRoutes);

// 启动服务器
async function start() {
  try {
    // 测试数据库连接
    await pool.query('SELECT NOW()');
    console.log('✅ 数据库连接成功');

    // 启动服务器
    await fastify.listen({ port: PORT, host: HOST });
    console.log(`🚀 服务器启动成功: http://${HOST}:${PORT}`);
    console.log(`📊 健康检查: http://${HOST}:${PORT}/health`);
  } catch (err) {
    console.error('❌ 启动失败:', err);
    process.exit(1);
  }
}

// 优雅关闭
process.on('SIGINT', async () => {
  console.log('\n⏳ 正在关闭服务器...');
  await fastify.close();
  await pool.end();
  console.log('✅ 服务器已关闭');
  process.exit(0);
});

start();
