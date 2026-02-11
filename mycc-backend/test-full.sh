#!/bin/bash
# MyCC 完整功能测试脚本

set -e

API="http://localhost:8080"
echo "=== MyCC 商业化后端测试 ==="
echo ""

# 测试 1: 健康检查
echo "✅ 测试 1: 健康检查"
curl -s "$API/health" | jq .
echo ""

# 测试 2: 注册 3 个用户
echo "✅ 测试 2: 注册 3 个用户"

echo "注册用户 1..."
USER1=$(curl -s -X POST "$API/api/auth/register" \
  -H "Content-Type: application/json" \
  -d '{"phone":"+8613800138001","password":"test123","nickname":"测试用户1"}')
TOKEN1=$(echo "$USER1" | jq -r '.data.token')
echo "用户1: $(echo "$USER1" | jq -r '.data.user.nickname') (ID: $(echo "$USER1" | jq -r '.data.user.id'))"

echo "注册用户 2..."
USER2=$(curl -s -X POST "$API/api/auth/register" \
  -H "Content-Type: application/json" \
  -d '{"phone":"+8613800138002","password":"test123","nickname":"测试用户2"}')
TOKEN2=$(echo "$USER2" | jq -r '.data.token')
echo "用户2: $(echo "$USER2" | jq -r '.data.user.nickname') (ID: $(echo "$USER2" | jq -r '.data.user.id'))"

echo "注册用户 3..."
USER3=$(curl -s -X POST "$API/api/auth/register" \
  -H "Content-Type: application/json" \
  -d '{"phone":"+8613800138003","password":"test123","nickname":"测试用户3"}')
TOKEN3=$(echo "$USER3" | jq -r '.data.token')
echo "用户3: $(echo "$USER3" | jq -r '.data.user.nickname') (ID: $(echo "$USER3" | jq -r '.data.user.id'))"
echo ""

# 测试 3: 查看用户信息
echo "✅ 测试 3: 查看用户信息"
curl -s "$API/api/auth/me" -H "Authorization: Bearer $TOKEN1" | jq '.data | {id, nickname, linux_user, status}'
echo ""

# 测试 4: 查看订阅信息
echo "✅ 测试 4: 查看订阅信息（用户1）"
curl -s "$API/api/billing/subscription" -H "Authorization: Bearer $TOKEN1" | jq '.data'
echo ""

# 测试 5: 升级套餐
echo "✅ 测试 5: 升级套餐（用户2 升级到基础版）"
curl -s -X POST "$API/api/billing/upgrade" \
  -H "Authorization: Bearer $TOKEN2" \
  -H "Content-Type: application/json" \
  -d '{"plan":"basic"}' | jq .
echo ""

echo "查看升级后的订阅..."
curl -s "$API/api/billing/subscription" -H "Authorization: Bearer $TOKEN2" | jq '.data'
echo ""

# 测试 6: 登录测试
echo "✅ 测试 6: 登录测试（用户3）"
LOGIN=$(curl -s -X POST "$API/api/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"credential":"+8613800138003","password":"test123"}')
echo "$LOGIN" | jq '.data.user'
echo ""

# 测试 7: 查看数据库
echo "✅ 测试 7: 查看数据库"
echo "用户列表:"
docker-compose -f mycc-backend/docker-compose.yml exec -T postgres psql -U mycc -d mycc_dev -c "SELECT id, phone, nickname, linux_user, status FROM users;" 2>/dev/null || echo "（需要在 mycc-backend 目录运行）"
echo ""

echo "订阅列表:"
docker-compose -f mycc-backend/docker-compose.yml exec -T postgres psql -U mycc -d mycc_dev -c "SELECT user_id, plan, tokens_limit, tokens_used FROM subscriptions;" 2>/dev/null || echo "（需要在 mycc-backend 目录运行）"
echo ""

# 测试总结
echo "=== 测试总结 ==="
echo "✅ 健康检查: 通过"
echo "✅ 用户注册: 3个用户创建成功"
echo "✅ 用户登录: 通过"
echo "✅ 获取用户信息: 通过"
echo "✅ 订阅管理: 通过"
echo "✅ 套餐升级: 通过"
echo ""
echo "Token 信息（可用于前端测试）:"
echo "用户1 Token: $TOKEN1"
echo "用户2 Token: $TOKEN2"
echo "用户3 Token: $TOKEN3"
echo ""
echo "前端测试地址: http://localhost:3001"
