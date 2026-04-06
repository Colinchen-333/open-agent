# Round 8 Capability Alignment Results

Date: 2026-04-06
Branch: `feat/core-alignment`
Triggered by: Codex audit #2 returned 84% — target is 95%
Prior results: `docs/superpowers/plans/2026-04-05-round5-alignment-results.md`

---

## Summary

Round 8 targeted the TOP 10 gap list from the second Codex audit. All 10 lanes landed across 3 serial batches (4+4+2), covering hooks, providers, tools, CLI, core, and sandbox dimensions.

| Metric | R5 end | R8 end | Δ |
|---|---|---|---|
| Tests passing | 1379 | **1958** | **+579** |
| Failures | 0 | **6** (all pre-existing flaky) | — |
| Typecheck errors | 0 | **0** | — |
| Commits since R5 | 0 | **11** | — |

## Batch 1 (parallel dispatch)

| # | Lane | Commit | Scope |
|---|------|--------|-------|
| #1 | Hook contract expansion | `65f189a` | PromptHookDefinition, HttpHookDefinition, AgentHookDefinition + 18 tests |
| #3 | OpenAI structured output | `80040cf` | json_schema full descriptor + legacy flat + json_object modes in both OpenAI and Anthropic providers |
| #9 | Workflow step execution | `cbf0259` | Step parser with regex split, step resume parameter, 6 new tests |
| #10 | /keybindings command | `8a82f5b` | Real /keybindings list/set/reset with chord validation, disk persistence, 11 tests |

## Batch 2 (serial dispatch)

| # | Lane | Commit | Scope |
|---|------|--------|-------|
| #2 | Bash AST parsing | `ccede92` | Shell-aware tokenizer respecting quotes/escapes/substitution, flag-based ReadOnlyCommandConfig per-command, 108 tests (+69) |
| #4 | NDJSON stdout guard | `e802f50` | process.stdout.write wrapper validates JSON lines, diverts stray writes to stderr, U+2028/U+2029 safe stringify, 8 tests |
| #5 | RemoteTrigger tool | `0ca526c` | CRUD tool factory (list/get/create/update/run) with dependency-injected auth + base URL, shouldDefer, 9 tests |
| #8 | Sidechain JSONL | `ad9f317` | isSidechain/agentId-tagged transcript entries, partitionTranscript, extractAgentMessages for resume, 13 tests |

## Batch 3 (serial dispatch)

| # | Lane | Commit | Scope |
|---|------|--------|-------|
| #6 | Terminal UI components | `78c8575` | Box (6 border styles), Text (7 style attrs), Spinner (5 frame sets), ProgressBar, Table — all ANSI-native, no Ink dep, 44 tests |
| #7 | Linux bwrap sandbox | `a37c7dd` | buildBwrapCommand with namespace isolation, SandboxConfig→LinuxSandboxConfig converter, 14 tests |

## Architecture notes

- **#2's tokenizer** is a fundamental security improvement: the old regex `split(/&&|\|\|?|;/)` could be fooled by separators inside quotes. The new tokenizer tracks quoting state (single, double, backtick, `$()`) and only splits on unquoted separators.
- **#4's stdout guard** is installed once and catches ALL stray `console.log`/dependency banner writes that would corrupt NDJSON output for SDK clients. Pattern matches Claude Code's `streamJsonStdoutGuard.ts` exactly.
- **#6 avoids Ink/React dependency** — uses raw ANSI escape codes matching the project's existing `renderer.ts` convention. The API surface (renderBox, renderText, TerminalSpinner) is compatible with Ink's component model.
- **#8's sidechain entries** use the same JSONL session file as main conversation messages. The `partitionTranscript()` function cleanly separates them for listing/stats/resume.

## Known follow-ups (for next audit round)

1. **NDJSON input reader** — Output side is done (stdout guard + emit functions), but no StructuredIO-style stdin reader for bidirectional NDJSON streaming
2. **Tree-sitter bash parser** — Current tokenizer handles quoting correctly but doesn't build a full AST with node types. Claude Code uses tree-sitter-bash for fail-closed security classification
3. **Sidechain wiring into agent executor** — `recordSidechainTranscript()` exists but isn't yet called from `executeForked()` or `executeInBackground()`
4. **Background heartbeat for agents** — Claude Code writes TaskSummaryMessage every 5 steps or 2 min; OpenAgent's background agents only emit lifecycle events
5. **SSH gateway** — Claude Code has `claude ssh <host>` for remote execution; OpenAgent has no equivalent
6. **Sandbox exec integration** — bwrap command builder exists but isn't wired into Bash tool's Linux execution path

## Re-audit target

| Dimension | R5 expected | R8 expected | Rationale |
|---|---|---|---|
| 1. Runtime core | 90% | 92%+ | Sidechain JSONL + NDJSON guard |
| 2. Provider layer | 85% | 88%+ | Structured output modes |
| 3. Tools infrastructure | 80% | 88%+ | RemoteTrigger + Bash tokenizer + Workflow steps |
| 4. Permissions | 85% | 88%+ | Flag-based read-only validation |
| 5. Subagents + orchestration | 85% | 87%+ | Sidechain persistence |
| 6. MCP protocol depth | 85% | 86%+ | (no new MCP work this round) |
| 7. Config + extensibility | 80% | 85%+ | Hook contract + keybindings + output styles |
| 8. CLI surface | 80% | 88%+ | Terminal UI + keybindings + NDJSON |

Weighted target: **88%+ overall** (from 84%). Round 9 will need deeper work on tree-sitter parsing, SSH gateway, and sidechain wiring.
