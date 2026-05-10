# Changelog

All notable changes to Kernal are documented here.

## [0.1.0] — 2025-01-01

### Added
- Cross-tool AI routing: Claude Code CLI, OpenAI Codex CLI, GitHub Copilot, Claude.ai web
- SKILL.md — project-level context file prepended to every AI call
- Nested SKILL.md resolution: walks up from the active file to find the nearest skill
- `.kernal/` scaffold: `team.md`, `conventions.md`, `prompts/`, `decisions/`, `activity.jsonl`
- 9 built-in workflows: PR review, standup, explain selection, PM spec-to-tasks, design handoff, doc file, write tests, generate changelog, triage bug
- Webview chat panel with streaming output and multi-turn history
- Role-based workflow filtering (engineer, PM, designer, QA)
- `previewBeforeSend` mode: inspect the full prompt before dispatching
- Append-only activity log (JSONL) capped at 1000 entries with concurrent-write safety
- Status bar indicator showing active tool and SKILL.md presence
- Git branch + recent commits injected into every context bundle
- Tool detection: async parallel CLI checks, extension presence check for Copilot
- 500ms debounce on SKILL.md file watcher
- Progress notification during CLI workflow runs
