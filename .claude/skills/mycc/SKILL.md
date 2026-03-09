---
name: mycc
description: 启动 mycc 小程序后端服务（后台运行）。触发词："/mycc"、"启动 mycc"、"启动小程序后端"、"检查 mycc 状态"、"启动飞书后端"
---

# mycc

启动 mycc 小程序本地后端，连接网页版/小程序与本地 Claude Code。

支持双通道同时运行：
- **Web 通道**：网页版/小程序访问（默认）
- **飞书通道**：飞书群双向通信（需配置）

**特性**：通道独立启动，任意通道失败不影响其他通道

## 环境要求

| 要求 | 说明 |
|------|------|
| Claude Code | **必须是官方原版**，fork 版本可能不兼容 |
| 网络 | **需要 VPN/代理**（cloudflared 需要访问外网） |
| 系统 | ✅ macOS、✅ Linux、✅ Windows (原生)、⚠️ WSL（不稳定） |

> 💡 **关于第三方 Claude Code**：目前仅测试了官方原版，第三方 fork 版本的兼容性支持在规划中。

## 依赖

- **Node.js 18+**：运行后端服务
- **cloudflared**：
  - macOS: `brew install cloudflare/cloudflare/cloudflared`
  - Linux: 参考 [官方文档](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)
  - Windows: `winget install Cloudflare.cloudflared` 或从官网下载
- **飞书（可选）**：
  - 需要飞书企业自建应用
  - 配置环境变量：`FEISHU_APP_ID`, `FEISHU_APP_SECRET`, `FEISHU_ENCRYPT_KEY`, `FEISHU_VERIFICATION_TOKEN`

## 启动方式

### 方式 1：使用 `/mycc` 命令（推荐）

直接在 Claude Code 中输入：
- `/mycc` - 同时启动 Web 和飞书通道（如果配置了）
- `启动 mycc`
- `启动小程序后端`

**通道行为**：
- Web 通道默认启动
- 飞书通道需要配置环境变量才会启动
- 任意通道启动失败不影响其他通道

### 方式 2：使用启动脚本

| 系统 | Web 模式 | 飞书模式 |
|------|----------|----------|
| Windows | `.\start-mycc.ps1` | `.\start-feishu-mycc.ps1` |
| macOS/Linux | `./start-mycc.sh` | `./start-feishu-mycc.sh` |

> ⚠️ **首次运行**：先安装依赖
> ```bash
> cd .claude/skills/mycc/scripts && npm install && cd -
> ```

## 触发词

- "/mycc" - 同时启动 Web 和飞书通道
- "启动 mycc"
- "启动小程序后端"
- "检查 mycc 状态"

## 执行步骤

### 1. 安装依赖（首次）

```bash
cd .claude/skills/mycc/scripts && npm install && cd -
```

### 2. 启动后端

```bash
npx tsx .claude/skills/mycc/scripts/src/index.ts start
```

使用 `run_in_background: true` 让后端在后台持续运行。

> 代码会自动检测项目根目录（向上查找 `.claude/` 或 `claude.md`），无需手动指定 cwd。
>
> **通道启动逻辑**：
> - Web 通道默认启动
> - 飞书通道需要配置环境变量（`FEISHU_APP_ID`、`FEISHU_APP_SECRET` 等）
> - 任意通道启动失败不影响其他通道

### 3. 读取连接信息

等待几秒后读取：
```bash
sleep 5 && cat .claude/skills/mycc/current.json
```

### 3.5 检查通道开关

读取 `.env` 中的 `CHANNEL_WEB` 值（默认为 `true`）：
```bash
grep CHANNEL_WEB .env 2>/dev/null || echo "CHANNEL_WEB=true"
```

### 4. 告知用户

**通道状态**（根据 `.env` 实际配置显示）：
- Web 通道：`CHANNEL_WEB=false` 时已禁用，**不要展示 Web URL，不要打开浏览器**
- 飞书通道：配置 `FEISHU_APP_ID` 等环境变量后自动启动

**如果 Web 通道已启用（`CHANNEL_WEB` 不为 `false`）**，展示：
- 连接码（routeToken）
- 配对码（pairCode）
- 访问 https://mycc.dev 输入配对

**如果 Web 通道已禁用（`CHANNEL_WEB=false`）**，只展示：
- 飞书通道状态
- tunnel URL（供飞书事件订阅用）
- 不展示 mpUrl，不提及 mycc.dev

## 飞书模式配置

### 环境变量

在 `.env` 文件中配置：

```bash
FEISHU_ENABLED=true
FEISHU_APP_ID=your_app_id
FEISHU_APP_SECRET=your_app_secret
FEISHU_ENCRYPT_KEY=your_encrypt_key
FEISHU_VERIFICATION_TOKEN=your_verification_token
```

### 飞书应用配置

1. 创建飞书企业自建应用
2. 开启权限：
   - 接收消息：`im:message`、`im:message:group_at_msg`
   - 发送消息：`im:message`、`im:chat`
   - 事件订阅：`im.message.receive_v1`、`im.message.message_read_v1`
3. 配置事件请求 URL：
   - 使用 tunnel URL + `/feishu/events`
   - 例如：`https://xxx.trycloudflare.com/feishu/events`

## 关键说明

- **后台运行**：后端会在后台持续运行，不阻塞当前会话
- **自动检测 cwd**：会向上查找项目根目录，确保 hooks 能正确加载
- **连接信息**：保存在 `.claude/skills/mycc/current.json`
- **停止服务**：
  - Windows: `.\stop-mycc.ps1`
  - macOS/Linux: `./stop-mycc.sh`
  - 或手动：`lsof -i :18080 -t | xargs kill` (Unix) / `taskkill /PID <pid> /F` (Windows)

## 遇到问题？

**让 AI 自己解决。** 代码都在 `scripts/src/` 目录下，AI 可以：
1. 读取错误日志
2. 检查代码逻辑
3. 修复问题并重试

常见问题：
- **端口被占用**：`lsof -i :18080 -t | xargs kill`
- **cloudflared 未安装**：按上面的依赖说明安装
- **tunnel 启动失败**：检查网络，重试即可

---

## 连接信息格式

启动后保存在 `.claude/skills/mycc/current.json`：
```json
{
  "routeToken": "XXXXXX",
  "pairCode": "XXXXXX",
  "tunnelUrl": "https://xxx.trycloudflare.com",
  "mpUrl": "https://api.mycc.dev/XXXXXX",
  "cwd": "/path/to/project",
  "startedAt": "2026-01-27T06:00:00.000Z"
}
```

## API 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/{token}/health` | GET | 健康检查 |
| `/{token}/pair` | POST | 配对验证 |
| `/{token}/chat` | POST | 发送消息 |
| `/{token}/history/list` | GET | 历史记录列表 |
| `/{token}/history/{sessionId}` | GET | 对话详情 |
