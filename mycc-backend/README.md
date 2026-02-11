# MyCC Backend

MyCC 商业化后端服务

## 快速开始

### 1. 启动开发环境

```bash
# 方式一：使用自动化脚本（推荐）
./dev-setup.sh

# 方式二：手动启动
docker-compose up -d
npm install
cp .env.example .env
# 编辑 .env 设置 ANTHROPIC_API_KEY
npm run dev
```

### 2. 验证服务

```bash
# 健康检查
curl http://localhost:8080/health

# 注册用户
curl -X POST http://localhost:8080/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"phone": "+8613800138000", "password": "test123", "nickname": "测试用户"}'

# 登录
curl -X POST http://localhost:8080/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"credential": "+8613800138000", "password": "test123"}'
```

## 项目结构

```
mycc-backend/
├── db/
│   └── schema.sql          # 数据库表结构
├── src/
│   ├── db/
│   │   └── client.ts       # 数据库客户端
│   ├── auth/
│   │   └── service.ts      # 认证服务
│   ├── routes/
│   │   └── auth.ts         # 认证接口
│   ├── middleware/
│   │   └── jwt.ts          # JWT 认证中间件
│   └── index.ts            # 入口文件
├── scripts/                # 脚本文件
├── tests/                  # 测试文件
├── docker-compose.yml      # Docker 配置
├── dev-setup.sh            # 开发环境启动脚本
└── package.json
```

## 技术栈

- **TypeScript + Node.js** - 类型安全
- **Fastify** - 高性能 HTTP 框架
- **PostgreSQL** - 关系型数据库
- **JWT** - 用户认证
- **bcrypt** - 密码加密
- **Zod** - 数据验证

## API 文档

### 认证接口

#### POST /api/auth/register
注册新用户

**请求体**:
```json
{
  "phone": "+8613800138000",  // 可选，与 email 二选一
  "email": "user@example.com", // 可选，与 phone 二选一
  "password": "password123",   // 必填，至少 6 位
  "nickname": "用户昵称"        // 可选
}
```

**响应**:
```json
{
  "success": true,
  "data": {
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "user": {
      "id": 1,
      "phone": "+8613800138000",
      "nickname": "用户昵称",
      "linux_user": "mycc_u1",
      "plan": "free"
    }
  }
}
```

#### POST /api/auth/login
用户登录

**请求体**:
```json
{
  "credential": "+8613800138000",  // 手机号或邮箱
  "password": "password123"
}
```

**响应**: 同注册接口

#### GET /api/auth/me
获取当前用户信息（需要认证）

**请求头**:
```
Authorization: Bearer <token>
```

**响应**:
```json
{
  "success": true,
  "data": {
    "id": 1,
    "phone": "+8613800138000",
    "nickname": "用户昵称",
    "linux_user": "mycc_u1",
    "status": "active",
    "subscription": {
      "plan": "free",
      "tokens_limit": 10000,
      "tokens_used": 1234,
      "tokens_remaining": 8766,
      "reset_at": "2026-03-01T00:00:00Z"
    }
  }
}
```

## 环境变量

参考 `.env.example` 配置：

| 变量 | 说明 | 默认值 |
|------|------|--------|
| DATABASE_URL | PostgreSQL 连接字符串 | - |
| REDIS_URL | Redis 连接字符串（可选） | - |
| JWT_SECRET | JWT 签名密钥 | - |
| ANTHROPIC_API_KEY | Claude API 密钥 | - |
| PORT | 服务端口 | 8080 |
| NODE_ENV | 运行环境 | development |
| PLAN_FREE_TOKENS | 免费版额度 | 10000 |
| PLAN_BASIC_TOKENS | 基础版额度 | 100000 |
| PLAN_PRO_TOKENS | 专业版额度 | 500000 |

## 开发说明

### 本地开发 vs 生产环境

**本地开发**:
- 使用 Docker 容器运行数据库
- 不创建真实 Linux 用户，用目录隔离模拟
- 工作目录：`/tmp/mycc_dev/{linux_user}/workspace`

**生产环境**:
- 独立的数据库服务器
- 真实的 Linux 用户隔离（`useradd`）
- 工作目录：`/home/{linux_user}/workspace`

### 常用命令

```bash
# 开发
npm run dev          # 启动开发服务器（热重载）
npm run build        # 编译 TypeScript
npm start            # 启动生产服务器

# Docker
docker-compose up -d      # 启动服务
docker-compose down       # 停止服务
docker-compose logs -f    # 查看日志
docker-compose down -v    # 停止并删除数据

# 数据库
docker-compose exec postgres psql -U mycc -d mycc_dev
```

## 下一步

Phase 1 已完成，接下来：
- Phase 2: 多用户 HTTP 服务器改造
- Phase 3: API 接口设计
- Phase 4: 计费系统
- Phase 5: 部署和运维
