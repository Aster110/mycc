# Scheduler Skill 技术总结

> 2026-01-26 端到端测试通过，记录当前状态供后续迭代

---

## 一句话说明

**daemon.sh 每分钟检查 tasks.md，时间匹配就通过 cc-webui 唤醒 cc 执行任务。**

---

## 当前架构

```
tasks.md (任务文档)
    ↓ 每60秒读取
daemon.sh (守护进程)
    ↓ 时间匹配 ±2分钟
    ↓ 检查锁（防重复）
    ↓ POST /api/chat
cc-webui (HTTP 服务)
    ↓
Claude Code (执行任务)
```

---

## 文件结构

```
.claude/skills/scheduler/
├── SKILL.md        # Skill 定义（触发词、说明）
├── README.md       # 本文档
├── tasks.md        # 任务列表（用户编辑）
├── history.md      # 执行历史（自动记录）
└── scripts/
    └── daemon.sh   # 守护进程脚本
```

---

## 已解决的问题

| 问题 | 原因 | 解决方案 |
|------|------|----------|
| 任务重复触发 4-6 次 | touch 文件不是原子操作 | 改用 `mkdir` 原子锁 |
| 同一任务在 ±2 分钟窗口内多次触发 | 锁 key 用当前时间 | 改用任务时间作为锁 key |
| cc 无法访问项目文件 | workingDirectory 未传 | daemon.sh 加 PROJECT_DIR 参数 |
| cc 无法写 /tmp/ | acceptEdits 不允许项目外写入 | 改写项目内文件 |
| curl 响应被截断 | daemon 循环干扰 | curl 后台运行 + wait |

---

## 关键配置（开源时需用户修改）

daemon.sh 里的两个变量：
```bash
WEBUI_URL="http://localhost:18080"  # cc-webui 地址
PROJECT_DIR="/path/to/project"     # 项目根目录
```

---

## 权限说明

cc-webui 支持的 permissionMode：
- `default` - 需要用户确认
- `plan` - 规划模式
- `acceptEdits` - 自动接受编辑（当前使用）

**限制**：acceptEdits 只允许写 workingDirectory 内的文件。

---

## 待迭代方向

### 功能增强
- [ ] 支持 cron 表达式（更灵活的时间规则）
- [ ] 任务依赖（A 完成后触发 B）
- [ ] 失败重试机制
- [ ] 执行超时处理

### 体验优化
- [ ] 执行结果通知（推送到手机？）
- [ ] Web 界面管理任务
- [ ] 任务执行日志可视化

### 稳定性
- [ ] daemon 崩溃自动重启
- [ ] 多实例防冲突
- [ ] 健康检查接口

---

## 使用示例

tasks.md 中添加任务：
```markdown
| 时间 | 任务 | Skill | 说明 |
|------|------|-------|------|
| 08:00 | 每日初始化 | /morning | 更新日期、清理昨日 |
| 22:00 | 日志审计 | /check-log | 审计今日日志 |
```

启动守护进程：
```bash
nohup .claude/skills/scheduler/scripts/daemon.sh &
```

---

*最后更新：2026-01-26*
