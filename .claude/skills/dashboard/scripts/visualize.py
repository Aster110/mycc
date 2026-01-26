#!/usr/bin/env python3
"""
cc 能力看板可视化
中国风 + Mac 风格
"""

import re
import os
import webbrowser
import tempfile
from pathlib import Path
from datetime import datetime

# 路径配置 - 使用环境变量或相对路径
BASE_DIR = Path(os.environ.get("CC_PROJECT_DIR", Path(__file__).parent.parent.parent.parent))
DASHBOARD_PATH = BASE_DIR / ".claude/DASHBOARD.md"


def parse_dashboard():
    """解析 DASHBOARD.md 内容"""
    if not DASHBOARD_PATH.exists():
        print(f"警告: DASHBOARD.md 不存在: {DASHBOARD_PATH}")
        return {
            "skills": [],
            "developing": [],
            "planned": [],
            "knowledge": [],
            "materials": [],
            "archived": [],
            "last_updated": datetime.now().strftime("%Y-%m-%d %H:%M"),
        }

    content = DASHBOARD_PATH.read_text(encoding="utf-8")

    data = {
        "skills": [],
        "developing": [],
        "planned": [],
        "knowledge": [],
        "materials": [],
        "archived": [],
        "last_updated": datetime.now().strftime("%Y-%m-%d %H:%M"),
    }

    # 解析已实装技能
    skill_pattern = r'\| `([^`]+)` \| ([^|]+) \| ([^|]+) \| ([^|]+) \| ([^|]+) \|'
    for match in re.finditer(skill_pattern, content):
        data["skills"].append({
            "name": match.group(1).strip(),
            "desc": match.group(2).strip(),
            "version": match.group(3).strip(),
            "date": match.group(4).strip(),
            "status": match.group(5).strip(),
        })

    # 解析开发中
    dev_section = re.search(r'## 开发中\n\n(.*?)(?=\n---|\n## )', content, re.DOTALL)
    if dev_section:
        dev_pattern = r'\| ([^|]+) \| (\d+)% \| ([^|]+) \| `([^`]+)` \|'
        for match in re.finditer(dev_pattern, dev_section.group(1)):
            data["developing"].append({
                "name": match.group(1).strip(),
                "progress": int(match.group(2)),
                "next": match.group(3).strip(),
                "doc": match.group(4).strip(),
            })

    # 解析规划中
    plan_section = re.search(r'## 规划中.*?\n\n(.*?)(?=\n---|\n## )', content, re.DOTALL)
    if plan_section:
        plan_pattern = r'\| ([^|]+) \| ([^|]+) \| ([^|]+) \| `([^`]+)` \|'
        for match in re.finditer(plan_pattern, plan_section.group(1)):
            name = match.group(1).strip()
            if name and not name.startswith('--'):
                data["planned"].append({
                    "name": name,
                    "desc": match.group(2).strip(),
                    "priority": match.group(3).strip(),
                    "source": match.group(4).strip(),
                })

    return data


def generate_html(data):
    """生成 HTML 页面 - 中国风 + Mac 风格"""

    # 技能卡片
    skills_html = ""
    for skill in data["skills"]:
        skills_html += f'''
        <div class="skill-card">
            <div class="skill-name">{skill["name"]}</div>
            <div class="skill-desc">{skill["desc"]}</div>
            <div class="skill-meta">
                <span class="skill-version">{skill["version"]}</span>
                <span class="skill-date">{skill["date"]}</span>
            </div>
        </div>
        '''

    # 开发中卡片
    developing_html = ""
    for dev in data["developing"]:
        developing_html += f'''
        <div class="dev-card">
            <div class="dev-name">{dev["name"]}</div>
            <div class="progress-container">
                <div class="progress-bar">
                    <div class="progress-fill" style="width: {dev["progress"]}%"></div>
                </div>
                <span class="progress-text">{dev["progress"]}%</span>
            </div>
            <div class="dev-next">{dev["next"]}</div>
        </div>
        '''

    # 规划中列表
    planned_html = ""
    for plan in data["planned"]:
        priority_class = "high" if plan["priority"] == "高" else "mid" if plan["priority"] == "中" else "low"
        planned_html += f'''
        <div class="plan-item">
            <span class="plan-name">{plan["name"]}</span>
            <span class="priority {priority_class}">{plan["priority"]}</span>
        </div>
        '''

    html = f'''<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>cc 能力看板</title>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@400;600;700&display=swap');

        * {{
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }}

        body {{
            font-family: -apple-system, BlinkMacSystemFont, "Noto Serif SC", "PingFang SC", serif;
            background: linear-gradient(180deg, #f5f2eb 0%, #e8e4db 100%);
            min-height: 100vh;
            color: #2c2c2c;
            padding: 3rem 2rem;
        }}

        .container {{
            max-width: 1200px;
            margin: 0 auto;
        }}

        header {{
            text-align: center;
            margin-bottom: 4rem;
        }}

        .title {{
            font-size: 2.8rem;
            font-weight: 700;
            color: #1a1a1a;
            letter-spacing: 0.15em;
            margin-bottom: 0.5rem;
        }}

        .title::before {{ content: "「"; color: #c45c48; }}
        .title::after {{ content: "」"; color: #c45c48; }}

        .subtitle {{
            font-size: 0.95rem;
            color: #666;
            letter-spacing: 0.1em;
        }}

        .stats {{
            display: flex;
            justify-content: center;
            gap: 4rem;
            margin: 3rem 0;
        }}

        .stat {{ text-align: center; }}
        .stat-value {{
            font-size: 3.5rem;
            font-weight: 700;
            color: #1a1a1a;
            line-height: 1;
        }}
        .stat-label {{
            font-size: 0.85rem;
            color: #888;
            margin-top: 0.5rem;
            letter-spacing: 0.1em;
        }}
        .stat:nth-child(1) .stat-value {{ color: #c45c48; }}
        .stat:nth-child(2) .stat-value {{ color: #d4a853; }}
        .stat:nth-child(3) .stat-value {{ color: #5a8a6e; }}

        .section-title {{
            font-size: 1.3rem;
            font-weight: 600;
            color: #1a1a1a;
            margin-bottom: 1.5rem;
            padding-bottom: 0.5rem;
            border-bottom: 2px solid #c45c48;
            display: inline-block;
            letter-spacing: 0.08em;
        }}

        section {{ margin-bottom: 3rem; }}

        .skills-grid {{
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
            gap: 1rem;
        }}

        .skill-card {{
            background: rgba(255, 255, 255, 0.7);
            backdrop-filter: blur(10px);
            border: 1px solid rgba(255, 255, 255, 0.8);
            border-radius: 16px;
            padding: 1.25rem;
            transition: all 0.3s ease;
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.05);
        }}

        .skill-card:hover {{
            transform: translateY(-4px);
            box-shadow: 0 8px 30px rgba(0, 0, 0, 0.1);
        }}

        .skill-name {{
            font-size: 1.1rem;
            font-weight: 600;
            color: #1a1a1a;
            margin-bottom: 0.5rem;
        }}

        .skill-desc {{
            font-size: 0.85rem;
            color: #666;
            margin-bottom: 0.75rem;
            line-height: 1.5;
        }}

        .skill-meta {{
            display: flex;
            justify-content: space-between;
            font-size: 0.75rem;
            color: #999;
        }}

        .skill-version {{ color: #c45c48; }}

        .dev-grid {{
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
            gap: 1rem;
        }}

        .dev-card {{
            background: rgba(255, 255, 255, 0.7);
            backdrop-filter: blur(10px);
            border: 1px solid rgba(212, 168, 83, 0.3);
            border-radius: 16px;
            padding: 1.25rem;
        }}

        .dev-name {{
            font-size: 1rem;
            font-weight: 600;
            color: #1a1a1a;
            margin-bottom: 0.75rem;
        }}

        .progress-container {{
            display: flex;
            align-items: center;
            gap: 0.75rem;
            margin-bottom: 0.75rem;
        }}

        .progress-bar {{
            flex: 1;
            height: 6px;
            background: #e5e5e5;
            border-radius: 3px;
            overflow: hidden;
        }}

        .progress-fill {{
            height: 100%;
            background: linear-gradient(90deg, #d4a853, #c45c48);
            border-radius: 3px;
        }}

        .progress-text {{
            font-size: 0.85rem;
            color: #d4a853;
            font-weight: 600;
        }}

        .dev-next {{
            font-size: 0.85rem;
            color: #888;
        }}

        .plan-list {{
            background: rgba(255, 255, 255, 0.7);
            backdrop-filter: blur(10px);
            border-radius: 16px;
            padding: 1rem;
        }}

        .plan-item {{
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 0.75rem 0.5rem;
            border-bottom: 1px solid rgba(0, 0, 0, 0.05);
        }}

        .plan-item:last-child {{ border-bottom: none; }}
        .plan-name {{ font-size: 0.95rem; color: #333; }}

        .priority {{
            font-size: 0.75rem;
            padding: 0.2rem 0.6rem;
            border-radius: 4px;
        }}

        .priority.high {{ background: rgba(196, 92, 72, 0.15); color: #c45c48; }}
        .priority.mid {{ background: rgba(212, 168, 83, 0.15); color: #b8922f; }}
        .priority.low {{ background: rgba(90, 138, 110, 0.15); color: #5a8a6e; }}

        footer {{
            text-align: center;
            margin-top: 3rem;
            padding-top: 2rem;
            border-top: 1px solid rgba(0, 0, 0, 0.08);
            color: #999;
            font-size: 0.85rem;
        }}

        .seal {{
            display: inline-block;
            border: 2px solid #c45c48;
            color: #c45c48;
            padding: 0.3rem 0.8rem;
            font-size: 0.8rem;
            letter-spacing: 0.1em;
            margin-top: 0.5rem;
        }}
    </style>
</head>
<body>
    <div class="container">
        <header>
            <h1 class="title">cc 能力看板</h1>
            <p class="subtitle">技能 · 知识 · 能力演进</p>

            <div class="stats">
                <div class="stat">
                    <div class="stat-value">{len(data["skills"])}</div>
                    <div class="stat-label">已实装</div>
                </div>
                <div class="stat">
                    <div class="stat-value">{len(data["developing"])}</div>
                    <div class="stat-label">开发中</div>
                </div>
                <div class="stat">
                    <div class="stat-value">{len(data["planned"])}</div>
                    <div class="stat-label">规划中</div>
                </div>
            </div>
        </header>

        <section>
            <h2 class="section-title">已实装技能</h2>
            <div class="skills-grid">
                {skills_html if skills_html else '<p style="color: #999;">暂无技能</p>'}
            </div>
        </section>

        <section>
            <h2 class="section-title">开发中</h2>
            <div class="dev-grid">
                {developing_html if developing_html else '<p style="color: #999;">暂无</p>'}
            </div>
        </section>

        <section>
            <h2 class="section-title">规划中</h2>
            <div class="plan-list">
                {planned_html if planned_html else '<p style="color: #999; padding: 1rem;">暂无</p>'}
            </div>
        </section>

        <footer>
            <p>{data["last_updated"]}</p>
            <div class="seal">cc</div>
        </footer>
    </div>
</body>
</html>
'''
    return html


def main():
    # 解析数据
    data = parse_dashboard()

    # 生成 HTML
    html = generate_html(data)

    # 写入临时文件并打开
    output_path = Path(tempfile.gettempdir()) / "cc_dashboard.html"
    output_path.write_text(html, encoding="utf-8")

    print(f"✅ 看板已生成: {output_path}")
    webbrowser.open(f"file://{output_path}")
    print("✅ 已在浏览器打开")


if __name__ == "__main__":
    main()
