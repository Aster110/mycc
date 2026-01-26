# Skills 开发指南

Skills 是 Claude Code 的可扩展能力模块。

## 什么是 Skill

Skill 是一个目录，包含 `SKILL.md` 文件和可选的资源文件，用于扩展 CC 的能力：
- **专业工作流**：多步骤的领域流程
- **工具集成**：特定文件格式或 API 的使用方法
- **领域知识**：公司特定知识、schema、业务逻辑
- **打包资源**：脚本、参考文档、资产文件

## 目录结构

```
skill-name/
├── SKILL.md          # 必须 - 核心指令
└── 可选资源/
    ├── scripts/      # 可执行脚本（Python/Bash）
    ├── references/   # 参考文档（按需加载）
    └── assets/       # 输出资源（模板、图标）
```

## SKILL.md 格式

```yaml
---
name: skill-name
description: 做什么 + 什么时候触发（这是最重要的字段）
---

# Skill 标题

[指令内容]

## 触发词
- "关键词1"
- "关键词2"

## 执行步骤
1. xxx
2. xxx

## 示例
[示例用法]
```

## 创建新 Skill

1. 创建目录：`mkdir -p .claude/skills/你的skill名`
2. 编写 `SKILL.md`
3. 添加脚本或资源（如需要）
4. 测试触发词是否有效

## 本仓库包含的示例 Skill

| Skill | 功能 |
|-------|------|
| `skill-creator` | 帮助创建新的 Skill |
| `dashboard` | 能力看板可视化 |

## 更多资源

- [官方 Skill 仓库](https://github.com/anthropics/skills)
