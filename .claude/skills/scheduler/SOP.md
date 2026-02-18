# 定时任务 SOP

> 这是给 AI 看的操作流程，AI 自己执行，用户只需要确认。

---

## Step 1: 检查版本

定时任务功能需要 **mycc 后端 ≥ 0.2.0**。

**请先阅读并执行**：[FAQ.md 第 1 条：检查是否是最新版本](../../../docs/FAQ.md)

- 版本 ≥ 0.2.0 → 跳到 Step 3
- 版本 < 0.2.0 → 继续 Step 2 更新后端

---

## Step 2: 更新后端（版本 < 0.2.0 时执行）

### 2.1 读取连接信息并告知用户

```bash
cat .claude/skills/mycc/current.json
```

**告诉用户**：
```
后端需要更新以支持定时任务功能。

你的连接信息（可在 .claude/skills/mycc/current.json 查看）：
- 配对码：{pairCode}
- 连接码：{routeToken}

更新期间（约 2-5 分钟）小程序/网页会暂时断开。
更新完成后，连接会自动恢复，无需重新配对。

如果超过 5 分钟还没恢复，请回到电脑前检查后端服务。
```

### 2.2 按 FAQ 第 1 条更新

按 FAQ 的更新步骤执行：停止后端 → 拉取代码 → 重启

### 2.3 更新完成后通知用户

如果已配置 `/tell-me` 技能：

```bash
# 执行 /tell-me 发送飞书通知
```

通知内容：「mycc 后端已更新到 0.2.0，定时任务功能已启用，连接已恢复。」

---

## Step 3: 启用定时任务

### 创建任务配置

```bash
# 检查是否已有配置
if [ ! -f .claude/skills/scheduler/tasks.md ]; then
  cp .claude/skills/scheduler/tasks.md.example .claude/skills/scheduler/tasks.md
  echo "已创建 tasks.md"
else
  echo "tasks.md 已存在"
fi
```

> 注：`history.md` 会在首次执行任务时自动创建，无需手动。

---

## Step 4: 验证

1. 在 `tasks.md` 的「一次性任务」添加测试任务（时间设为当前时间后 2 分钟）：
   ```
   | 2026-02-01 13:10 | 测试任务 | /tell-me | 定时任务测试成功 |
   ```
2. 等待到设定时间
3. 收到飞书通知 = 成功
4. 任务会在每日清理时自动删除

---

## 故障排查

**定时任务没执行？**
1. 检查后端是否在运行：`lsof -i :18080`
2. 检查版本是否 ≥ 0.2.0
3. 检查 tasks.md 格式是否正确
4. 查看 history.md 是否有记录
