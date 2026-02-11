#!/bin/bash
# 监控脚本 - 检查系统状态并发送告警

set -e

# 配置
ALERT_EMAIL="admin@example.com"
ALERT_WEBHOOK=""  # 可选：Slack/飞书 webhook

# 检查服务状态
check_service() {
  if ! systemctl is-active --quiet mycc-backend; then
    echo "❌ mycc-backend 服务未运行"
    return 1
  fi
  return 0
}

# 检查并发数
check_concurrency() {
  CONCURRENT=$(curl -s http://localhost:8080/api/billing/stats \
    -H "Authorization: Bearer ADMIN_TOKEN" | jq -r '.data.globalActive')

  if [ "$CONCURRENT" -gt 18 ]; then
    echo "⚠️  并发数过高: $CONCURRENT/20"
    return 1
  fi
  return 0
}

# 检查数据库连接
check_database() {
  if ! sudo -u postgres psql -d mycc_production -c "SELECT 1" > /dev/null 2>&1; then
    echo "❌ 数据库连接失败"
    return 1
  fi
  return 0
}

# 检查磁盘空间
check_disk() {
  DISK_USAGE=$(df -h / | awk 'NR==2 {print $5}' | sed 's/%//')
  if [ "$DISK_USAGE" -gt 80 ]; then
    echo "⚠️  磁盘使用率过高: ${DISK_USAGE}%"
    return 1
  fi
  return 0
}

# 检查内存
check_memory() {
  MEM_USAGE=$(free | awk 'NR==2 {printf "%.0f", $3/$2*100}')
  if [ "$MEM_USAGE" -gt 90 ]; then
    echo "⚠️  内存使用率过高: ${MEM_USAGE}%"
    return 1
  fi
  return 0
}

# 发送告警
send_alert() {
  local message=$1
  echo "[$(date)] $message" >> /var/log/mycc-alerts.log

  # 发送邮件（如果配置了）
  if [ -n "$ALERT_EMAIL" ]; then
    echo "$message" | mail -s "MyCC Alert" "$ALERT_EMAIL" 2>/dev/null || true
  fi

  # 发送 webhook（如果配置了）
  if [ -n "$ALERT_WEBHOOK" ]; then
    curl -X POST "$ALERT_WEBHOOK" \
      -H "Content-Type: application/json" \
      -d "{\"text\": \"$message\"}" 2>/dev/null || true
  fi
}

# 主检查流程
main() {
  ERRORS=""

  check_service || ERRORS="${ERRORS}\n- 服务状态异常"
  check_database || ERRORS="${ERRORS}\n- 数据库连接失败"
  check_disk || ERRORS="${ERRORS}\n- 磁盘空间不足"
  check_memory || ERRORS="${ERRORS}\n- 内存使用率过高"
  check_concurrency || ERRORS="${ERRORS}\n- 并发数过高"

  if [ -n "$ERRORS" ]; then
    send_alert "MyCC 监控告警:${ERRORS}"
    exit 1
  fi

  echo "✅ 所有检查通过"
}

main
