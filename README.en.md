> **AI Tip: The easiest setup is to let AI read through the README and CLAUDE.md, then guide you step by step.**

<div align="center">

English | [简体中文](./README.md)

<img src="https://raw.githubusercontent.com/Aster110/mycc/main/img/logo-bear.png" alt="MyCC Logo" width="200">

[![License](https://img.shields.io/badge/License-MIT-green)](LICENSE)
![Status](https://img.shields.io/badge/Status-Ready-brightgreen)
![Claude Code](https://img.shields.io/badge/Claude_Code-Template-blueviolet)

**Make Claude Code Your Partner**

</div>

> Ready-to-use Claude Code system template | Best practices for CC users

## What is this?

Have you encountered these problems?
- **CC "forgets" everything** each new session, requiring repeated context
- **Don't know how to write CLAUDE.md**, online examples are too simple
- **CC is too "polite"**, acts like customer service instead of a partner

MyCC solves these problems. It's a **Claude Code system template** that enables CC to:
- 🧠 Automatically remember your status (via Hooks)
- 🎭 Have its own "personality" (via CLAUDE.md)
- 🔧 Extend with new capabilities (via Skills)

## Prerequisites

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed
- Anthropic API Key or Claude Pro subscription

## Quick Start (30 seconds)

```bash
# 1. Clone
git clone https://github.com/Aster110/mycc.git
cd mycc

# 2. Start Claude Code
claude

# 3. Type /setup and follow the interactive guide
```

CC will guide you through the initialization step by step.

<details>
<summary>Manual Configuration (Optional)</summary>

```bash
# Copy config files
cp .claude/settings.local.json.example .claude/settings.local.json
cp 0-System/status.md.example 0-System/status.md
cp 0-System/context.md.example 0-System/context.md

# Replace {{YOUR_NAME}} with your name
sed -i '' 's/{{YOUR_NAME}}/YourName/g' CLAUDE.md
```

</details>

## Directory Structure

```
mycc/
├── CLAUDE.md                  # CC's "personality" and "rules" (core)
├── .claude/
│   ├── settings.local.json    # Hooks configuration
│   ├── DASHBOARD.md           # Capability dashboard
│   └── skills/                # Skill library
├── 0-System/                  # Memory system
│   ├── status.md              # Short-term memory (daily status)
│   ├── context.md             # Mid-term memory (weekly context)
│   └── about-me/              # Long-term memory (your profile)
├── 1-Inbox/                   # Ideas collection
├── 2-Projects/                # Active projects
├── 3-Thinking/                # Cognitive insights
├── 4-Assets/                  # Reusable assets
├── 5-Archive/                 # Archive
└── tasks/                     # Cross-session task tracking
```

## Core Concepts

### CLAUDE.md - CC's Personality

Defines CC's working style:
- Direct and concise, no fluff
- Partner mindset, not customer service
- Pragmatic, ship first then iterate

Customize it to your preference.

### Memory System - Three Layers

| Layer | File | Purpose |
|-------|------|---------|
| Short-term | `status.md` | Daily status, auto-injected via Hooks |
| Mid-term | `context.md` | Weekly context, appended daily |
| Long-term | `about-me/` | Your complete profile |

### Skills - Extensible Capabilities

Built-in skills:

| Skill | Function | Trigger |
|-------|----------|---------|
| `/setup` | First-time setup guide | Type directly |
| `/dashboard` | View capability dashboard | Type directly |
| `/skill-creator` | Create new skills | Type directly |

Add new Skills: `.claude/skills/skill-name/SKILL.md`

## 📱 Mobile Access (Beta)

**Use your CC on mobile!**

With `mycc-backend`, you can access your local Claude Code from mobile browser or WeChat.

### Web Version (Live)

Visit [mycc.dev](https://mycc.dev), enter the connection code and pairing code.

<div align="center">
<img src="https://raw.githubusercontent.com/Aster110/mycc/main/img/screenshot-pair.png" alt="Pairing Page" width="300">
</div>

### WeChat Mini Program (Coming Soon)

Stay tuned.

### Backend Setup

```bash
# 1. Install dependencies (first time)
cd .claude/skills/mycc/scripts && npm install && cd -

# 2. Start (in project root directory)
/mycc

# 3. Scan QR code or visit the displayed URL
```

**Platform Support**:
- ✅ macOS
- ✅ Linux
- ❌ Windows (not supported yet, use WSL)

> Windows users: You can ask AI to help adapt the code in `.claude/skills/mycc/scripts/`

**Dependencies**:
- [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/): `brew install cloudflare/cloudflare/cloudflared`

## FAQ

**Q: Hooks not working?**
A: Run `/setup` first, then **restart Claude Code** (close and reopen). Hooks only load at startup.

**Q: How to make CC remember more?**
A: Write to `0-System/about-me/`.

**Q: How to customize CC's personality?**
A: Edit the style definitions in `CLAUDE.md`.

## Why This Project

Claude Code is powerful, but needs configuration to reach its full potential.

This template open-sources the best practices accumulated from real usage, so you don't have to start from scratch.

**For**:
- Developers who want AI-assisted work/life
- People who want CC as a "partner" not just a "tool"
- Those interested in personal productivity systems

## Contributing

Issues and PRs are welcome!

## Star History

<a href="https://star-history.com/#Aster110/mycc&Date">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=Aster110/mycc&type=Date&theme=dark&v=20260127" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=Aster110/mycc&type=Date&v=20260127" />
   <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=Aster110/mycc&type=Date&v=20260127" />
 </picture>
</a>

## License

MIT

---

**MyCC** - Make Claude Code your partner, not just a tool.
