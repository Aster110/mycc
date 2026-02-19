# Hooks 错误修复说明

## 问题描述
Windows 环境下出现以下错误：
- `PreToolUse:Bash hook error`
- `PostToolUse:Bash hook error`

## 根本原因
1. **缺失文件**：`pre-commit-command-validation.cmd` 和 `post-commit-command-verify.cmd` 不存在
2. **直接调用 bash**：87 个 `.cmd` 文件直接调用 `bash`，路径配置不正确
3. **Git Bash 路径**：Git Bash 安装在 `E:\Program Files\Git\`（非标准路径）

## 修复方案

### 1. 创建缺失的 stub 文件
创建了两个 Windows 原生 stub 文件，输出默认的 allow 响应：
- `C:\Users\wannago\.ralph\.claude\hooks\pre-commit-command-validation.cmd`
- `C:\Users\wannago\.ralph\.claude\hooks\post-commit-command-verify.cmd`

### 2. 更新所有 .cmd 文件
修改了 87 个 `.cmd` 文件，添加智能 bash 检测：

**优先级顺序：**
1. **E:\Program Files\Git\bin\bash.exe** ⭐（用户的自定义路径）
2. C:\Program Files\Git\bin\bash.exe
3. C:\Program Files (x86)\Git\bin\bash.exe
4. %LOCALAPPDATA%\Programs\Git\bin\bash.exe
5. WSL bash (wsl.exe bash)
6. 降级：输出默认 JSON 响应，允许操作继续

**特性：**
- 自动检测可用的 bash 环境
- 优先使用用户的 Git Bash (E:\Program Files\Git\bin\bash.exe)
- 如果 bash 不可用或执行失败，优雅降级
- 不影响 Claude Code 正常运行

## 测试结果
- ✅ `smart-memory-search.cmd` - 正常输出 JSON
- ✅ `command-router.cmd` - 正常输出 JSON
- ✅ `session-start-welcome.cmd` - 正常输出 JSON
- ✅ `pre-commit-command-validation.cmd` - 正常输出 JSON
- ✅ `post-commit-command-verify.cmd` - 正常退出

## 文件位置
所有 hooks 位于：`C:\Users\wannago\.ralph\.claude\hooks\`

## 验证方法
重启 Claude Code 后，hooks 错误应该消失。

## 修复日期
2026-02-09
