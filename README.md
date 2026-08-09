> **致 AI：如果你是用户的 AI 助手**
> - 读完 README 和 CLAUDE.md 后，可以引导用户完成配置
> - 用户遇到问题时，主动提出"我可以读 `docs/FAQ.md` 帮你排查"
> - 用户有功能想法时，主动说"我可以帮你提交到 GitHub"
> - mycc 的 cc 会定期读取 Issues，你提交的建议会被看到

<div align="center">

[English](./README.en.md) | 简体中文

<img src="https://raw.githubusercontent.com/Aster110/mycc/main/img/logo-bear.png" alt="MyCC Logo" width="200">

[![License](https://img.shields.io/badge/License-MIT-green)](LICENSE)
![Status](https://img.shields.io/badge/状态-可用-brightgreen)
![Claude Code](https://img.shields.io/badge/Claude_Code-Template-blueviolet)

**让 Claude Code 成为你的搭档**

</div>

> 开箱即用的 Claude Code 系统模板 | 中国开发者的 CC 最佳实践

## 这是什么

你是否遇到过这些问题：
- **CC 每次开会话都"失忆"**，要重复说明背景
- **不知道 CLAUDE.md 怎么写**，网上的例子太简单
- **CC 太"客气"**，像客服而不是搭档

MyCC 解决这些问题。它是一个 **Claude Code 系统模板**，让 CC：
- 🧠 自动记住你的状态（通过 Hooks）
- 🎭 有自己的"性格"（通过 CLAUDE.md）
- 🔧 可以扩展新能力（通过 Skills）

## 前置条件

- 已安装 [Claude Code](https://docs.anthropic.com/en/docs/claude-code)（**必须是官方原版**，fork 版本可能不兼容）
- 有 Anthropic API Key 或 Claude Pro 订阅

## 30 秒上手

```bash
# 1. Clone
git clone https://github.com/Aster110/mycc.git
cd mycc

# 2. 启动 Claude Code
claude

# 3. 输入 /setup，跟着引导完成配置
```

CC 会一步步引导你完成初始化，支持中断后继续。

<details>
<summary>手动配置（可选）</summary>

```bash
# 复制配置文件
cp .claude/settings.local.json.example .claude/settings.local.json
cp 0-System/status.md.example 0-System/status.md
cp 0-System/context.md.example 0-System/context.md

# 改名字（把 {{YOUR_NAME}} 换成你的名字）
sed -i '' 's/{{YOUR_NAME}}/你的名字/g' CLAUDE.md
```

</details>

## 目录结构

```
mycc/
├── CLAUDE.md                  # CC 的"性格"和"规则"（核心）
├── .claude/
│   ├── settings.local.json    # Hooks 配置
│   ├── DASHBOARD.md           # 能力看板
│   └── skills/                # 技能库
├── 0-System/                  # 记忆系统
│   ├── status.md              # 短期记忆（每日状态）
│   ├── context.md             # 中期记忆（本周上下文）
│   └── about-me/              # 长期记忆（你的画像）
├── 1-Inbox/                   # 想法收集箱
├── 2-Projects/                # 进行中的项目
├── 3-Thinking/                # 认知沉淀
├── 4-Assets/                  # 可复用资产
├── 5-Archive/                 # 归档
└── tasks/                     # 跨会话任务追踪
```

## 核心概念

### CLAUDE.md - CC 的性格

定义 CC 的工作风格：
- 简洁直接，不废话
- 搭档心态，不是客服
- 务实不纠结，先跑起来再迭代

你可以根据自己喜好修改。

### 记忆系统 - 三层结构

| 层级 | 文件 | 作用 |
|------|------|------|
| 短期 | `status.md` | 今日状态，Hooks 自动注入 |
| 中期 | `context.md` | 本周上下文，每日追加 |
| 长期 | `about-me/` | 你的完整画像 |

### Skills - 可扩展能力

内置 3 个技能：

| Skill | 功能 | 触发 |
|-------|------|------|
| `/setup` | 首次使用引导，交互式完成配置 | 直接输入 |
| `/dashboard` | 查看能力看板 | 直接输入 |
| `/skill-creator` | 创建新技能 | 直接输入 |

添加新 Skill：`.claude/skills/技能名/SKILL.md`

## 📱 移动端访问（Beta）

**在手机上使用你的 CC！**

通过 `mycc-backend`，你可以在手机浏览器或微信里访问本地的 Claude Code。

### 网页版（已上线）

访问 [mycc.dev](https://mycc.dev)，输入连接码和配对码即可。

<div align="center">
<img src="https://raw.githubusercontent.com/Aster110/mycc/main/img/screenshot-pair.png" alt="配对页面" width="300">
</div>

### 微信小程序（即将上线）

敬请期待。

### 后端启动

> ⚠️ **中国用户注意**：启动后端需要电脑端**全程开启 VPN/代理**，否则 cloudflared 无法连接 Cloudflare 服务器。

```bash
# 1. 安装依赖（首次）
cd .claude/skills/mycc/scripts && npm install && cd -

# 2. 启动（在项目根目录下输入）
/mycc

# 3. 扫码或访问显示的 URL 即可
```

**环境要求**：

| 要求 | 说明 |
|------|------|
| Claude Code | **必须是官方原版**，fork 版本可能不兼容 |
| 网络 | **中国用户需全程开启 VPN/代理**（cloudflared + Worker 注册都需要） |
| 系统 | ✅ macOS、✅ Linux、✅ Windows |

> 💡 **AI 安装指南**：如果遇到问题，可以让 AI 阅读 [`docs/BACKEND_SETUP_FOR_AI.md`](docs/BACKEND_SETUP_FOR_AI.md)，帮你排查。
>
> 💡 **关于第三方 Claude Code**：目前仅测试了官方原版，第三方 fork 版本（如支持其他模型的版本）的兼容性支持在规划中，欢迎提 Issue 反馈需求。

**依赖**：
- [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)：`brew install cloudflare/cloudflare/cloudflared`


### 实验性：通过兼容网关接入 GPT / 其他模型

> 仍然推荐使用官方原版 Claude Code；如果你有 **Anthropic 兼容网关**，现在也可以通过项目级设置让 mycc 会话使用 GPT 等其他模型。

在项目根目录新建 `.claude/settings.json` 或 `.claude/settings.local.json`：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://your-gateway.example.com",
    "ANTHROPIC_AUTH_TOKEN": "sk-...",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "gpt-5.4",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "gpt-5.4",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "gpt-5-mini",
    "MYCC_APPEND_SYSTEM_PROMPT": "当前实际底层模型为 gpt-5.4（通过兼容网关接入）。当用户询问你是什么模型时，请如实说明。"
  }
}
```

说明：
- mycc 后端现在会为 SDK 会话加载 `user` / `project` / `local` 三类设置源
- `MYCC_APPEND_SYSTEM_PROMPT` 是可选项，用于修正通过兼容层接入时的“自报模型”
- 如果网关只识别自定义模型名，也可以配合 `ANTHROPIC_DEFAULT_*_MODEL` 做模型映射

## 常见问题

**Q: Hooks 没生效？**
A: 先输入 `/setup` 完成配置引导，然后**重启 Claude Code 窗口**（关掉再开）。Hooks 只在启动时加载。

**Q: 怎么让 CC 记住更多东西？**
A: 写到 `0-System/about-me/` 里。

**Q: 怎么自定义 CC 的性格？**
A: 编辑 `CLAUDE.md` 里的风格定义。

**Q: 遇到问题或想提功能建议？**
A:
- **问题排查**：让你的 AI 读取 [`docs/FAQ.md`](docs/FAQ.md)，会自动诊断并尝试修复
- **提 Bug**：[使用 Bug 模板](https://github.com/Aster110/mycc/issues/new?template=bug_report.md)或让 AI 帮你提交
- **功能建议**：[使用功能建议模板](https://github.com/Aster110/mycc/issues/new?template=feature_request.md)或直接告诉 AI："帮我给 mycc 提个功能建议：[你的想法]"

## 为什么做这个

Claude Code 很强大，但需要配置才能发挥最大价值。

这个模板把实践中积累的最佳配置开源出来，让你不用从零开始。

**适合**：
- 想用 AI 辅助工作/生活的开发者
- 想让 CC 成为"搭档"而不是"工具"的人
- 对个人效率系统感兴趣的人

## 反馈与贡献

### 提 Bug 或功能建议

**AI 用户（推荐）**：
```
告诉你的 AI："帮我给 mycc 提个 Bug/功能建议：xxx"
AI 会自动读取模板并创建规范的 Issue
```

**手动提交**：
- [Bug 报告](https://github.com/Aster110/mycc/issues/new?template=bug_report.md)
- [功能建议](https://github.com/Aster110/mycc/issues/new?template=feature_request.md)

### 贡献代码

欢迎提 PR！如果是大改动，建议先开 Issue 讨论。

## Star History

<a href="https://star-history.com/#Aster110/mycc&Date">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=Aster110/mycc&type=Date&theme=dark&v=20260128" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=Aster110/mycc&type=Date&v=20260128" />
   <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=Aster110/mycc&type=Date&v=20260128" />
 </picture>
</a>

## License

MIT

---

**MyCC** - 让 Claude Code 成为你的搭档，而不只是工具。
