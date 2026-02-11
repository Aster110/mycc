# VPS 测试部署指南（小配置）

## 服务器规格

**Google Cloud e2-medium**:
- 2 vCPU
- 4GB 内存
- 20GB SSD
- Ubuntu 22.04 LTS
- 地区: 台湾/新加坡

**预期容量**: 支持 20-30 个并发用户

---

## 快速部署（15 分钟）

### 1. 创建 VPS

```bash
# 在 Google Cloud Console 创建实例
# 或使用 gcloud CLI
gcloud compute instances create mycc-test \
  --machine-type=e2-medium \
  --zone=asia-east1-a \
  --image-family=ubuntu-2204-lts \
  --image-project=ubuntu-os-cloud \
  --boot-disk-size=20GB
```

### 2. SSH 登录

```bash
# 获取外部 IP
gcloud compute instances describe mycc-test --zone=asia-east1-a \
  --format='get(networkInterfaces[0].accessConfigs[0].natIP)'

# SSH 登录
ssh root@YOUR_VPS_IP
```

### 3. 一键部署脚本

在 VPS 上运行：

```bash
# 下载部署脚本
curl -fsSL https://raw.githubusercontent.com/your-org/mycc/main/mycc-backend/scripts/quick-deploy.sh | bash
```

或手动部署：

```bash
# 更新系统
apt update && apt upgrade -y

# 安装 Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs

# 安装 PostgreSQL
apt install -y postgresql postgresql-contrib

# 克隆项目
cd /root
git clone https://github.com/your-org/mycc.git
cd mycc/mycc-backend

# 安装依赖
npm install

# 配置数据库
sudo -u postgres psql <<EOF
CREATE DATABASE mycc_test;
CREATE USER mycc WITH PASSWORD 'test_password_123';
GRANT ALL PRIVILEGES ON DATABASE mycc_test TO mycc;
\c mycc_test
\i db/schema.sql
EOF

# 配置环境变量
cat > .env <<EOF
DATABASE_URL=postgresql://mycc:test_password_123@localhost:5432/mycc_test
JWT_SECRET=$(openssl rand -base64 32)
ANTHROPIC_API_KEY=sk-ant-your-api-key
PORT=8080
NODE_ENV=production
PLAN_FREE_TOKENS=10000
PLAN_BASIC_TOKENS=100000
PLAN_PRO_TOKENS=500000
MAX_CONCURRENT_USERS=20
MAX_CONCURRENT_PER_USER=1
EOF

# 构建
npm run build

# 启动服务（使用 PM2）
npm install -g pm2
pm2 start dist/index.js --name mycc-backend
pm2 save
pm2 startup
```

### 4. 配置防火墙

```bash
# 开放端口
ufw allow 22/tcp
ufw allow 8080/tcp
ufw enable
```

### 5. 测试 API

```bash
# 在本地测试
curl http://YOUR_VPS_IP:8080/health

# 注册用户
curl -X POST http://YOUR_VPS_IP:8080/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "phone": "+8613800138000",
    "password": "test123456",
    "nickname": "测试用户"
  }'
```

---

## 简化版（跳过 Linux 用户隔离）

测试阶段可以暂时跳过 Linux 用户隔离，直接用当前用户执行：

**修改 `src/multi-user-adapter.ts`**:

```typescript
// 强制使用开发模式（不创建 Linux 用户）
constructor(linuxUser: string) {
  this.linuxUser = linuxUser;
  this.isDev = true;  // 强制开发模式
}
```

这样所有用户共享同一个执行环境，但有独立的工作目录：
- `/tmp/mycc_test/mycc_u1001/workspace`
- `/tmp/mycc_test/mycc_u1002/workspace`

---

## 监控和维护

### 查看日志

```bash
# PM2 日志
pm2 logs mycc-backend

# 数据库日志
tail -f /var/log/postgresql/postgresql-14-main.log
```

### 查看状态

```bash
# 服务状态
pm2 status

# 数据库连接
sudo -u postgres psql -d mycc_test -c "SELECT COUNT(*) FROM users;"

# 系统资源
htop
```

### 重启服务

```bash
pm2 restart mycc-backend
```

---

## 成本估算（测试环境）

| 项目 | 月费 |
|------|------|
| VPS (e2-medium) | $25 |
| 流量 (10GB) | $1 |
| API (100 用户) | $150 |
| **总计** | **$176/月** |

---

## 压力测试

测试并发能力：

```bash
# 安装 Apache Bench
apt install -y apache2-utils

# 测试健康检查（100 并发，1000 请求）
ab -n 1000 -c 100 http://localhost:8080/health

# 测试认证接口（10 并发，100 请求）
ab -n 100 -c 10 -p register.json -T application/json \
  http://localhost:8080/api/auth/register
```

---

## 升级路径

测试成功后，升级到生产配置：

1. **垂直扩容**: e2-medium → e2-standard-4 (4 vCPU, 16GB)
2. **添加 Redis**: 缓存和限流
3. **配置 Nginx**: 反向代理 + HTTPS
4. **启用监控**: Prometheus + Grafana
5. **真实用户隔离**: 启用 Linux 用户创建

---

## 故障排查

### 数据库连接失败

```bash
# 检查 PostgreSQL 状态
systemctl status postgresql

# 测试连接
psql -U mycc -d mycc_test -h localhost
```

### 端口被占用

```bash
# 查看占用
lsof -i :8080

# 杀死进程
pm2 delete mycc-backend
```

### Claude CLI 未安装

```bash
# 安装 Claude CLI
npm install -g @anthropic-ai/claude-code

# 验证
claude --version
```

---

## 下一步

1. ✅ 部署到 VPS
2. ✅ 测试所有 API
3. ⏳ 前端 UI 改造
4. ⏳ 集成测试
5. ⏳ 性能优化
