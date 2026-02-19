#!/usr/bin/env python3
"""
Claude Code Token Usage Analyzer
扫描本地 Claude Code 日志，按 日期 × 模型 统计 token 消耗

用法：
    python3 cc-token-usage-analyzer.py              # 默认扫描所有项目
    python3 cc-token-usage-analyzer.py --days 7      # 只看最近 7 天
    python3 cc-token-usage-analyzer.py --project mylife  # 只看某个项目
    python3 cc-token-usage-analyzer.py --csv          # 输出 CSV 格式
    python3 cc-token-usage-analyzer.py --summary      # 只看按模型汇总

日志位置：~/.claude/projects/*/  下的 .jsonl 文件
每条 assistant 消息包含：message.model + message.usage
"""

import json
import os
import sys
import glob
import argparse
from collections import defaultdict
from datetime import datetime, timedelta, timezone

# 模型简称映射
MODEL_SHORT = {
    'claude-opus-4-6-20260205': 'opus-4.6',
    'claude-opus-4-5-20251101': 'opus-4.5',
    'claude-opus-4-1-20250501': 'opus-4.1',
    'claude-sonnet-4-5-20250929': 'sonnet-4.5',
    'claude-sonnet-4-20250514': 'sonnet-4',
    'claude-haiku-4-5-20251001': 'haiku-4.5',
}

# API 定价（每百万 tokens，USD）
PRICING = {
    'opus-4.6':   {'input': 15, 'output': 75, 'cache_create': 18.75, 'cache_read': 1.50},
    'opus-4.5':   {'input': 15, 'output': 75, 'cache_create': 18.75, 'cache_read': 1.50},
    'opus-4.1':   {'input': 15, 'output': 75, 'cache_create': 18.75, 'cache_read': 1.50},
    'sonnet-4.5': {'input': 3,  'output': 15, 'cache_create': 3.75,  'cache_read': 0.30},
    'sonnet-4':   {'input': 3,  'output': 15, 'cache_create': 3.75,  'cache_read': 0.30},
    'haiku-4.5':  {'input': 0.8,'output': 4,  'cache_create': 1.0,   'cache_read': 0.08},
}


def shorten_model(model_id):
    """模型 ID → 简称"""
    if model_id in MODEL_SHORT:
        return MODEL_SHORT[model_id]
    # 兜底：去掉 claude- 前缀和日期后缀
    name = model_id.replace('claude-', '')
    parts = name.rsplit('-', 1)
    if len(parts) == 2 and len(parts[1]) == 8 and parts[1].isdigit():
        return parts[0]
    return name


def calc_cost(model_short, usage):
    """计算 API 等价费用"""
    pricing = PRICING.get(model_short)
    if not pricing:
        return 0.0
    cost = (
        usage['input'] * pricing['input'] / 1_000_000 +
        usage['output'] * pricing['output'] / 1_000_000 +
        usage['cache_create'] * pricing['cache_create'] / 1_000_000 +
        usage['cache_read'] * pricing['cache_read'] / 1_000_000
    )
    return cost


def scan_sessions(projects_dir, project_filter=None, min_date=None):
    """扫描所有 session 日志，返回 {(date, model): usage_stats}"""
    # key: (date_str, model_short)
    # value: {input, output, cache_create, cache_read, count, sessions}
    stats = defaultdict(lambda: {
        'input': 0, 'output': 0,
        'cache_create': 0, 'cache_read': 0,
        'count': 0, 'sessions': set()
    })

    project_dirs = glob.glob(os.path.join(projects_dir, '*/'))
    total_files = 0
    scanned_files = 0
    errors = 0

    for proj_dir in sorted(project_dirs):
        proj_name = os.path.basename(proj_dir.rstrip('/'))

        # 项目过滤
        if project_filter and project_filter not in proj_name:
            continue

        jsonl_files = glob.glob(os.path.join(proj_dir, '*.jsonl'))
        total_files += len(jsonl_files)

        for fpath in jsonl_files:
            scanned_files += 1
            try:
                with open(fpath, 'r', encoding='utf-8') as f:
                    for line in f:
                        try:
                            d = json.loads(line.strip())
                            msg = d.get('message', {})
                            model_id = msg.get('model', '')
                            usage = msg.get('usage', {})
                            timestamp = d.get('timestamp', '')

                            if not model_id or not usage or not timestamp:
                                continue

                            # 解析日期（UTC → 本地时间）
                            try:
                                dt = datetime.fromisoformat(timestamp.replace('Z', '+00:00'))
                                dt_local = dt.astimezone()  # 自动使用系统本地时区
                                date_str = dt_local.strftime('%Y-%m-%d')
                            except:
                                continue

                            # 日期过滤
                            if min_date and date_str < min_date:
                                continue

                            model_short = shorten_model(model_id)
                            session_id = d.get('sessionId', os.path.basename(fpath))

                            key = (date_str, model_short)
                            stats[key]['input'] += usage.get('input_tokens', 0)
                            stats[key]['output'] += usage.get('output_tokens', 0)
                            stats[key]['cache_create'] += usage.get('cache_creation_input_tokens', 0)
                            stats[key]['cache_read'] += usage.get('cache_read_input_tokens', 0)
                            stats[key]['count'] += 1
                            stats[key]['sessions'].add(session_id)

                        except json.JSONDecodeError:
                            pass
            except Exception:
                errors += 1

    return stats, scanned_files, total_files, errors


def format_tokens(n):
    """格式化 token 数"""
    if n >= 1_000_000_000:
        return f'{n/1_000_000_000:.2f}B'
    if n >= 1_000_000:
        return f'{n/1_000_000:.1f}M'
    if n >= 1_000:
        return f'{n/1_000:.1f}K'
    return str(n)


def print_table(stats, show_csv=False):
    """按日期分组打印表格"""
    if not stats:
        print('No data found.')
        return

    # 按日期 + 模型排序
    dates = sorted(set(k[0] for k in stats.keys()))
    models = sorted(set(k[1] for k in stats.keys()))

    if show_csv:
        print('date,model,input,output,cache_create,cache_read,total_tokens,cost_usd,messages,sessions')
        for date in dates:
            for model in models:
                key = (date, model)
                if key not in stats:
                    continue
                s = stats[key]
                total = s['input'] + s['output'] + s['cache_create'] + s['cache_read']
                cost = calc_cost(model, s)
                print(f'{date},{model},{s["input"]},{s["output"]},{s["cache_create"]},{s["cache_read"]},{total},{cost:.2f},{s["count"]},{len(s["sessions"])}')
        return

    # 表头
    header = f'{"Date":<12} {"Model":<14} {"Input":>10} {"Output":>10} {"C.Create":>10} {"C.Read":>10} {"Total":>10} {"Cost":>10} {"Msgs":>6}'
    sep = '-' * len(header)

    print(f'\n{"="*len(header)}')
    print(f'  Claude Code Token Usage - Per Model Per Day')
    print(f'{"="*len(header)}')
    print(header)
    print(sep)

    grand_total = {'input': 0, 'output': 0, 'cache_create': 0, 'cache_read': 0, 'count': 0}
    grand_cost = 0.0

    for date in dates:
        day_total = 0
        day_cost = 0.0
        day_rows = []

        for model in models:
            key = (date, model)
            if key not in stats:
                continue
            s = stats[key]
            total = s['input'] + s['output'] + s['cache_create'] + s['cache_read']
            cost = calc_cost(model, s)

            day_rows.append(
                f'{date:<12} {model:<14} {format_tokens(s["input"]):>10} {format_tokens(s["output"]):>10} '
                f'{format_tokens(s["cache_create"]):>10} {format_tokens(s["cache_read"]):>10} '
                f'{format_tokens(total):>10} {"$"+f"{cost:.2f}":>10} {s["count"]:>6}'
            )

            day_total += total
            day_cost += cost

            for k in ['input', 'output', 'cache_create', 'cache_read', 'count']:
                grand_total[k] += s[k]
            grand_cost += cost

        for row in day_rows:
            print(row)

        # 日小计
        if len(day_rows) > 1:
            print(f'{"":.<12} {"[day total]":<14} {"":>10} {"":>10} {"":>10} {"":>10} {format_tokens(day_total):>10} {"$"+f"{day_cost:.2f}":>10}')

        print(sep)

    # 总计
    g_total = grand_total['input'] + grand_total['output'] + grand_total['cache_create'] + grand_total['cache_read']
    print(f'{"TOTAL":<12} {"ALL":<14} {format_tokens(grand_total["input"]):>10} {format_tokens(grand_total["output"]):>10} '
          f'{format_tokens(grand_total["cache_create"]):>10} {format_tokens(grand_total["cache_read"]):>10} '
          f'{format_tokens(g_total):>10} {"$"+f"{grand_cost:.2f}":>10} {grand_total["count"]:>6}')
    print(f'{"="*len(header)}\n')


def print_summary(stats):
    """按模型汇总"""
    model_totals = defaultdict(lambda: {'input': 0, 'output': 0, 'cache_create': 0, 'cache_read': 0, 'count': 0, 'days': set()})

    for (date, model), s in stats.items():
        for k in ['input', 'output', 'cache_create', 'cache_read', 'count']:
            model_totals[model][k] += s[k]
        model_totals[model]['days'].add(date)

    print(f'\n{"="*80}')
    print(f'  Model Summary (all time)')
    print(f'{"="*80}')
    print(f'{"Model":<14} {"Input":>10} {"Output":>10} {"C.Create":>10} {"C.Read":>10} {"Total":>10} {"Cost":>10} {"Days":>6}')
    print('-' * 80)

    total_cost = 0.0
    total_tokens = 0

    for model in sorted(model_totals.keys()):
        s = model_totals[model]
        total = s['input'] + s['output'] + s['cache_create'] + s['cache_read']
        cost = calc_cost(model, s)
        total_cost += cost
        total_tokens += total

        print(f'{model:<14} {format_tokens(s["input"]):>10} {format_tokens(s["output"]):>10} '
              f'{format_tokens(s["cache_create"]):>10} {format_tokens(s["cache_read"]):>10} '
              f'{format_tokens(total):>10} {"$"+f"{cost:.2f}":>10} {len(s["days"]):>6}')

    print('-' * 80)
    print(f'{"TOTAL":<14} {"":>10} {"":>10} {"":>10} {"":>10} {format_tokens(total_tokens):>10} {"$"+f"{total_cost:.2f}":>10}')
    print(f'{"="*80}\n')


def main():
    parser = argparse.ArgumentParser(description='Claude Code Token Usage Analyzer')
    parser.add_argument('--days', type=int, help='只看最近 N 天')
    parser.add_argument('--project', type=str, help='只看包含此关键词的项目')
    parser.add_argument('--csv', action='store_true', help='输出 CSV 格式')
    parser.add_argument('--summary', action='store_true', help='按模型汇总')
    parser.add_argument('--dir', type=str, default=os.path.expanduser('~/.claude/projects'),
                        help='Claude Code 项目目录路径')
    args = parser.parse_args()

    min_date = None
    if args.days:
        min_date = (datetime.now() - timedelta(days=args.days)).strftime('%Y-%m-%d')

    print(f'Scanning {args.dir} ...')
    stats, scanned, total, errors = scan_sessions(args.dir, args.project, min_date)
    print(f'Scanned {scanned}/{total} files, {len(stats)} date×model combos, {errors} errors\n')

    if args.summary:
        print_summary(stats)
    else:
        print_table(stats, show_csv=args.csv)

    if not args.csv:
        print_summary(stats)


if __name__ == '__main__':
    main()
