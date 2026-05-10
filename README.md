# Kernal — Cross-Functional AI Agent for VS Code

> One shared AI layer for your entire team — engineers, PMs, designers, and QA — regardless of which AI tool each person uses.

---

## The problem Kernal solves

Mixed-tool teams lose alignment. An engineer on Claude Code and a PM on Claude.ai free tier are both using AI, but each AI knows nothing about the project — its conventions, its gotchas, its current sprint. The result is AI output that's generic at best and misleading at worst.

Kernal fixes this with two things:

1. **A `SKILL.md` file** at your repo root that acts as the project's authoritative playbook. Kernal reads it and prepends it to every AI call — code edits, PR reviews, standups, explanations — across every teammate's machine, whatever tool they're on.

2. **A `.kernal/` folder** committed to git that holds your team context: who's on the team, coding conventions, per-workflow prompt templates, and an append-only activity log.

The result: a PM using Claude.ai free and an engineer using Claude Code both get the same project rules applied to their AI work, with zero configuration per person and no shared API keys.

---

## What Kernal does

1. **Detects** which AI tools you have available — Claude Code CLI, OpenAI Codex CLI, GitHub Copilot extension, or Claude.ai via the web.
2. **Routes** each task to the best available tool based on the task type (code edit, review, explain, chat).
3. **Injects shared context** — your `SKILL.md` playbook plus team files — into every AI invocation automatically.
4. **Logs activity** in `.kernal/activity.jsonl` so the team can see what each member's AI did.

---

## Installation

### From the VS Code Marketplace
Search for **Kernal** in the Extensions panel (`Cmd+Shift+X`) and click Install.

### From a `.vsix` file
1. Download `kernal-0.1.0.vsix`.
2. Open VS Code → Extensions panel → `⋯` menu → **Install from VSIX…**
3. Select the downloaded file.

### For development / contributors
```bash
git clone <repo>
cd kernal
npm install
npm run compile
```
Open the `kernal/` folder in VS Code → **Run → Start Debugging** (or `Fn+F5` on Mac).

---

## Quick start (5 minutes)

**Step 1 — Open your project**
Open any folder in VS Code. Kernal activates automatically on startup.

**Step 2 — Look at the Activity Bar**
A new **Kernal icon** (⊕) appears in the left sidebar. Click it to see three panels:
- **AI Tools Detected** — what Kernal found on your machine
- **Workflows** — tasks you can run with one click
- **Team Activity** — a log of recent AI runs by you and your teammates

**Step 3 — Detect your tools**
Open the Command Palette (`Cmd+Shift+P`) → `Kernal: Detect Available AI Tools`
The tools panel updates. Claude.ai (web) is always available; Claude Code and Codex are detected from your `$PATH`; GitHub Copilot is detected from installed extensions.

**Step 4 — Create your SKILL.md**
`Cmd+Shift+P` → `Kernal: Show Project SKILL.md`
If no `SKILL.md` exists, accept the prompt to create one. A template opens. Fill it in — the more specific, the better. The status bar gains a 📖 icon to confirm it's loaded.

**Step 5 — Run a workflow**
`Cmd+Shift+P` → `Kernal: Generate My Standup`
Kernal assembles a prompt (your SKILL.md + team context + git activity) and sends it to your active AI tool.

That's it. Every workflow you run from this point on uses your project's playbook.

---

## SKILL.md — the central feature

`SKILL.md` lives at your **repo root** (not inside `.kernal/`). It's the single file every teammate commits and every AI reads.

Kernal watches it with a filesystem watcher — **no restart needed** after you edit it. The next workflow run picks up the new content automatically.

### What to put in SKILL.md

```markdown
# Project Skill

## What this project is
One paragraph: the product, the audience, the current phase.

## Stack and structure
- Language(s) and versions
- Framework(s)
- Key folders and what lives in each

## How we write code here
- Style rules that override defaults
- Patterns we prefer (and why)
- Patterns we avoid (and why)

## How we review
- What every PR must include
- What blocks a merge

## What "done" looks like
- Tests required
- Docs required
- Telemetry / observability required

## Known gotchas
- Things that look wrong but are intentional
- Things that look right but are bugs waiting to happen

## When in doubt
- Who to ask
- Which doc to read
```

**Tip:** Be specific. "No `any` types" is useful. "Write clean code" is not. Kernal passes this verbatim to the AI — the AI is only as constrained as what you write here.

### Monorepo: nested SKILL.md files

If your repo has packages with different rules, add a `SKILL.md` inside that package directory:

```
packages/
├── api/
│   └── SKILL.md    ← loaded when editing any file under packages/api/
└── web/
    └── SKILL.md    ← loaded when editing any file under packages/web/
```

Kernal walks up from the active file and picks the most specific `SKILL.md` it finds. Both the root SKILL and the package SKILL are included in the context — the package-level one is labelled "more specific" and wins on conflicts.

---

## The `.kernal/` folder

On first activation in a new workspace, Kernal creates this structure automatically (never overwrites existing files):

```
.kernal/
├── team.md              — who's on the team, current sprint, key contacts
├── conventions.md       — code style, PR rules, naming, anti-patterns
├── prompts/
│   ├── review.md        — prompt used by the PR review workflow
│   ├── standup.md       — prompt used by the standup workflow
│   └── explain.md       — prompt used by the explain workflow
├── decisions/           — ADRs: why the big architectural calls were made
├── activity.jsonl       — append-only log of all Kernal runs
└── README.md            — explains the folder to new teammates
```

**Commit `.kernal/` to git** (except `activity.jsonl` unless you want shared logs — see `kernal.activityLogShared`). New teammates who clone the repo get the full context immediately.

### Filling in the context files

`team.md` — short and current:
```markdown
# Who we are
5-person team: 3 engineers, 1 PM, 1 designer.

# Current sprint
Sprint 14 (ends 2025-05-23)
- Carrier webhook retry logic
- Multi-org database migration

# Key contacts
- Priya (tech lead) — auth and infra decisions
- Anya (PM) — roadmap and spec review
```

`conventions.md` — your actual rules, not generic advice:
```markdown
# Code style
- 2 spaces, single quotes, trailing commas (Prettier handles it)
- TypeScript strict mode: no `any`, no implicit `undefined`

# PR rules
- Branch naming: feat/, fix/, chore/, docs/
- Squash-merge only — no merge commits on main
- Every PR needs a "Testing" section with exact steps

# Things to avoid
- `useEffect` for data fetching — use React Query instead
- Direct Prisma calls from components — always go through the service layer
- `JSON.parse` without try/catch — carrier webhooks send malformed payloads
```

---

## Workflows

Kernal ships with 9 built-in workflows. They appear in the **Workflows** sidebar panel filtered by your role (`kernal.userRole`).

| Workflow | Roles | What it does |
|---|---|---|
| **Generate my standup** | All | Summarises your last 10 commits + working tree into a Yesterday/Today/Blockers update |
| **Explain selected code** | All | Explains a selection: what it does, why it exists, key invariants, callers |
| **Generate changelog** | All | Turns the last 30 commits into a Features / Fixes / Chores changelog |
| **Review current branch as PR** | Engineer, QA | Diffs your branch against `origin/main` and reviews it for correctness, convention fit, and risk |
| **Write tests for current file** | Engineer, QA | Generates a test suite for the active file using the project's testing patterns |
| **Triage bug report** | Engineer, QA | Analyses a selected bug report: likely cause, severity, reproduction steps, suggested fix |
| **Document current file** | Engineer | Adds or improves doc comments on exported symbols; returns the updated file |
| **Break a spec into tasks** | PM | Converts a selected product spec into sprint-ready engineering tasks with complexity estimates |
| **Design handoff checklist** | Designer | Turns a design description into an implementation checklist with accessibility and responsive notes |

### Running a workflow

**Three ways:**

1. **Sidebar** — Click any workflow in the Workflows panel. One click, no typing.
2. **Command Palette** — `Cmd+Shift+P` → type the workflow name (e.g. `Kernal: Generate My Standup`).
3. **Quick pick** — `Cmd+Shift+P` → `Kernal: Run Workflow…` → choose from the list.

### Role filtering

Workflows are filtered by your role. Set yours in Settings → `kernal.userRole`:

| Role | Sees |
|---|---|
| `engineer` | All-role + engineer + QA workflows |
| `pm` | All-role + PM workflows |
| `designer` | All-role + designer workflows |
| `qa` | All-role + QA workflows |
| `other` | All-role workflows only |

### Adding a custom workflow

Edit `.kernal/workflows.ts` — just kidding, edit `src/workflows.ts` in the extension source and add an entry to the `WORKFLOWS` array:

```typescript
{
  id: 'my-workflow',
  label: 'My workflow label',
  description: 'One-line description shown in the sidebar',
  forRoles: ['engineer'],          // [] = visible to all roles
  taskKind: 'chat',                // code-edit | review | explain | chat
  async build(ctx) {
    const prompt = 'Your task instructions here.';
    const payload = getActiveSelection() || 'No selection.';
    return { prompt, payload };
  },
},
```

No other files need changing. The workflow appears in the sidebar after the extension reloads.

### Customising workflow prompts

The prompts for `review`, `standup`, and `explain` workflows are loaded from `.kernal/prompts/`. Edit these files to change how the AI approaches each task for your specific project:

**`.kernal/prompts/review.md`** — add project-specific review criteria:
```markdown
Review this diff as a senior engineer on a TypeScript/Prisma/tRPC project.

Pay special attention to:
- Any query that could be slow at scale (missing index, N+1)
- Auth: every tRPC procedure must check ctx.session — never trust client-sent user IDs
- Missing zod validation on inputs that touch the database

Classify each issue as: blocker / suggestion / nit
```

---

## AI Tool detection and routing

### Detection

Run `Kernal: Detect Available AI Tools` at any time. Kernal checks:

| Tool | How detected |
|---|---|
| **Claude Code** | Runs `claude --version` (3s timeout) |
| **Codex CLI** | Runs `codex --version` (3s timeout) |
| **GitHub Copilot** | Checks for `GitHub.copilot` or `GitHub.copilot-chat` extensions |
| **Claude.ai (web)** | Always available — Kernal copies the prompt to clipboard and opens `claude.ai/new` |

### Automatic routing

When `kernal.preferredTool` is `auto`, Kernal picks the best available tool for each task type:

| Task kind | Priority order |
|---|---|
| Code edit | Claude Code → Codex → Copilot → Claude.ai |
| Review | Claude Code → Copilot → Codex → Claude.ai |
| Explain | Copilot → Claude Code → Claude.ai → Codex |
| Chat | Claude Code → Copilot → Claude.ai → Codex |

### Forcing a specific tool

Settings → `kernal.preferredTool` → choose from the dropdown. The status bar updates immediately to reflect the change.

### What happens per tool

| Tool | Kernal sends the prompt by… |
|---|---|
| **Claude Code** | Spawning `claude -p <prompt>`, streaming stdout into a new editor tab |
| **Codex** | Spawning `codex exec <prompt>`, same pattern |
| **GitHub Copilot** | Calling the `workbench.action.chat.open` VS Code command |
| **Claude.ai (web)** | Copying the full prompt to clipboard + opening `claude.ai/new` in your browser |

---

## Chat panel

`Cmd+Shift+P` → `Kernal: Open Chat` (or click the chat icon in the Workflows panel header).

The chat panel opens beside your editor with:

- **Active tool badge** — shows which AI is handling your messages
- **SKILL.md indicator** — `📖 SKILL.md` confirms your playbook is loaded
- **Multi-turn memory** — previous turns are included in each prompt so the AI remembers the conversation
- **Streaming output** — for Claude Code and Codex, the response appears word-by-word as it arrives
- **Keyboard shortcut** — `Cmd+Enter` (Mac) or `Ctrl+Enter` (Windows/Linux) to send

Every message in the chat automatically includes your `SKILL.md`, `team.md`, `conventions.md`, git branch, and recent commits — you never need to paste context manually.

For Claude.ai (web), Kernal copies the full assembled prompt to your clipboard and opens `claude.ai/new`. Paste to run.

---

## Preview mode

Enable `kernal.previewBeforeSend` in Settings to see the full assembled prompt before it's sent to any AI tool.

When enabled:
1. Kernal assembles the prompt (SKILL.md + team context + git context + workflow task + payload)
2. Opens it in a read-only markdown tab so you can read the exact text
3. Shows a **Send / Cancel** notification — you decide whether to proceed

Useful for debugging why an AI gave an unexpected answer, or for reviewing long payloads like diffs before sending.

---

## Configuration reference

All settings are under the `kernal.*` namespace in VS Code Settings.

| Setting | Type | Default | Description |
|---|---|---|---|
| `kernal.preferredTool` | `"auto" \| "claude-code" \| "codex" \| "copilot" \| "claude-web"` | `"auto"` | Which AI tool to use. `auto` picks the best available per task type. |
| `kernal.userRole` | `"engineer" \| "pm" \| "designer" \| "qa" \| "other"` | `"engineer"` | Your role — controls which workflows appear in the sidebar. |
| `kernal.teamContextPath` | string | `".kernal"` | Workspace-relative path to the team context folder. |
| `kernal.activityLogShared` | boolean | `false` | If `true`, treat `activity.jsonl` as a shared git-committed file. |
| `kernal.previewBeforeSend` | boolean | `false` | Show the assembled prompt before sending and ask for confirmation. |

Settings can also be placed in your workspace `.vscode/settings.json` to make them repo-specific:

```json
{
  "kernal.userRole": "engineer",
  "kernal.preferredTool": "claude-code",
  "kernal.activityLogShared": true
}
```

---

## Team setup guide

### For the first person setting up Kernal on a project

1. Install Kernal. Open the project in VS Code.
2. Run `Kernal: Show Project SKILL.md` → Create → fill in the template.
3. Run `Kernal: Sync Team Context` to create the `.kernal/` folder with all scaffolded files.
4. Edit `.kernal/team.md` and `.kernal/conventions.md` with your project's real content.
5. Edit `.kernal/prompts/review.md` to add project-specific review criteria.
6. Commit `SKILL.md` and `.kernal/` to git (add `activity.jsonl` to `.gitignore` unless you want shared logs).

### For every subsequent teammate

1. Install Kernal. Open the project (which now has `SKILL.md` and `.kernal/` committed).
2. Set `kernal.userRole` in Settings to match your role.
3. Done. Kernal picks up the committed context automatically.

### `.gitignore` recommendation

```gitignore
# Kernal activity log — per-machine, not shared
.kernal/activity.jsonl
```

If you want the activity log shared across the team (everyone sees what all AIs did), set `kernal.activityLogShared = true` and remove the gitignore entry.

---

## Status bar

The status bar item at the bottom-left shows:

```
⚀ Kernal: Claude Code 📖
```

- **Tool name** — the AI tool currently active for your workflow runs
- **📖** — `SKILL.md` is loaded and will be prepended to every prompt
- **Click** — re-runs tool detection

If you see **No tool found**, run `Kernal: Detect Available AI Tools` from the Command Palette.

---

## Context bundle composition

Every prompt Kernal assembles follows this order (most authoritative first — so if a tool truncates for length, the most important rules survive):

```
[System preamble — treats SKILL as authoritative]

# PROJECT SKILL (authoritative)
  <SKILL.md content>

# NESTED SKILL (if editing a file inside a package with its own SKILL.md)
  <package/SKILL.md content>

# team.md
  <.kernal/team.md content>

# conventions.md
  <.kernal/conventions.md content>

# Git Context
  Branch: <current branch>
  Last 5 commits: <git log --oneline -5>

## Task
  <workflow prompt>

## Input
  <payload: diff / selection / file / git log>
```

---

## Architecture (for contributors)

```
src/
├── extension.ts       — activate(), command registration, status bar, SKILL.md watcher
├── toolDetector.ts    — detects claude/codex/copilot, implements routing logic
├── teamContext.ts     — reads .kernal/, loads/caches SKILL.md, appends activity log
├── workflowRunner.ts  — assembles prompts, invokes tools, streams output, logs activity
├── workflows.ts       — 9 workflow definitions + runWorkflowById dispatcher
├── treeProviders.ts   — AI Tools / Workflows / Team Activity sidebar tree views
└── chatPanel.ts       — webview chat panel with streaming and conversation history
```

**Key design decisions:**

- `SKILL.md` is cached on the `TeamContext` instance and invalidated by the filesystem watcher. This means reads happen at most once per file change, not once per prompt.
- `WorkflowRunner` exposes both `assemblePrompt()` and `invoke()` separately so the preview feature can show the prompt without sending it.
- The chat panel holds conversation history in memory (cleared on Close or Clear). History is embedded in each new prompt as plain text — no external session management.
- All file I/O uses `vscode.workspace.fs` (async, works in virtual workspaces). Git commands use synchronous `execSync` since they're fast and the API is simpler.
- No external runtime dependencies. No bundler. Node stdlib + VS Code API only.

---

## Building a `.vsix` for distribution

```bash
npm install -g @vscode/vsce
cd kernal
npm run compile
vsce package
# produces kernal-0.1.0.vsix
```

Share the `.vsix` file with teammates who install it via Extensions → `⋯` → Install from VSIX.

To publish to the VS Code Marketplace, update `publisher` in `package.json` and run `vsce publish`.

---

## FAQ

**Q: Does Kernal send my code anywhere?**
No. Kernal is a local router. It passes your prompts to whatever AI tool you have configured (Claude Code CLI, Codex CLI, Copilot extension, or your browser). Kernal itself makes no network calls except opening `claude.ai` in your browser for the web fallback.

**Q: Do I need an API key?**
No. Each AI tool handles its own authentication. Claude Code needs you to be logged into the `claude` CLI. Codex needs you logged into `codex`. Copilot uses your GitHub account. Claude.ai web uses your browser session.

**Q: What if my team uses different tools?**
That's exactly the use case Kernal is built for. The `SKILL.md` and `.kernal/` context is tool-agnostic. An engineer on Claude Code and a PM on Claude.ai web both get the same playbook prepended, even though the mechanics of how it gets there are different.

**Q: Can I use Kernal without SKILL.md?**
Yes. If no `SKILL.md` exists, Kernal still runs workflows with `team.md`, `conventions.md`, and git context. You just lose the authoritative project playbook, which is the most valuable part.

**Q: SKILL.md got large. Does it affect AI quality?**
Token-efficient AI models handle long context well, but keep SKILL.md focused on decisions that change AI behaviour. Remove sections that just describe the codebase (the AI can read that) and keep sections that define rules, gotchas, and constraints.

**Q: The `.kernal/` folder name conflicts with something in my project.**
Change `kernal.teamContextPath` in Settings to any path you prefer (e.g. `.ai-context`). Kernal reads from and writes to that path instead.

**Q: Can I add workflows without rebuilding the extension?**
Not in v0.1. Workflows are defined in source. A future version will support loading custom workflows from `.kernal/workflows/`.

---

## Keyboard shortcuts

No default keybindings ship with Kernal to avoid conflicts. Add your own in VS Code's Keyboard Shortcuts editor (`Cmd+K Cmd+S`):

```json
[
  { "key": "cmd+shift+k", "command": "kernal.runWorkflow" },
  { "key": "cmd+shift+j", "command": "kernal.standup" },
  { "key": "cmd+shift+;", "command": "kernal.chat" }
]
```

---

## License

MIT
