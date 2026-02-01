# 定时任务 SOP

> 这是给 AI 看的操作流程，AI 自己执行，用户只需要确认。

---

## 首次安装

### Step 1: 检查当前状态

```bash
# 检查 mycc 后端是否在运行
lsof -i :8080 -t
```

如果有输出，说明后端已在运行，跳到 Step 4。

### Step 2: 更新后端代码

```bash
cd .claude/skills/mycc/scripts
npm install
```

### Step 3: 创建任务配置

```bash
# 复制模板为正式配置
cp .claude/skills/scheduler/tasks.md.example .claude/skills/scheduler/tasks.md
```

> 注：`history.md` 会在首次执行任务时自动创建，无需手动。

### Step 4: 启动后端

执行 `/mycc` 启动后端。

### Step 5: 验证定时任务

1. 在 `tasks.md` 添加测试任务：
   ```
   | 每1分钟 | 测试任务 | /tell-me | 发个通知测试一下 |
   ```
2. 等待 1 分钟
3. 收到飞书通知 = 成功
4. 删除测试任务

---

## 升级（已有用户）

### Step 1: 保存当前连接信息

```bash
# 读取当前配置，告诉用户
cat .claude/skills/mycc/current.json
```

**告诉用户**：
```
后端需要重启以应用更新。

你的连接信息：
- 配对码：{pairCode}
- 连接码：{routeToken}

重启期间（约 2-5 分钟）小程序/网页会暂时断开。
重启完成后，连接会自动恢复，无需重新配对。

如果超过 5 分钟还没恢复，请回到电脑前检查后端服务。
```

### Step 2: 停止当前后端

```bash
lsof -i :8080 -t | xargs kill
```

### Step 3: 更新代码

```bash
cd .claude/skills/mycc/scripts
npm install
```

### Step 4: 创建 scheduler 配置（如果没有）

```bash
# 检查是否已有配置
if [ ! -f .claude/skills/scheduler/tasks.md ]; then
  cp .claude/skills/scheduler/tasks.md.example .claude/skills/scheduler/tasks.md
  echo "已创建 tasks.md"
fi
```

### Step 5: 重启后端

执行 `/mycc` 启动后端。

### Step 6: 验证

1. 读取 `current.json` 确认新的连接信息
2. 告诉用户连接已恢复
3. 可选：添加测试任务验证定时功能
