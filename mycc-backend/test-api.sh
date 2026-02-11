#!/bin/bash
# API 测试脚本

BASE_URL="http://localhost:8080"
TOKEN=""

echo "=== MyCC Backend API 测试 ==="
echo ""

# 1. 健康检查
echo "1️⃣ 健康检查"
curl -s "$BASE_URL/health" | jq .
echo ""

# 2. 注册用户
echo "2️⃣ 注册用户"
REGISTER_RESPONSE=$(curl -s -X POST "$BASE_URL/api/auth/register" \
  -H "Content-Type: application/json" \
  -d '{
    "phone": "+8613800138000",
    "password": "test123456",
    "nickname": "测试用户"
  }')

echo "$REGISTER_RESPONSE" | jq .

# 提取 token
TOKEN=$(echo "$REGISTER_RESPONSE" | jq -r '.data.token')
echo "Token: $TOKEN"
echo ""

# 3. 获取当前用户信息
echo "3️⃣ 获取当前用户信息"
curl -s "$BASE_URL/api/auth/me" \
  -H "Authorization: Bearer $TOKEN" | jq .
echo ""

# 4. 获取订阅信息
echo "4️⃣ 获取订阅信息"
curl -s "$BASE_URL/api/billing/subscription" \
  -H "Authorization: Bearer $TOKEN" | jq .
echo ""

# 5. 发送消息（SSE 流式响应）
echo "5️⃣ 发送消息（前 10 行）"
curl -s -X POST "$BASE_URL/api/chat" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "message": "你好，请用一句话介绍你自己"
  }' | head -10
echo ""
echo "..."
echo ""

# 6. 获取会话列表
echo "6️⃣ 获取会话列表"
curl -s "$BASE_URL/api/chat/sessions?limit=5" \
  -H "Authorization: Bearer $TOKEN" | jq .
echo ""

# 7. 获取使用统计
echo "7️⃣ 获取使用统计"
curl -s "$BASE_URL/api/billing/usage" \
  -H "Authorization: Bearer $TOKEN" | jq .
echo ""

echo "✅ 测试完成！"
