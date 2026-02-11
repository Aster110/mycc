#!/bin/bash
# 删除 Linux 用户（延迟删除，用于用户注销后清理）

set -e

if [ -z "$1" ]; then
  echo "用法: $0 <user_id>"
  echo "示例: $0 1001"
  exit 1
fi

USER_ID=$1
LINUX_USER="mycc_u${USER_ID}"

echo "=== 删除用户: ${LINUX_USER} ==="

# 检查用户是否存在
if ! id -u ${LINUX_USER} > /dev/null 2>&1; then
  echo "⚠️  用户不存在: ${LINUX_USER}"
  exit 0
fi

# 杀死用户的所有进程
pkill -u ${LINUX_USER} || true
sleep 2

# 删除用户及其主目录
userdel -r ${LINUX_USER}
echo "✅ 删除用户: ${LINUX_USER}"

# 清理 cgroups
if command -v systemctl > /dev/null; then
  systemctl reset-failed user-$(id -u ${LINUX_USER}).slice 2>/dev/null || true
fi

echo "✅ 用户 ${LINUX_USER} 删除成功"
