# Round 5 Capability Alignment Results

Date: 2026-04-05
Branch: `feat/core-alignment`
Triggered by: Codex audit #1 returned 80% — target is 95%
Prior results: `docs/superpowers/plans/2026-04-05-round3-alignment-results.md`

---

## Summary

Round 5 directly targeted Codex's 5 priority recommendations from the first audit. 7 lanes landed covering every item Codex flagged, plus R4.1-R4.3 landed earlier in this iteration as quick follow-ups.

| Metric | R3 end | R5 end | Δ |
|---|---|---|---|
| Tests passing | 1301 | **1379** | **+78** |
| Failures | 0 | **0** (one flaky SDK session test under full-suite load) | — |
| Typecheck errors | 0 | **0** | — |
| Commits since R3 docs | 0 | **12** | — |

## Round 4 follow-ups (landed during the gap between R3 and R5)

| Lane | Commit | Scope |
|---|---|---|
| R4.1 | `1495780` | `activeOutputStyle` option threaded into `buildSystemPrompt()` — injects output style instructions as a dynamic section at prompt assembly time |
| R4.2 | `66af092` | Darwin sandbox wrapper wired into Bash tool's foreground execution path (PTY branch exempt) with `DARWIN_SANDBOX` feature flag |
| R4.3 | `e675c03` | `/resume` slash command wired to `searchSessions` + `buildCrossProjectResumeHint` with 7 new tests |

## Round 5 lanes (responding to Codex gap list)

| Codex # | Lane | Commit | Scope |
|---|---|---|---|
| #1 | **R5.1** | `45b1440` | SDK `query()` forwards `outputStyleName` → resolves via `loadOutputStyles/findOutputStyle` → `activeOutputStyle` → `buildSystemPrompt`. Also wires a `setOutputStyleName` callback on `SlashCommandContext` for CLI integration. |
| #2b | **R5.2** | `ffc6624` | `filterIgnoredFindings` from `sandbox-meta-policy.ts` wired into **all 7** Bash execution record sites (started/done/blocked/failed/aborted/timed_out/success). New `BashToolDeps.sandboxMetaPolicy` option. Non-silent ignored violations log via `console.warn`. |
| #3 | **R5.3** | `364ae7f` | Token-aware proactive compact: new `estimateMessageTokens()` walks text/tool_use/tool_result/thinking blocks. `shouldTriggerProactiveAutocompact` derives threshold from `contextWindow * 0.6`, supports `model` → `getContextWindowForModel`. `getContextWindowBand` for observability. Circuit breaker via `lastReductionRatio`. |
| #4 | **R5.4** | `2c43515` | Cache-safe `createForkContext`: prepends `DEFAULT_CHILD_DIRECTIVE` system message, emits worktree notice when `cwd !== parentCwd`, synthesizes placeholder `tool_result` entries for orphaned `tool_use` blocks (preserves Anthropic API invariant + prompt cache byte-equality). 10 new tests. |
| dim 5 | **R5.5** | `cee4f94` (est) | `AgentDefinition` schema expanded with 8 new fields: `effort`, `permissionMode`, `mcpServers` (wider support), `hooks`, `memory`, `background`, `requiredMcpServers`, `omitClaudeMd`. Both camelCase and kebab-case aliases parsed. 10 new tests. |
| dim 1 | **R5.6** | `(latest)` | Microcompact rewritten to be tool-type aware: `DEFAULT_TOOL_BUDGETS` per tool (Read=200k, WebFetch=40k, etc.), semantic boundary cuts at newline within last 10% of budget, image/binary blocks preserved unchanged in array content, `cache_control`-marked blocks skipped entirely. 9 new tests. |
| dim 3 | **R5.7** | `c815f30` | New `TodoWrite` tool factory matching Claude Code's shape: `{ content, status, activeForm }` per item, complete-replacement semantics, per-session isolation, `onUpdate` callback, structured summary. Registered in `createDefaultToolRegistry`. 9 new tests. |

## Architecture notes

- **R5.2 found all 7 sites** where sandbox findings were attached to execution records — a pure-function filter is trivially applicable at each site, so no refactor needed.
- **R5.3's token estimator** intentionally avoids any tokenizer dependency. The `chars/4` heuristic is a conservative overestimate for English. A more accurate tokenizer can be swapped in later without API changes.
- **R5.4's orphan detection** walks the full message history, not just the tail. This catches any `tool_use` block anywhere in the history that lacks a matching `tool_result` — including cases where the fork captures a parent mid-tool-call.
- **R5.6's tool-type budgets** use a static table (`DEFAULT_TOOL_BUDGETS`) rather than querying `ToolDefinition.maxResultSizeChars` from L10. The static table gives intentional differentiation (Read vs WebFetch), whereas tool-level defaults would flatten everything to the same number.
- **R5.7's TodoWrite** is intentionally decoupled from the existing TaskManager/TaskCreate infrastructure (R1 work). TaskManager is cross-session agent coordination; TodoWrite is in-session model-managed checklist. The two coexist.

## Known follow-ups (for next audit round)

1. **Flaky `listSessions` full-project test** — passes in isolation (28/28), times out under full-suite load (5s deadline exceeded). Needs timeout bump or test parallelization isolation.
2. **CLI REPL doesn't yet build `SlashCommandContext.setOutputStyleName`** — the SDK path is fully wired but `apps/cli/src/index.ts` needs a one-line update to persist the style across turns in the CLI REPL.
3. **`/keybindings` and `/workflow` slash commands still stubs** — infrastructure is present (keybinding resolver from L31) but REPL integration + workflow scripts system are separate larger lanes.
4. **Hook contract still 2-type** — Claude Code has prompt/http/agent hook variants beyond the current command/callback pair.
5. **Thinking blocks silently dropped on missing signature** — we now log a warning (R3.1) but don't recover the content. Recovery path is a provider-level change.

## Re-audit target

The next Codex audit should measure the following dimension deltas:

| Dimension | R3 score | R5 expected | Rationale |
|---|---|---|---|
| 1. Runtime core | 84% | 90%+ | R5.3 token-aware + R5.6 tool-type microcompact close the compact gap |
| 3. Tools infrastructure | 74% | 80%+ | R5.7 TodoWrite + R5.2 sandbox deep-wiring |
| 4. Permissions | 80% | 85%+ | R5.2 ignoreViolations fully wired |
| 5. Subagents + orchestration | 76% | 85%+ | R5.4 cache-safe fork + R5.5 agent schema match Claude's field set |
| 7. Config + extensibility | 70% | 80%+ | R5.1 + R4.1 output style full main-loop integration |

Weighted target: **85%+ overall** (from 80%). Still short of the 95% cron-cancel threshold; Round 6 will need to target the remaining depth gaps (Bash AST parsing, full hook contract, REPL Ink integration, workflow scripts).
