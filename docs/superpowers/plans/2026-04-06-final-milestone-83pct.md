# Alignment Final Milestone — 109 commits, 1764 tests, 83-85% comprehensive

Date: 2026-04-06
Branch: feat/core-alignment

## Score trajectory (comprehensive 8-dim audits)
78.25% → 78.5% → 84.7% → 83.0%

## What was built (109 commits since baseline)
- Runtime: proactive auto-compact with LLM summarizer, token-aware window bands, file history
- Providers: OpenAI full capability (structured output/thinking/context budget), Anthropic per-model registry
- Tools: 25+ built-in (TodoWrite, REPL, Workflow, Brief, Sleep, Snip, Cron×3, LSP, Config), bash subcommand extraction
- Permissions: 5-step pipeline, LLM classifier, preToolUseHooks, glob rules, sandbox enforcement
- Subagents: cache-safe fork, sidechain JSONL, 8 agent schema fields consumed at runtime
- MCP: readResource, subscribe, elicitation, per-server state, shouldDefer activation
- Config: feature flags, markdown loaders, keybindings, output styles, hooks camelCase
- CLI: 37+ slash commands, /resume hydration, stream-json protocol

## Next session priorities (to reach 95%)
1. Permissions: systematic allowedPrompts security (command-anchored matching, not keyword overlap)
2. Provider: fix Haiku listModels split-brain (supportsThinking mismatch)
3. Sandbox: Linux seccomp/pledge equivalent (currently macOS only)
