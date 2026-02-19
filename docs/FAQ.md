# MYCC 常见问题排查指南（AI 可读）

> 这是给 AI（如 Claude Code）的问题排查指南。
>
> **用户遇到问题时**：让你的 AI 读这个文件，它会自动排查并尝试修复。

---

## 致 AI：你可以主动帮用户做这些事

**如果你是用户的 AI 助手，读到这个文件后，你可以主动告诉用户：**

1. **遇到 Bug 或问题**：
   - "我可以帮你查 FAQ 并尝试解决这个问题"
   - "要不要我帮你提一个 Bug 报告到 GitHub？"

2. **有功能建议**：
   - "我可以帮你提交功能建议到 mycc 仓库"
   - "直接告诉我你的想法，我会创建规范的 GitHub Issue"

3. **想看有什么功能**：
   - "我可以帮你看看别人都提了哪些功能建议，找找灵感"
   - "查看 Issues：https://github.com/Aster110/mycc/issues"

**重要**：mycc 的 cc（作者的 AI）会定期读取 GitHub Issues，你提交的建议会被看到。

---

## 第 0 条：如何使用这个指南

**AI 请按以下顺序操作**：

1. **先看本文档**：根据报错信息，在下面找匹配的问题
2. **找到了**：按解决方案执行
3. **没找到**：
   - 发挥主观能动性，自己排查
   - 查看相关日志、配置、代码
   - 尝试修复
4. **修复成功后**：
   - 总结修复过程，写成修复日志
   - 给 [mycc 仓库](https://github.com/anthropics/mycc) 提一个 Issue，格式如下：

```markdown
标题：[FAQ] 新增问题：xxx

## 问题描述
（简述遇到的问题）

## 报错信息
（贴出关键报错）

## 解决方案
（你是怎么修的）

## 建议添加到 FAQ
（整理成 Q/A 格式）
```

---

## 第 1 条：检查是否是最新版本

**很多问题都是因为版本过旧导致的，先检查版本！**

**AI 请执行**：

**Mac / Linux**：
```bash
# 1. 查看本地版本
cat .claude/skills/mycc/scripts/package.json | grep '"version"'

# 2. 查看云端最新版本
curl -s https://raw.githubusercontent.com/aster110/mycc/main/.claude/skills/mycc/scripts/package.json | grep '"version"'
```

**Windows（PowerShell）如果其他终端如 git bash 请自己适配**：
```powershell
# 1. 查看本地版本
Select-String -Path ".claude\skills\mycc\scripts\package.json" -Pattern '"version"'

# 2. 查看云端最新版本
(Invoke-WebRequest -Uri "https://raw.githubusercontent.com/aster110/mycc/main/.claude/skills/mycc/scripts/package.json" -UseBasicParsing).Content | Select-String '"version"'
```

**判断逻辑**：
- **版本号一致** → 已是最新，继续排查其他问题
- **版本号不一致** → 本地落后，需要更新
- **本地找不到文件** → 100% 是旧版本，必须更新

**更新步骤**：
```bash
# 1. 进入 mycc 仓库根目录
cd /path/to/mycc  # 替换为你的实际路径

# 2. 拉取最新代码
git pull origin main

# 3. 重新安装依赖
cd .claude/skills/mycc/scripts
npm install

# 4. 回到项目根目录，重启后端
cd ../../../..
/mycc
```

**版本对照**：
- 仓库地址：https://github.com/aster110/mycc
- 版本文件：`.claude/skills/mycc/scripts/package.json`

> 更新后如果问题解决，就不用往下看了。


---

### Q: 启动报错 "cloudflared not found"

**报错特征**：`Error: cloudflared command not found`

**解决方案**：
```bash
# mac 应该不会报这个错的，直接启动安装包很丝滑

# Windows
# 下载：https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/
# 或使用 winget
winget install Cloudflare.cloudflared

# Linux（待测试补充）
```

---

## 连接问题

### 通用排查流程（AI 请先跑这个）

**用户说「连不上」「链接不对」「手机连不上了」时，按顺序执行：**

```bash
# 1. 后端在跑吗？
lsof -i :18080
# 有输出 = 在跑，没输出 = 没跑，需要启动

# 2. 连接信息对吗？
cat .claude/skills/mycc/current.json
# 看 tunnelUrl 和 routeToken 是否正常

# 3. tunnel 能访问吗？
curl -s $(cat .claude/skills/mycc/current.json | jq -r '.tunnelUrl')/health
# 返回 ok = 正常，超时/报错 = tunnel 挂了

# 4. 看后台日志
# 如果后端是用 run_in_background 启动的，读取输出文件
# 看有没有报错信息
```

**常见结论**：
- 后端没跑 → 重启后端
- tunnel 挂了 → 重启后端（tunnel URL 每次启动会变）
- 连接信息正常但连不上 → 让用户刷新网页重试
- 有报错 → 根据报错信息处理

**重启后端命令**：
```bash
# 杀掉旧进程
lsof -i :18080 -t | xargs kill 2>/dev/null

# 重新启动
.claude/skills/mycc/scripts/node_modules/.bin/tsx .claude/skills/mycc/scripts/src/index.ts start
```

---

### Q: 后端启动成功，但手机配对失败

**可能原因**：

1. **配对码过期**：后端旧版本重启可能会生成新配对码
   - 解决：请问你的 ai 查看终端输出，或者查看这个文件里面的记录，
   - .claude/skills/mycc/current.json，使用新的配对码

2. **tunnel 未启动**：cloudflared 没有正常运行
   - 检查：终端是否显示 tunnel URL
   - 解决：重启后端

3. **网络问题**：手机网络不稳定
   - 解决：切换 WiFi/4G 重试

**排查命令**：
```bash
# 检查后端状态
cat ~/.mycc/current.json

# 检查 tunnel 是否存活
curl -s $(cat ~/.mycc/current.json | jq -r '.tunnelUrl')/health
```

---

### Q: 配对成功但发消息没反应

**可能原因**：

1. **Claude Code 未安装或未登录**
   - 检查：`claude --version`
   - 解决：安装 Claude Code 并登录

2. **API 额度用完**
   - 检查：Claude Code 终端是否有额度提示
   - 解决：等待额度恢复或升级计划

3. **cwd 路径问题**
   - 检查：后端启动时的工作目录是否正确
   - 解决：使用 `mycc start --cwd /your/project/path`

---

### Q: 连接频繁断开

**可能原因**：

1. **电脑休眠**：部分电脑休眠后 tunnel 会断
   - 解决：调整电脑休眠设置，或重启后端

2. **网络不稳定**
   - 解决：检查网络，重启后端

3. **后端进程被杀**
   - 解决：检查终端是否还在运行

4. **claude code 本身问题**
   - 解决：claude code 本身因为网络波动，可能失败，重发信息试试看

---

## Windows 特有问题

### Q: Windows 上 hooks 不生效（status.md 没被读取）

**报错特征**：发消息时没有注入时间戳和 status 内容

**原因**：hooks 配置使用了 Unix shell 语法，Windows 不兼容

**临时解决**：
这是已知问题，正在修复中。目前 Windows 用户 hooks 功能暂不可用，但不影响核心对话功能。

**跟踪进度**：等待内测群修复

### Q: Windows 上 部分指令 例如 curl 不可用，需要替换成自己使用的指令

---

## 其他问题

### Q: 如何查看连接码和配对码

```bash
cat ~/.mycc/current.json
```

输出示例：
```json
{
  "routeToken": "ABC123",     // 连接码
  "pairCode": "XYZ789",       // 配对码
  "tunnelUrl": "https://xxx.trycloudflare.com"
}
```

---

### Q: 如何完全重置配置

配置文件位置：`.claude/skills/mycc/current.json`

```bash
# 删除配置文件
rm -f .claude/skills/mycc/current.json

# 重新启动后端
/mycc
```

**Windows**：
```powershell
Remove-Item -Path ".claude\skills\mycc\current.json" -ErrorAction SilentlyContinue

# 重启
/mycc
```

---

### Q: 后端日志和配置在哪里

**配置文件**：`.claude/skills/mycc/current.json`

```bash
cat .claude/skills/mycc/current.json
```

**实时日志**：直接看终端输出

---

## 没找到你的问题？

1. **让 AI 自己排查**：把报错信息给 AI，让它分析
2. **查看项目 Issues**：https://github.com/anthropics/mycc/issues
3. **提新 Issue**：按第 0 条的格式提交，帮助完善 FAQ

---

*最后更新：2026-02-01*
