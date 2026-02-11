#!/bin/bash
# 快速启动开发环境

set -e

echo "=== MyCC Backend 开发环境启动 ==="

# 检查 Docker 是否运行
if ! docker info > /dev/null 2>&1; then
  echo "❌ Docker 未运行，请先启动 Docker"
  exit 1
fi

# 启动 Docker 服务
echo "📦 启动 Docker 服务（PostgreSQL + Redis）..."
docker-compose up -d

# 等待数据库就绪
echo "⏳ 等待数据库就绪..."
sleep 5

# 检查数据库连接
until docker-compose exec -T postgres pg_isready -U mycc > /dev/null 2>&1; do
  echo "⏳ 等待 PostgreSQL..."
  sleep 2
done

echo "✅ PostgreSQL 已就绪"

# 检查 Redis 连接
until docker-compose exec -T redis redis-cli ping > /dev/null 2>&1; do
  echo "⏳ 等待 Redis..."
  sleep 2
done

echo "✅ Redis 已就绪"

# 创建 .env 文件（如果不存在）
if [ ! -f .env ]; then
  echo "📝 创建 .env 文件..."
  cp .env.example .env
  echo "⚠️  请编辑 .env 文件，设置 ANTHROPIC_API_KEY"
fi

# 安装依赖（如果需要）
if [ ! -d node_modules ]; then
  echo "📦 安装依赖..."
  npm install
fi

echo ""
echo "✅ 开发环境启动完成！"
echo ""
echo "下一步："
echo "  1. 编辑 .env 文件，设置 ANTHROPIC_API_KEY"
echo "  2. 运行 'npm run dev' 启动后端服务"
echo ""
echo "常用命令："
echo "  npm run dev          - 启动开发服务器"
echo "  docker-compose logs  - 查看 Docker 日志"
echo "  docker-compose down  - 停止 Docker 服务"
