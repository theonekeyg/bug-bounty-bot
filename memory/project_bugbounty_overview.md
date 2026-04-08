---
name: Bug Bounty Ralph Loop Agent - Project Overview
description: Core architecture decisions and tech stack for the autonomous security research agent
type: project
---

Ralph Loop multi-agent security research bot at /home/keyg/proj/ai/bug-bounty.

**Why:** Automate deep security research for bug bounty and client engagements with full reproducible PoCs.

**How to apply:** All implementation decisions should align with these choices.

Key decisions:
- Agent SDK: `@anthropic-ai/claude-agent-sdk` with `pathToClaudeCodeExecutable` (same as t3code/Claude Code itself). Requires `claude auth login`.
- Sandboxing: Boxer (https://github.com/theonekeyg/boxer) — gVisor-backed, TypeScript SDK. User has influence on Boxer project and can request features.
- UI: Electron app for interactive brief creation + real-time progress + permission prompts.
- Language: TypeScript strict mode only. Zod at all boundaries.
- Tool install flow: agent proposes → Electron surfaces permission prompt → user approves → then installs.
- Output: markdown report + repro/ folder with setup.sh + exploit.ts per vuln.
- Reference implementation studied: https://github.com/pingdotgg/t3code
