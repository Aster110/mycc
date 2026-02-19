# MyCC 后端安装指南（给 AI 的版本）

> 本文档供 AI 助手阅读，帮助用户完成 mycc-backend 的安装和启动。

## 概述

mycc-backend 是一个本地后端服务，让用户通过手机浏览器访问本地的 Claude Code。

**支持平台**：
- ✅ macOS (ARM/Intel)
- ✅ Windows 10/11
- ✅ Linux

## 前置条件检查

### 1. Claude Code 已安装

```bash
# 检查 Claude Code
claude --version
```

**如果未安装**：
- 访问 https://docs.anthropic.com/en/docs/claude-code 安装官方版本
- Windows 用户可以用 `winget install Anthropic.ClaudeCode`

### 2. Node.js >= 18

```bash
node --version
```

**如果未安装**：
- macOS: `brew install node`
- Windows: 下载 https://nodejs.org/ 或 `winget install OpenJS.NodeJS.LTS`

### 3. cloudflared（可选但推荐）

cloudflared 用于创建安全隧道，让手机能访问本地服务。

```bash
# 检查
cloudflared --version
```

**如果未安装**：

macOS:
```bash
brew install cloudflare/cloudflare/cloudflared
```

Windows:
1. 下载 https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
2. 选择 Windows 64-bit (cloudflared-windows-amd64.exe)
3. 重命名为 `cloudflared.exe`
4. 放到 `C:\Tools\` 或任意目录
5. 将该目录添加到系统 PATH

或使用 winget:
```powershell
winget install Cloudflare.cloudflared
```

## 安装步骤

### Step 1: 进入项目目录

```bash
cd /path/to/mycc
```

### Step 2: 安装依赖

```bash
cd .claude/skills/mycc/scripts
npm install
cd -  # 回到项目根目录
```

### Step 3: 启动服务

在 Claude Code 会话中输入：
```
/mycc
```

或直接运行：
```bash
cd .claude/skills/mycc/scripts && npm run dev
```

## 启动成功标志

看到类似输出表示成功：
```
[CC] 服务已启动 @ http://localhost:8765
[CC] 连接码: XXXXXX
[CC] 配对码: XXXXXX
[CC] Tunnel URL: https://xxx.trycloudflare.com
```

## 常见问题排查

### Windows: Claude Code 调用失败

**错误**: `spawn claude ENOENT` 或 `spawn EINVAL`

**原因**: Windows 的 npm 全局安装会创建 `.cmd/.ps1` 文件，无法直接被 Node.js spawn。

**解决方案**: 已在代码中自动处理，会查找 `cli.js` 并用 `node` 执行。如果仍有问题：
1. 确认 Claude Code 已正确安装：`claude --version`
2. 检查 npm 全局目录：`npm root -g`
3. 确认 `%APPDATA%\npm\node_modules\@anthropic-ai\claude-code\cli.js` 存在

### Windows: cloudflared 找不到

**解决方案**：
1. 下载后放到 `C:\Tools\cloudflared.exe`
2. 添加 `C:\Tools` 到系统 PATH
3. 重启终端

或设置环境变量：
```powershell
$env:CLOUDFLARED_PATH = "C:\path\to\cloudflared.exe"
```

### 中国用户: Tunnel 连接失败

**原因**: cloudflared 需要访问 Cloudflare 服务器。

**解决方案**: 确保全程开启 VPN/代理。

### 端口被占用

**错误**: `EADDRINUSE: address already in use`

**解决方案**:

macOS/Linux:
```bash
lsof -i :8765  # 查看占用进程
kill <PID>     # 关闭进程
```

Windows:
```powershell
netstat -ano | findstr :8765
taskkill /PID <PID> /F
```

### ESM 模块错误

**错误**: `ERR_REQUIRE_ESM`

**原因**: 依赖需要 ESM 模块系统。

**解决方案**: 确保 `package.json` 包含 `"type": "module"`。

## 文件结构

```
.claude/skills/mycc/scripts/
├── package.json          # 依赖配置
├── src/
│   ├── index.ts          # 入口文件
│   ├── http-server.ts    # HTTP 服务
│   ├── platform.ts       # 跨平台工具（关键）
│   ├── config.ts         # 配置管理
│   ├── utils.ts          # 工具函数
│   └── adapters/
│       ├── interface.ts  # 适配器接口
│       └── official.ts   # 官方 SDK 适配器
└── dist/                 # 编译输出
```

## 关键代码位置

| 功能 | 文件 | 说明 |
|------|------|------|
| 跨平台逻辑 | `src/platform.ts` | 处理 Windows/Mac 差异 |
| Claude 调用 | `src/adapters/official.ts` | SDK 调用封装 |
| 服务启动 | `src/index.ts` | 主入口 |

## 开发调试

```bash
# 开发模式（热重载）
npm run dev

# 构建
npm run build

# 运行构建后版本
npm start
```

## 环境变量

| 变量 | 作用 | 示例 |
|------|------|------|
| `CLOUDFLARED_PATH` | 指定 cloudflared 路径 | `/opt/bin/cloudflared` |
| `PORT` | 指定服务端口 | `18080` |

---

*文档版本: 2026-01-28 | 支持 Windows + macOS*
