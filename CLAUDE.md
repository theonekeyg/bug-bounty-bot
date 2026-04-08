# Bug Bounty Ralph Loop Agent

Autonomous multi-agent security research system using the Ralph Loop pattern. Agents iterate on disk-persisted state until vulnerabilities are fully researched or disproven. Includes an Electron UI for interactive brief creation and real-time progress.

---

## Maintaining This File

Keep CLAUDE.md **small and accurate** — it is a living document. Update it as decisions are made, not after the fact. Remove outdated sections immediately. Do not pad with examples or prose that can be derived from code. Every line should earn its place.

## Testing Rule

**Always run code before presenting it.** Use the shell to run `bun ui`, `bun start`, `bun test`, `bun typecheck`, etc. after writing or changing code. Do not hand off untested programs. Fix errors before responding.

---

## Ralph Loop Pattern

Agents run autonomously until a completion criterion is met. Progress lives on disk, not in the context window. When context fills, a fresh agent reads state files and continues. Human oversight is **over** the loop, not in it — the user defines the target and stops the loop; agents handle everything in between.

---

## Tech Stack

- **Language**: TypeScript, `strict: true`, no implicit `any`. Runtime validation with `zod` at all boundaries.
- **Runtime**: Bun. No separate TypeScript runner needed — Bun executes `.ts` natively.
- **Agent SDK**: `@anthropic-ai/claude-agent-sdk` — same integration as Claude Code itself. Requires `claude auth login` before running. Uses `pathToClaudeCodeExecutable` to point at the local Claude Code binary.
- **UI**: Electron — interactive brief creation, real-time research progress, findings viewer.
- **Sandbox**: [Boxer](https://github.com/theonekeyg/boxer) (gVisor-backed). TypeScript SDK, zero deps, Node 18+. Each research track runs in its own Boxer execution. Network mode configurable per track (`none` / `sandbox` / `host`).
- **Linting/formatting**: `eslint` + `@typescript-eslint`, `prettier`.
- **Testing**: `bun test`.

---

## Architecture

```
Electron UI
    │ user brief
    ▼
Orchestrator Agent          ← reads brief, maps attack surface, spawns tracks
    │ spawns N
    ├── Researcher Agent A  ← owns one hypothesis, loops until found/disproven
    ├── Researcher Agent B
    └── Researcher Agent C
            │ all terminal
            ▼
       Reporter Agent       ← aggregates state/, writes output/
```

**Orchestrator**: Parses brief → determines attack surface → spawns one Researcher per track → writes `state/plan.md` → exits. Loop restarts it to monitor completion.

**Researcher**: Owns one vulnerability hypothesis. Loops: reason → tool call → write findings → repeat. Terminates when PoC confirmed or hypothesis conclusively disproven.

**Reporter**: Triggered when all tracks terminal. Reads `state/research/*/` → writes `output/report.md` + `output/repro/`.

### State Layout

```
state/
  plan.md                        # attack surface map + track assignments
  command_log.jsonl              # all shell commands (append-only, required)
  research/<track-id>/
    hypothesis.md
    progress.md                  # append-only running log
    findings.md
    status.json                  # { status: "running"|"found"|"disproven"|"blocked" }
output/
  report.md
  repro/<vuln-id>/
    README.md                    # setup + step-by-step reproduction
    setup.sh
    exploit.ts
    expected_output.txt
```

---

## Sandboxing with Boxer

All agent-executed shell commands run inside Boxer sandboxes (gVisor isolation). Each Researcher track gets its own sandbox instance.

- **Default network mode**: `none` (no external access). Researcher upgrades to `sandbox` or `host` only when required and documents why in `progress.md`.
- Files are uploaded before execution and captured from `/output/` after.
- Boxer must be running locally before the loop starts (setup documented in `docs/setup.md`).
- The TypeScript SDK (`boxer-sdk`) is the only interface — no raw HTTP calls.

---

## Tool Installation

Agents may determine that additional tools are needed (system packages, npm deps, Semgrep rules, etc.). The flow:

1. Agent writes the proposed installation to `state/research/<track-id>/pending_install.md` with justification.
2. Electron UI surfaces this as a permission prompt to the user.
3. Agent blocks on `status.json` → `"awaiting_permission"` until user approves or rejects.
4. On approval, agent proceeds inside the Boxer sandbox where possible; system-level installs happen on the host after explicit user confirmation.

---

## Input (Brief Format)

```
TARGET: <project name / description>
SCOPE:  <in/out of scope>
CODE:   <local path(s)>
LINKS:  <URLs — repos, docs, APIs, live instances>
CONTEXT: <tech stack, known interesting areas, prior research>
GOAL:   <e.g. "full audit", "reproduce CVE-XXXX-XXXX", "find auth bypass">
```

Orchestrator asks **at most one** clarifying question before starting. The Electron UI provides an interactive form that produces this format.

---

## Output Format

**`output/report.md`**:
```
# Security Research Report: <Target>
## Executive Summary
## Attack Surface Map
## Findings
  ### <VULN-ID>: <Title>   [Severity | CWE]
  Description / Impact / Reproduction: see output/repro/<vuln-id>/
## Dead Ends (Investigated, No Finding)
## Methodology + Tools
```

**`output/repro/<vuln-id>/`**: `README.md`, `setup.sh`, `exploit.ts`, `expected_output.txt`. Scripts marked `[UNTESTED]` if not verified locally.

---

## Tools Available to Agents

All implemented as typed TypeScript wrappers in `src/tools/` with Zod input schemas.

| Tool | Purpose |
|------|---------|
| `read_file` / `write_file` / `list_dir` | Local filesystem |
| `grep_codebase` | Regex search across files |
| `run_command` | Execute in Boxer sandbox (logged to `command_log.jsonl`) |
| `web_search` | CVE lookup, writeups, docs |
| `fetch_url` | Download files, HTML, API responses |
| `run_semgrep` | Static analysis |
| `run_npm_audit` | Dependency CVE scan |
| `run_git` | Git operations on local repos |

---

## Restrictions

1. **Authorized targets only.** Bug bounty programs, client engagements with written authorization, CTFs, personal projects you own.
2. **No destructive actions.** No mass requests, no data deletion, no production interference.
3. **Redact secrets.** Discovered credentials/PII must be redacted before writing to `state/` or `output/`. Log that a secret was found, not its value.
4. **All shell commands logged.** Every `run_command` → `state/command_log.jsonl` (timestamp, cwd, full command). Non-negotiable.
5. **No unverified PoCs presented as confirmed.** Mark `[UNTESTED]` if not locally run.

---

## Project Structure

```
bug-bounty/
  CLAUDE.md
  package.json / pnpm-lock.yaml / tsconfig.json
  src/
    orchestrator/
    researcher/
    reporter/
    tools/          # typed tool wrappers
    types/          # shared types
    loop/           # Ralph Loop runner + context handoff
    index.ts
  ui/               # Electron app
  state/            # runtime (gitignored)
  output/           # reports + repro scripts
  briefs/           # target briefs
  docs/
    setup.md        # Boxer + claude auth setup
```

## Running

```bash
# Prerequisites
claude auth login          # one-time Claude Code auth
# start Boxer (see docs/setup.md)

# Install dependencies
bun install

# Start the Electron UI
bun ui

# Or headless
bun start --brief briefs/target.md
```
