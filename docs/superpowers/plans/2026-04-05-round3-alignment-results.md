# Round 3 Capability Alignment Results

Date: 2026-04-05
Branch: `feat/core-alignment`
Round 2 results: `docs/superpowers/plans/2026-04-05-round2-alignment-results.md`
Round 3 plan: `docs/superpowers/plans/2026-04-05-round3-alignment.md`

---

## Summary

**17 lanes landed in a single continuous push (Phase A follow-ups + Phase B new capabilities).** Strict serial dispatch in main checkout, 100% reliability — zero pollution incidents, zero stash recoveries.

| Metric | Round 2 end | Round 3 end | Δ |
|---|---|---|---|
| Tests passing | 1084 | **1301** | **+217** |
| Failures | 0 | **0** | — |
| Typecheck errors | 0 | **0** | — |
| Commits on `feat/core-alignment` since R2 | 0 | **20** | +20 (7 Phase A + 11 Phase B + 2 cross-package fixes) |

## Phase A — Round 2 follow-ups cleaned (7 commits)

| Lane | Commit | Scope |
|---|---|---|
| R3.1 | `8c37187` | unify `effortToBudget`/`thinkingBudgetFromEffort` + log dropped unsigned thinking blocks |
| R3.2 | `ac73f95` | relocate `ToolAnnotations` to `@open-agent/core` (eliminate `ToolAnnotationsRef` mirror) |
| R3.3 | `7ab1c96` | wire `ConversationLoop.messages` → `engine.setRecentUserMessages()` for classifier |
| R3.4a | `e000f3e` | real `/plugins` + `/version` slash command implementations (no more stubs) |
| R3.4b | `957bc16` | `supportsThinking`/`getContextWindowForModel` wired into `OpenAIProvider` |
| R3.5 | `6c03d61` | `loadUserSkills()` + user slash commands from `~/.claude/commands/*.md` |
| R3.6 | `beaf0de` | persist `FileHistoryStore` snapshots to session JSONL (survive restart) |

All 8 Round 2 follow-ups closed.

## Phase B — New capability lanes (11 + 2 fixes)

| Lane | Commit | Scope |
|---|---|---|
| **L36** | `1f4a49c` | `mcpInfo: { serverName, toolName }` metadata on `ToolDefinition` + `mcp__<server>__<tool>` normalization + `CLAUDE_AGENT_SDK_MCP_NO_PREFIX` env flag |
| **L26** | `b0ae9e0` | `McpManager.readResource(serverName, uri)` + `@mcp://server/path` URI parser/resolver |
| **L27** | `4b1739b` | `McpManager.subscribeResource()` + `unsubscribeResource()` + `resources/updated`/`list_changed` dispatch |
| **L37** | `1d9c9dc` | `McpServerState` with per-server enable/disable + policy override + snapshot/restore |
| **L33** | `c816d38` | `searchSessions(sessions, query, currentCwd)` with keyword ranking + recency bonus + `crossProject` detection + resume hint builder |
| **L31** | `f78ed95` | keybindings system: types + 20 defaults + parser + resolver (chord + Global fallback + delete-via-empty) + `~/.claude/keybindings.json` loader |
| **L28** | `ff14ed8` | MCP Elicitation protocol: `ElicitationManager` with pluggable adapter + timeout + in-flight tracking + `onServerElicitation()` public method (SDK schema fallback) |
| **L29** | `cd28fd5` | output styles: `BUILTIN_OUTPUT_STYLES` (default/verbose/terse) + `loadOutputStyles()` + `mergeOutputStyles()` + `/output-style` slash command |
| **L34** | `9945724` | LLM-based auto-compact: `MessageSummarizer` interface + `llmAutocompact()` split-summarize-replace + `shouldTriggerProactiveAutocompact()` + `ConversationLoop.setAutoCompactPolicy('proactive')` wiring |
| **L30** | `ec8282c` | Darwin sandbox profile builder (SBPL s-expressions) + `wrapWithDarwinSandbox()` sandbox-exec runner + platform guard |
| **L38** | `24520aa` | sandbox meta-policy: `ignoreViolations` rules with glob patterns + `enabledPlatforms` gate + `enforceManagedReadPathsOnly` |
| fix | `de32226` | **Real bug** fixed in `packages/runtime/src/index.ts`: L36 caused `mcp__demo__mcp__demo__echo` double-prefix in `resolveMcpToolName` namespaced branch, plus `callTool` was using the prefixed name as dispatch key (should be bare). Both fixed. |
| test | `e96b63c` | update 10 runtime/sdk/permissions test assertions for L36 prefix naming |

## Execution quality

- **Serial main-checkout dispatch was 100% reliable** across all 17 lanes — zero pollution incidents, zero mid-lane stops, zero stash recoveries. The dispatch model learned from Round 1 (8 parallel worktree lanes, 3 polluted main) has now been validated twice (Round 2 + Round 3).
- **Average lane completion:** ~2.5 minutes (11 Phase B + 6 Phase A = 17 lanes in ~45 min of subagent wall time).
- **Real bugs caught during integration gate:** L36 (R3 Phase B) caused a double-prefix bug in `runtime/src/index.ts` that existing tests failed to catch. The integration gate caught it because 10 cross-package tests broke. Fix was 3 lines of production code + test updates. This is exactly the value of running the full suite at the end of each phase.
- **Feature-flag gating held up:** L14's `feature()` registry continued to gate L22/L23/L28/L29/L34 lanes cleanly — defaults are safe, opt-in via `OPEN_AGENT_FEATURE_*` env vars.

## Known follow-ups (deferred to Round 4)

1. **Output style system prompt injection** (L29) — `style.instructions` are loaded and surfaced via `/output-style`, but ConversationLoop doesn't yet inject them into the system prompt. Requires touching `system-prompt.ts` + a "current style" state in context.
2. **Keybindings ink/REPL wiring** (L31) — the resolver is ready but no terminal input loop consumes it yet. A future Ink integration should attach `keypress` events → `KeybindingResolver.resolve()` → action dispatcher.
3. **MCP Elicitation SDK-level request handler** (L28) — falls back to `onServerElicitation()` public method because the installed SDK doesn't yet export `ElicitationCreateRequestSchema`. Will auto-activate when SDK ships the schema.
4. **Session search `/resume` slash command wiring** (L33) — `searchSessions` + `buildCrossProjectResumeHint` are exported from `@open-agent/core` but no `/resume` slash command exists to consume them.
5. **Darwin sandbox → Bash tool wiring** (L30) — `wrapWithDarwinSandbox` is infrastructure; Bash tool doesn't yet use it when sandbox mode is on. Next lane should make `bash.ts` check `isDarwinSandboxAvailable()` + wrap the command.
6. **Ignore-violations rule integration** (L38) — `filterIgnoredFindings` exists but isn't called from the bash execution pipeline. Wire it into whatever post-execution scan produces `BashSandboxExecutionFinding[]`.
7. **LLM summarizer real wiring** (L34) — `NOOP_SUMMARIZER` is the default; wiring a real provider-backed summarizer (calls Anthropic/OpenAI with a "summarize this conversation" prompt) is a natural follow-up.
8. **MCP resource subscribe HTTP transport** (L27) — stdio and SSE transports support notifications; HTTP is stateless JSON-RPC and can't receive server-pushed events. This is a protocol limitation, not a code gap — could add polling as a workaround.

## Cumulative state (Rounds 1-3)

**55 commits** on `feat/core-alignment` covering **41 distinct capability gaps** (L1-L38 + R3.1-R3.6 follow-ups). **1301 tests passing, 0 failures, 0 typecheck errors.**

The alignment now covers, end-to-end:

- **Session + Runtime**: JSONL sessions, CLAUDE.md chain, layered compact (snip+micro+LLM+reactive), file history with `/rewind`, fork subagents with sidechain, prompt cache dual boundary
- **Providers**: Anthropic with extended thinking budget, OpenAI with capability gating, model capability registry
- **Permissions**: 5-step pipeline, 6-layer settings, plan mode downgrade, transcript classifier, ExitPlanModeV2 semantic permissions, sandbox meta-policy
- **Tools**: 28+ tool factories with full Tool contract (annotations/render/interrupt/etc.), ToolSearch with `shouldDefer`, persistent Bash PTY via Node.js bridge, Darwin sandbox profile
- **MCP**: tool `mcpInfo` + prefix mode, `readResource` + URI attachments, resource `subscribe`, per-server enable/disable, elicitation protocol
- **Slash commands**: 35+ commands including `/effort /thinking /insights /env /plugins /version /output-style`
- **Config**: feature flags, frontmatter parser, markdown config loaders for agents/skills/commands/output-styles
- **Other**: hook asyncTimeout, stream JSON SDK protocol, keybindings resolver, session search + cross-project detection
