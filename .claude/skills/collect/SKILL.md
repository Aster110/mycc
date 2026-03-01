---
name: collect
description: 每日信息采集。多源并行采集 → AI 分析 → 飞书简报。触发词："/collect"、"每日采集"、"早报"
layer: 分析层
authorization: A区（自动执行，无需人类介入）
output_levels: L1（结论）
---

# 每日信息采集

三层流水线：纯脚本采集 → 多 Agent 并行分析 → 主编综合 → 统一通知。

## 触发词

- "/collect"
- "每日采集"
- "早报"

## 执行流程

### Step 1：运行采集脚本

```bash
PROJECT_ROOT="$(git rev-parse --show-toplevel)"
TODAY=$(date +%Y-%m-%d)
SAVE_DIR="$PROJECT_ROOT/1-Inbox/_collect/$TODAY"
node "$PROJECT_ROOT/.claude/skills/collect/scripts/collect.mjs" --save "$SAVE_DIR"
```

脚本会并行运行所有 collector，输出合并的 JSON 到 stdout，同时把各源原始 JSON 保存到 `$SAVE_DIR`。

### Step 2：检查采集状态

逐个检查 `sources` 数组中每个源的 `metadata.error`：

- **`token_expired`**（fxb）→ 发飞书红卡通知：
  ```bash
  node "$PROJECT_ROOT/.claude/skills/tell-me/send.js" "风向标 Token 过期" "API 返回 success: false，请刷新 token。\n操作：跟 cc 说「刷新生财 token」即可自动完成" "red"
  ```
- **`token_expiring_soon`**（fxb，warning 字段）→ 发飞书黄卡预警：
  ```bash
  node "$PROJECT_ROOT/.claude/skills/tell-me/send.js" "风向标 Token 即将过期" "剩余 {daysLeft} 天，{expireDate} 到期。\n操作：跟 cc 说「刷新生财 token」即可自动完成" "yellow"
  ```
  注意：warning 不阻断采集流程，数据正常返回，只是额外发一条预警。
- **其他错误** → 记录在简报中，不阻断流程
- **全部失败** → 发错误通知，终止

### Step 3：并行分析（8 个 Agent 各跑各的）

用 **Task 工具**同时派遣 8 个 subagent，**在同一条消息里发出 8 个 Task 调用**实现并行。每个 agent 独立分析一个源，写出自己的报告。

#### Agent 配置

| Agent | model | 读取数据 | 分析标准 | 输出报告 |
|-------|-------|---------|---------|---------|
| fxb-analyst | sonnet | `$SAVE_DIR/fxb.json` | `analysis/fxb-analyst.md` | `$SAVE_DIR/fxb-analysis.md` |
| github-analyst | sonnet | `$SAVE_DIR/gh-trending.json` | `analysis/github-analyst.md` | `$SAVE_DIR/github-analysis.md` |
| tech-analyst | sonnet | `$SAVE_DIR/tech-news.json` | `analysis/tech-analyst.md` | `$SAVE_DIR/tech-analysis.md` |
| trends-analyst | sonnet | `$SAVE_DIR/trends.json` | `analysis/trends-analyst.md` | `$SAVE_DIR/trends-analysis.md` |
| xhs-analyst | sonnet | `$SAVE_DIR/xhs.json` | `analysis/xhs-analyst.md` | `$SAVE_DIR/xhs-analysis.md` |
| rss-ai-analyst | sonnet | `$SAVE_DIR/rss-ai.json` | `analysis/rss-ai-analyst.md` | `$SAVE_DIR/rss-ai-analysis.md` |
| rss-dev-analyst | sonnet | `$SAVE_DIR/rss-dev.json` | `analysis/rss-dev-analyst.md` | `$SAVE_DIR/rss-dev-analysis.md` |
| rss-startup-analyst | sonnet | `$SAVE_DIR/rss-startup.json` | `analysis/rss-startup-analyst.md` | `$SAVE_DIR/rss-startup-analysis.md` |

#### 每个 Agent 的 prompt 模板

```
你是 {源名} 分析师。请完成以下任务：

1. 读取分析标准：$PROJECT_ROOT/.claude/skills/collect/analysis/{source}-analyst.md
2. 读取原始数据：{$SAVE_DIR}/{source}.json
3. 按分析标准筛选和分析数据
4. 将分析报告写入：{$SAVE_DIR}/{source}-analysis.md

注意：
- 严格按 analyst.md 中的"报告输出格式"段写报告
- 报告要能独立阅读（包含日期、数据量等上下文）
- 如果数据为空或采集失败，写一份简短说明即可
```

对 **fxb** agent，额外提示：数据已过滤为昨天的帖子（~10-20 条），直接全量分析，不需要挑选。

#### 错误处理

- 某个 agent 失败 → 主窗口记录错误，跳过该源，其他源正常
- fxb 的 `metadata.error` 为 `token_expired` → 该 agent 不派遣（Step 2 已发预警）

### Step 4：主编综合

等所有 agent 完成后，主窗口执行综合分析：

1. 读取 `analysis/cross-source-rules.md`（跨源分析方法论）
2. 读取 `analysis/synthesizer.md`（主编职责和输出格式）
3. 读取前一天的 briefing（用于信号连续性判断）：
   - 计算昨天日期，读取 `1-Inbox/_collect/{昨天}/briefing.md`
   - 不存在则跳过，全部信号标为新信号
4. 依次读取 8 份独立报告：
   - `$SAVE_DIR/fxb-analysis.md`
   - `$SAVE_DIR/github-analysis.md`
   - `$SAVE_DIR/tech-analysis.md`
   - `$SAVE_DIR/trends-analysis.md`
   - `$SAVE_DIR/xhs-analysis.md`
   - `$SAVE_DIR/rss-ai-analysis.md`
   - `$SAVE_DIR/rss-dev-analysis.md`
   - `$SAVE_DIR/rss-startup-analysis.md`
5. 按 cross-source-rules.md 五步法分析：实体提取 → 关联矩阵 → 信号连续性 → 行动分级 → 选题提取
6. 按 synthesizer.md 格式输出最终简报（开头必须有"30 秒速读"）

每个源的分析标准独立维护在 `analysis/*.md`：

| 分析师 | 文件 | 对应源 |
|--------|------|--------|
| 风向标分析师 | `analysis/fxb-analyst.md` | fxb |
| GitHub 分析师 | `analysis/github-analyst.md` | gh-trending |
| 技术社区分析师 | `analysis/tech-analyst.md` | tech-news |
| 国内热点分析师 | `analysis/trends-analyst.md` | trends |
| 小红书分析师 | `analysis/xhs-analyst.md` | xhs |
| AI 前沿 RSS 分析师 | `analysis/rss-ai-analyst.md` | rss-ai |
| 开发者工具 RSS 分析师 | `analysis/rss-dev-analyst.md` | rss-dev |
| 创业商业 RSS 分析师 | `analysis/rss-startup-analyst.md` | rss-startup |
| 综合分析师（主编） | `analysis/synthesizer.md` | 跨源汇总 |

aster 可以单独调整某个源的分析标准，不影响其他源。

### Step 5：保存简报

将分析结果写入 `1-Inbox/_collect/{YYYY-MM-DD}/briefing.md`：

```markdown
# 每日简报 | {YYYY-MM-DD}

## 概览
- 风向标：{X} 条（筛选后 {Y} 条命中，精选 {Z} 条）
- GitHub Trending：{X} 个项目（AI 相关 {Y} 个）
- 多平台热点：{X} 条

## 风向标 Top N

### 1. {一句话总结}
- **作者**：xxx | **互动**：👍{likes} 💬{comments}
- **核心观点**：...
- **启发**：...

### 2. ...

## GitHub Trending 精选

### {author/name} — {一句话定位}
- **语言**：{lang} | **今日**：+{todayStars}
- **核心价值**：...
- **启发**：...

## 热点速览

| 平台 | 热点 |
|------|------|
| 微博 | {top1} |
| 知乎 | {top1} |
| ... | ... |

## 趋势洞察
1. ...
2. ...
```

### Step 6：飞书通知

将 briefing.md 完整内容推送到飞书（`--file` 模式读取文件）：

```bash
node "$PROJECT_ROOT/.claude/skills/tell-me/send.js" \
  "每日简报 | {YYYY-MM-DD}" \
  --file "$SAVE_DIR/briefing.md" \
  blue
```

推送成功后打个标记，方便追溯"这天推过飞书了"：

```bash
touch "$SAVE_DIR/feishu-sent.flag"
```

## 可选参数

只运行部分 collector：
```bash
node "$PROJECT_ROOT/.claude/skills/collect/scripts/collect.mjs" --sources fxb,gh-trending
```

## 加新源

1. 复制 `collectors/_template.mjs`，改名为 `{source}.mjs`
2. 实现采集逻辑 + `formatExtract` 函数（`--extract` 模式）
3. 如果数据量大（>20 条或含长文），加 `--index` 模式
4. 完成。协调器自动发现，小源无需改 SKILL.md

## Collector 自治标准

每个 collector 是自治单元，包含三种模式：

| 模式 | 必须？ | 说明 |
|------|--------|------|
| 采集（默认） | 必须 | 拉数据，输出 JSON |
| `--extract <json> <idx,...\|all>` | 必须 | 按序号提取（或 `all` 全部），输出 markdown |
| `--index <json>` | 可选 | 数据量大时生成紧凑索引 |

公共函数在 `lib/fetcher.mjs`：`extractItems(jsonPath, indices, formatFn, name)` 处理读 JSON + 遍历序号 + 边界检查。各 collector 只需提供自己的 `formatExtract` 函数。

## 文件结构

```
.claude/skills/collect/
├── SKILL.md
├── analysis/                        # 各源分析师 prompt（独立可调）
│   ├── fxb-analyst.md
│   ├── github-analyst.md
│   ├── tech-analyst.md
│   ├── trends-analyst.md
│   ├── xhs-analyst.md
│   ├── rss-ai-analyst.md           # AI 前沿 RSS 分析师
│   ├── rss-dev-analyst.md          # 开发者工具 RSS 分析师
│   ├── rss-startup-analyst.md      # 创业商业 RSS 分析师
│   └── synthesizer.md               # 综合分析师（跨源汇总）
└── scripts/
    ├── collect.mjs                  # 协调器
    ├── collectors/
    │   ├── fxb.mjs                  # 风向标（只采昨天）+ --index + --extract
    │   ├── gh-trending.mjs          # GitHub Trending + --extract
    │   ├── tech-news.mjs            # 海外技术社区（HN/PH/V2EX）+ --extract
    │   ├── trends.mjs               # 国内热点（微博/知乎/抖音）+ --extract
    │   ├── xhs.mjs                  # 小红书热点 + --extract
    │   ├── rss-ai.mjs              # AI 前沿 RSS + --extract + --index
    │   ├── rss-dev.mjs             # 开发者工具 RSS + --extract
    │   ├── rss-startup.mjs         # 创业商业 RSS + --extract + --index
    │   └── _template.mjs            # 新源模板
    └── lib/
        ├── fetcher.mjs              # 共享工具（HTTP + extractItems）
        └── rss-parser.mjs           # RSS/Atom 解析（fetchFeed + fetchFeeds）
```
