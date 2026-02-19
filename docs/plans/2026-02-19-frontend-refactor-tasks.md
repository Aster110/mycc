# 前端重构任务书（给 Codex）

> 基于 `docs/plans/chat-page-design.html` 设计原型，分 6 个 Phase 实施。

## 设计要点

- **左侧边栏**（272px）：纯对话管理 — 搜索 + 按日期分组的会话列表
- **中间对话区**（弹性）：消息流 + 快捷指令栏 + 输入框
- **右侧工具箱**（320px，可折叠）：双 Tab 面板
  - ⚡ 技能：技能卡片列表（图标 + 名称 + 触发词 + 描述 + 状态）
  - ⏰ 自动化：任务卡片（名称 + cron 描述 + 状态指示灯 + 开关）
- **设置弹窗**：个人信息 + 对话偏好 + 外观主题
- **暗色/亮色主题**：CSS 变量系统
- **移动端**：768px 以下侧边栏变 overlay，1024px 以下右侧面板变 overlay

## Phase 1: 三栏布局骨架

**文件**：
- 新建 `mycc-web-react/src/components/layout/Sidebar.tsx`
- 新建 `mycc-web-react/src/components/layout/RightPanel.tsx`
- 修改 `mycc-web-react/src/components/ChatPage.tsx`
- 新建 `mycc-web-react/src/styles/theme.css`（CSS 变量）

**要求**：
- ChatPage 从单栏改为 `display: flex` 三栏布局
- 左侧 272px 固定宽度，中间弹性，右侧 320px 可折叠
- CSS 变量主题系统（参考原型的 `[data-theme="dark"]` / `[data-theme="light"]`）
- 右侧面板的展开/折叠按钮（header 区域）

## Phase 2: 右侧工具箱面板

**文件**：
- 新建 `mycc-web-react/src/components/panel/SkillList.tsx`
- 新建 `mycc-web-react/src/components/panel/AutomationList.tsx`
- 新建 `mycc-web-react/src/components/panel/PanelTabs.tsx`

**要求**：
- Tab 切换（⚡ 技能 / ⏰ 自动化）
- 技能卡片：图标 + 名称 + 触发词 + 描述 + 已安装/可安装徽章
- 自动化卡片：名称 + cron 可读描述 + 状态指示灯（绿/灰/红） + 开关
- "新建自动化任务"按钮
- 后端 API 由 cc 提供（`/api/skills`、`/api/automations`），前端先用 mock 数据

## Phase 3: 侧边栏对话管理

**文件**：
- 重构 `mycc-web-react/src/components/HistoryView.tsx` → 嵌入 Sidebar
- 修改 `mycc-web-react/src/components/layout/Sidebar.tsx`

**要求**：
- 顶部品牌标识（cc logo + MyCC + 副标题）
- "新对话"按钮（accent 色）
- 搜索输入框
- 会话列表按日期分组（今天 / 昨天 / 更早）
- 当前会话高亮（accent-subtle 背景 + accent 边框）
- 底部用户信息栏（头像 + 昵称 + 主题切换 + 设置按钮）

## Phase 4: 消息样式适配

**文件**：
- 修改 `mycc-web-react/src/components/MessageComponents.tsx`
- 修改 `mycc-web-react/src/components/messages/CollapsibleDetails.tsx`

**要求**：
- Tool call 消息：compact pill 样式（圆角药丸，图标 + 文字 + 结果摘要）
- Thinking 消息：默认折叠，虚线边框，点击展开
- Error 消息：红色卡片，标签"系统错误"，默认展开
- 用户消息气泡靠右，助手消息靠左，带头像

## Phase 5: 设置弹窗增强

**文件**：
- 修改 `mycc-web-react/src/components/SettingsModal.tsx`
- 修改 `mycc-web-react/src/components/settings/GeneralSettings.tsx`

**要求**：
- 个人信息区：昵称编辑 + 头像
- 对话区：发送方式选择 + 显示工具调用开关 + 自动展开思考开关
- 外观区：主题切换（深色/浅色） + 字号选择
- 关于区：版本号

## Phase 6: 移动端响应式

**要求**：
- `@media (max-width: 768px)`：侧边栏变抽屉式 overlay + 遮罩
- `@media (max-width: 1024px)`：右侧面板变 overlay
- 手机端 header 显示菜单按钮（汉堡图标）
- 触摸友好的按钮尺寸

## 注意事项

- 每个 Phase 单独一个 PR，基于 `feature/multi-user-frontend` 分支
- 设计参考：`docs/plans/chat-page-design.html`（可本地 HTTP 服务打开预览）
- Phase 2 的后端 API 会由 cc 先实现，前端可先用 mock 数据开发
- Tailwind CSS 可选，也可用 CSS Modules，保持和现有代码风格一致
