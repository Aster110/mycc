# 生产环境部署指南

## 服务器要求

- **配置**: 16核32G 内存，100G SSD
- **系统**: Ubuntu 22.04 LTS
- **地区**: 香港/新加坡（需要访问 Anthropic API）
- **网络**: 公网 IP，开放 8080 端口

## 部署步骤

### 1. 准备服务器

```bash
# SSH 登录服务器
ssh root@your-server-ip

# 更新系统
apt update && apt upgrade -y

# 安装基础工具
apt install -y git curl wget vim
```

### 2. 克隆项目

```bash
# 创建部署目录
mkdir -p /home/mycc_service
cd /home/mycc_service

# 克隆项目
git clone https://github.com/your-org/mycc.git
cd mycc/mycc-backend
```

### 3. 运行部署脚本

```bash
# 赋予执行权限
chmod +x scripts/*.sh

# 运行生产环境部署脚本（需要 root 权限）
./scripts/prod-setup.sh
```

脚本会自动完成：
- 安装系统依赖（PostgreSQL、Redis、Node.js）
- 创建服务账号（mycc_service）
- 配置 sudo 权限
- 配置资源限制
- 初始化数据库
- 配置 systemd 服务

### 4. 配置环境变量

```bash
# 切换到服务账号
su - mycc_service
cd mycc/mycc-backend

# 复制环境变量模板
cp .env.example .env

# 编辑环境变量
vim .env
```

**必须配置的变量**:
```bash
# 数据库（修改密码）
DATABASE_URL=postgresql://mycc_user:YOUR_SECURE_PASSWORD@localhost:5432/mycc_production

# JWT 密钥（生成随机字符串）
JWT_SECRET=$(openssl rand -base64 32)

# Claude API 密钥
ANTHROPIC_API_KEY=sk-ant-your-api-key

# 生产环境
NODE_ENV=production
PORT=8080
```

### 5. 构建和启动服务

```bash
# 安装依赖
npm install

# 构建 TypeScript
npm run build

# 退出服务账号
exit

# 启动服务（需要 root）
systemctl start mycc-backend

# 查看状态
systemctl status mycc-backend

# 查看日志
journalctl -u mycc-backend -f
```

### 6. 配置反向代理（可选）

使用 Nginx 作为反向代理：

```bash
# 安装 Nginx
apt install -y nginx certbot python3-certbot-nginx

# 创建配置
cat > /etc/nginx/sites-available/mycc <<'EOF'
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://localhost:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # SSE 支持
        proxy_buffering off;
        proxy_read_timeout 3600s;
    }
}
EOF

# 启用配置
ln -s /etc/nginx/sites-available/mycc /etc/nginx/sites-enabled/
nginx -t
systemctl reload nginx

# 配置 HTTPS（推荐）
certbot --nginx -d your-domain.com
```

### 7. 配置监控

```bash
# 添加 cron 任务（每 5 分钟检查一次）
crontab -e

# 添加以下行
*/5 * * * * /home/mycc_service/mycc/mycc-backend/scripts/monitor.sh
```

## 用户管理

### 创建用户

当新用户注册时，系统会自动创建 Linux 用户。如果需要手动创建：

```bash
# 创建用户（user_id 从数据库获取）
./scripts/create-user.sh 1001
```

### 删除用户

用户注销后，延迟 7 天删除：

```bash
# 删除用户
./scripts/delete-user.sh 1001
```

## 维护操作

### 查看日志

```bash
# 实时日志
journalctl -u mycc-backend -f

# 最近 100 行
journalctl -u mycc-backend -n 100

# 今天的日志
journalctl -u mycc-backend --since today
```

### 重启服务

```bash
systemctl restart mycc-backend
```

### 更新代码

```bash
# 切换到服务账号
su - mycc_service
cd mycc/mycc-backend

# 拉取最新代码
git pull

# 安装依赖
npm install

# 重新构建
npm run build

# 退出并重启服务
exit
systemctl restart mycc-backend
```

### 数据库备份

```bash
# 备份数据库
sudo -u postgres pg_dump mycc_production > backup_$(date +%Y%m%d).sql

# 恢复数据库
sudo -u postgres psql mycc_production < backup_20260209.sql
```

### 重置月度额度

```bash
# 手动触发（通常由定时任务自动执行）
sudo -u postgres psql mycc_production <<EOF
UPDATE subscriptions
SET tokens_used = 0, reset_at = reset_at + interval '1 month'
WHERE reset_at <= NOW();
EOF
```

## 监控指标

### 关键指标

- **并发数**: 当前活跃请求数（目标 < 18/20）
- **用户数**: 总用户数（目标 < 270/300）
- **API 调用量**: 每分钟请求数
- **Token 使用量**: 每日 Token 消耗
- **错误率**: API 错误率（目标 < 5%）
- **响应时间**: 平均响应时间（目标 < 2s）

### 查看统计

```bash
# 并发统计（需要管理员 token）
curl -H "Authorization: Bearer ADMIN_TOKEN" \
  http://localhost:8080/api/billing/stats | jq .

# 数据库统计
sudo -u postgres psql mycc_production <<EOF
SELECT
  COUNT(*) as total_users,
  COUNT(*) FILTER (WHERE status = 'active') as active_users
FROM users;

SELECT
  plan,
  COUNT(*) as count,
  SUM(tokens_used) as total_tokens
FROM subscriptions
GROUP BY plan;
EOF
```

## 故障排查

### 服务无法启动

```bash
# 查看详细日志
journalctl -u mycc-backend -n 50 --no-pager

# 检查端口占用
lsof -i :8080

# 检查数据库连接
sudo -u postgres psql -d mycc_production -c "SELECT NOW();"
```

### 数据库连接失败

```bash
# 检查 PostgreSQL 状态
systemctl status postgresql

# 检查连接配置
sudo -u postgres psql -c "\conninfo"

# 重启 PostgreSQL
systemctl restart postgresql
```

### 用户无法执行 Claude CLI

```bash
# 检查 sudo 权限
sudo -u mycc_u1001 whoami

# 检查 Claude CLI 安装
which claude

# 检查用户工作目录
ls -la /home/mycc_u1001/workspace
```

## 安全建议

1. **定期更新系统**: `apt update && apt upgrade`
2. **配置防火墙**: 只开放必要端口（22, 80, 443）
3. **使用强密码**: 数据库密码至少 32 位随机字符
4. **启用 HTTPS**: 使用 Let's Encrypt 免费证书
5. **限制 SSH 访问**: 禁用 root 登录，使用密钥认证
6. **定期备份**: 每天自动备份数据库
7. **监控日志**: 定期检查异常访问和错误

## 性能优化

### 数据库优化

```sql
-- 创建索引（如果还没有）
CREATE INDEX CONCURRENTLY idx_usage_logs_user_created
  ON usage_logs(user_id, created_at DESC);

-- 定期清理旧数据（保留 90 天）
DELETE FROM usage_logs
WHERE created_at < NOW() - INTERVAL '90 days';

-- 分析表
ANALYZE users;
ANALYZE subscriptions;
ANALYZE usage_logs;
ANALYZE conversations;
```

### 应用优化

- 启用 Node.js 集群模式（多进程）
- 配置 Redis 缓存（可选）
- 使用 CDN 加速静态资源
- 启用 gzip 压缩

## 扩容方案

当单机无法满足需求时：

1. **垂直扩容**: 升级服务器配置（32核64G）
2. **水平扩容**:
   - 部署多台应用服务器
   - 使用负载均衡（Nginx/HAProxy）
   - 用户分片（user_id % N）
3. **数据库分离**: 独立的数据库服务器
4. **迁移到 K8s**: 容器化部署，自动扩缩容

## 成本估算

**单机配置（16核32G）**:
- 服务器: ¥600-800/月
- 带宽: ¥200/月
- API 成本: ¥15/用户/月
- **总成本**: ¥1000 + ¥15N（N 为用户数）

**1000 用户**:
- 服务器: ¥1000/月
- API: ¥15000/月
- **总成本**: ¥16000/月

## 联系支持

- GitHub Issues: https://github.com/your-org/mycc/issues
- 邮箱: support@mycc.dev
