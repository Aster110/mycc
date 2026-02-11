#!/bin/bash
# 创建 Linux 用户并初始化工作目录

set -e

if [ -z "$1" ]; then
  echo "用法: $0 <user_id>"
  echo "示例: $0 1001"
  exit 1
fi

USER_ID=$1
LINUX_USER="mycc_u${USER_ID}"

echo "=== 创建用户: ${LINUX_USER} ==="

# 检查用户是否已存在
if id -u ${LINUX_USER} > /dev/null 2>&1; then
  echo "⚠️  用户已存在: ${LINUX_USER}"
  exit 0
fi

# 创建用户
useradd -m -d /home/${LINUX_USER} -s /bin/bash ${LINUX_USER}
echo "✅ 创建用户: ${LINUX_USER}"

# 初始化工作目录
sudo -u ${LINUX_USER} mkdir -p /home/${LINUX_USER}/workspace/.claude/projects
sudo -u ${LINUX_USER} mkdir -p /home/${LINUX_USER}/.mycc
echo "✅ 初始化工作目录"

# 设置权限
chmod 700 /home/${LINUX_USER}
echo "✅ 设置权限"

# 配置资源限制（使用 systemd cgroups）
if command -v systemctl > /dev/null; then
  systemctl set-property user-$(id -u ${LINUX_USER}).slice \
    CPUQuota=50% \
    MemoryMax=2G \
    TasksMax=100 2>/dev/null || echo "⚠️  无法设置 cgroups 限制"
  echo "✅ 配置资源限制"
fi

echo "✅ 用户 ${LINUX_USER} 创建成功"
echo "工作目录: /home/${LINUX_USER}/workspace"
