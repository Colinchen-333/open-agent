# Round 2 Capability Alignment Results

Date: 2026-04-05
Branch: `feat/core-alignment`
Plan: `docs/superpowers/plans/2026-04-05-round2-alignment.md`
Round 1 results: `docs/superpowers/plans/2026-04-05-capability-alignment-results.md`

---

## Summary

11 additional gaps (L14–L25) closed in a single serial pass. All 11 lanes used direct main-checkout dispatch with no worktree isolation — the pattern proved 100 % reliable (Round 1 had 3/8 pollution incidents with `isolation: "worktree"`; Round 2 had zero).

| Metric | Round 1 end | Round 2 end | Δ |
|---|---|---|---|
| Tests passing | 934 | **1084** | **+150** |
| Failures | 0 | **0** | — |
| Typecheck errors | 0 | **0** | — |
| Commits on `feat/core-alignment` | 23 | **35** | +12 (1 plan + 11 lanes) |

## Lanes landed

| Lane | Commit | Scope |
|---|---|---|
| L14 | `9815910` | `feature()` registry + 7 named flags + env-var overrides (`OPEN_AGENT_FEATURE_<NAME>`) |
| L17 | `12fae29` | 7 new slash commands: `/effort`, `/thinking`, `/plugins`, `/workflow`, `/keybindings`, `/insights`, `/upgrade`, `/version`, `/env` |
| L25 | `efce0cb` | `ModelCapability` registry + `supportsThinking` / `getContextWindowForModel` / `getModelCapability` for Claude 3.x/4.x, GPT-4o/5, GLM-4.7 |
| L24 | `0440648` | `writeStreamJsonLine(msg, stream?)` aligning CLI stream output with Claude Code SDK protocol (one JSON line per `SDKMessage`, no ANSI) |
| L16 | `813ead1` | Zero-dependency YAML frontmatter parser + `loadMarkdownConfig({ subdir, cwd, home })` with project-over-user precedence + `loadUserAgents()` integration |
| L18 | `7064513` | `userInvocable?: boolean` flag on Skill; hidden from `/skills` list and blocked from `/<name>` user invocation when false |
| L21 | `ea4685a` | `ToolAnnotations` (readOnly / destructive / openWorld / idempotent) on `ToolDefinition`; applied to 9 built-ins; MCP `*Hint`-suffixed round-trip through `normalizeMcpAnnotations` |
| L22 | `bc6c513` | `ExitPlanModeV2` with `allowedPrompts: Array<{ tool, prompt }>`; feature-gated via `EXIT_PLAN_MODE_V2`; registers semantic permissions on the engine for the classifier |
| L23 | `d101286` | `classifyPermissionRequest(request, context)` filling L4's stub: readOnly auto-allow + allowedPrompt stem-matching + recent-message approval phrase detection (EN + ZH); gated behind `TRANSCRIPT_CLASSIFIER` flag |
| L19 | `eedfd43` | `buildAnthropicThinkingParam(options)` + effort→budget mapping (low=8k / medium=16k / high=32k / max=60k); gated via `supportsThinking(model)`; temperature forced to 1.0 when thinking enabled |
| L20 | `8a1d106` | `FileHistoryStore` with per-session snapshots + FIFO eviction at 100; `Write`/`Edit`/`NotebookEdit` call `trackEdit` before mutation when `FILE_HISTORY` flag on; `/rewind <n>` restores N unique-message-UUID turns |

## Execution lessons

- **Strict serial + main-checkout dispatch** (no `isolation: "worktree"`) was **100 % reliable** across all 11 lanes. No stash recovery, no cherry-pick conflicts, no cross-lane pollution. This is the canonical pattern going forward.
- **Feature-flag gating** for experimental capabilities (L14 → consumed by L19, L20, L22, L23) kept defaults safe while unlocking opt-in behavior via `OPEN_AGENT_FEATURE_*` env vars.
- **Small exports + pure helpers** (e.g. `thinkingBudgetFromEffort`, `classifyPermissionRequest`, `parseFrontmatter`) made each lane trivially testable in isolation. Average lane completion time: **~2.5 minutes**.
- **L19 discovery**: The existing `AnthropicProvider.chat()` already partially wired thinking but had two silent bugs — (a) no `supportsThinking(model)` gate (would send thinking to GLM-4.7), (b) temperature not explicitly `1.0` when thinking enabled (relied on API default). Round 2's L25 + L19 closed both.
- **L16 scope hygiene**: Original plan included refactoring skills/commands to use the shared loader; that was deferred to keep the lane focused. The markdown-loader infrastructure is in place for Round 3 to consume.

## Known follow-ups (deferred to Round 3)

1. **File-history session JSONL persistence** (L20). Snapshots are in-memory only; a process restart between edit and `/rewind` loses history. Round 3 should serialize `{ type: 'file_history_snapshot', ... }` lines into the session JSONL and reload on `SessionManager.resume`.
2. **Skills / commands markdown loading** (L16 deferred part). `loadMarkdownConfig` exists but only `agent-loader.ts` consumes it. Wire into `SkillRegistry` and user-commands dispatch in Round 3.
3. **Thinking-trajectory preservation signature gap** (L19). `convertMessages` silently drops `thinking` blocks with empty `signature`. Add a logged warning so the drop is observable.
4. **`effortToBudget` vs `thinkingBudgetFromEffort` coexistence** (L19). Two budget scales (legacy 2k/8k/16k/32k and new 8k/16k/32k/60k) live side-by-side. Reconcile in a future cleanup lane.
5. **ToolAnnotations circular-dep workaround** (L21). `PermissionRequest.annotations` uses a local `ToolAnnotationsRef` mirror instead of importing from `@open-agent/tools` (circular via `bash.ts → permissions` already). Move both to `@open-agent/core` in a future refactor.
6. **Auto-mode classifier integration with real transcript** (L23). `setRecentUserMessages` exists but no caller wires it yet. ConversationLoop should push user messages into the engine after each turn so the classifier sees real context.
7. **L17 stub commands** (`/plugins`, `/workflow`, `/keybindings`, `/upgrade`) are placeholders until their backend systems exist.
8. **Model capability → actual wiring in non-Anthropic providers** (L25/L19). Only `AnthropicProvider` currently respects `supportsThinking`. `OpenAIProvider` (for GLM-4.7 coding endpoint) should also gate any future thinking support and expose context window limits to the compact pipeline.

## Cumulative state (Round 1 + Round 2)

**35 commits** on `feat/core-alignment` covering 24 distinct capability gaps (L1–L13 in Round 1, L14–L25 in Round 2). **1084 tests passing, 0 failures, 0 typecheck errors.**

The alignment covers: JSONL session storage, CLAUDE.md chain, hook contract, permission 5-step pipeline + classifier, 6-layer settings, subagent fork + sidechain, ToolSearch shouldDefer, Bash persistent PTY (via Node.js bridge), plan mode downgrade + V2 semantic permissions, expanded tool interface + annotations, layered auto-compact, system prompt principles, prompt cache dual boundary, feature flags, slash command inventory, model capability registry, stream-JSON SDK protocol, markdown config loaders, userInvocable skills, extended thinking budget, file history + rewind.
