---
name: web-terminal
description: 启动浏览器可访问的 CC 远程终端（手机/外网可操作）
---

# Web Terminal

通过浏览器远程访问 CC 终端，手机也能用。默认 `claude --continue` 自动接续最近对话。

## 典型场景（接力模式）

1. PC 上用 CC 工作中
2. 要出门 → 告诉 CC "启动 web terminal"
3. CC 启动服务 + 输出手机访问链接
4. **退出 PC 的 CC**（对话自动保存）
5. 手机打开链接 → `claude --continue` 自动接续刚才的对话
6. 回到工位 → PC 终端 `claude --continue` → 接续手机上的对话

> 注意：PTY 延迟创建，手机连上才启动 claude，不会跟 PC 的 CC 冲突。

## 架构

```
手机浏览器 → cloudflared → 127.0.0.1:7681 → WebSocket → 共享 PTY → claude --continue
                                                  ↑
本地浏览器 ─────────────────────────────────────┘
```

- **持久会话**：关浏览器不杀进程，重新打开恢复内容
- **多设备共享**：手机和电脑同时操控同一个 CC 会话
- **历史回放**：新连接自动回放最近 50KB 终端输出
- **自动重连**：断网后自动重连 10 次

## 执行步骤

当用户触发本 skill 时：

### 1. 检查是否已在运行

```bash
curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:7681/health
```
- 返回 200 → 已在运行，读取现有 URL 告知用户
- 其他 → 执行**第 2 步**

### 2. 一键启动

```bash
cd C:/Users/gdutb/Desktop/mycc/.claude/skills/web-terminal/scripts
node start.mjs
```

脚本自动完成：清理旧进程 → 启动服务 → 启动 cloudflared → 输出地址

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `WEB_TERMINAL_PORT` | 7681 | 监听端口 |
| `WEB_TERMINAL_TOKEN` | 随机生成 | 固定 token（方便收藏） |
| `WEB_TERMINAL_CMD` | claude | 启动命令 |
| `WEB_TERMINAL_CMD_ARGS` | --continue | 命令参数（默认接续最近对话） |
| `WEB_TERMINAL_CWD` | 当前目录 | 工作目录 |

## 安全要点

1. 绑定 `127.0.0.1`，不直接暴露公网
2. 环境变量白名单过滤
3. token 鉴权（HTTP + WebSocket 双校验）
4. 外网必须通过 cloudflared tunnel

## 前端功能

- 顶部栏：字号 A-/A+ 调节、搜索、连接状态
- 底部快捷键：Stop(Ctrl+C)、Enter、Tab、Esc、上下方向键
- 独立输入框：手机打字更方便
- 深色主题 + 移动端适配

## 与 mycc 的关系

| 维度 | mycc（飞书/网页） | web-terminal |
|------|-------------------|-------------|
| 交互 | 消息式一问一答 | 完整终端界面 |
| 对话 | 每次新对话 | --continue 接续 |
| 适用 | 快速提问 | 长任务、approve/deny |

两者互补，不冲突。
