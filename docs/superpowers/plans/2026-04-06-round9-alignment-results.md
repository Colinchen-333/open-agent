# Round 9 Capability Alignment Results

Date: 2026-04-06
Branch: `feat/core-alignment`
Triggered by: Codex audit #3 returned 70% — target is 95%
Prior results: `docs/superpowers/plans/2026-04-06-round8-alignment-results.md`

---

## Summary

Round 9 targeted all 5 Codex recommendations from audit #3. 5 serial lanes covered MCP depth, runtime core, permissions, tools, and CLI.

| Metric | R8 end | R9 end | Δ |
|---|---|---|---|
| Tests passing | 1958 | **2015** | **+57** |
| Failures | 6 | **6** (same pre-existing) | — |
| Typecheck errors | 0 | **0** | — |
| Commits since R8 | 0 | **7** | — |

## Round 9 lanes

| Lane | Commit | Scope |
|---|---|---|
| R9.1 | `b80fbf1` | Context-collapse tracking: ContextCollapseCommit/Snapshot types, recordCommit/Error/Empty, stageCollapse/flushStaged, subscribe/restore, health stats. 10 tests. |
| R9.2 | `0abc4a8` | NDJSON stdin reader: readNdjsonStream async generator with buffering, JSON validation, type filtering. 9 tests. |
| R9.3 | `3862e8f` | Classifier telemetry (stage/durationMs/rawLlmResponse/toolCategory on ClassifierDecision) + domain-aware bwrap sandbox (SANDBOX_ALLOWED_DOMAINS/DENIED env vars). 17 tests. |
| R9.4 | `5798f04` | ToolDefinition expanded: searchHint (wired to 7 tools), isEnabled (wired to ConversationLoop filter), toAutoClassifierInput (wired to Bash), checkPermissions. 5 tests. |
| R9.5 | `4fefeef` | MCP prompt discovery (listPrompts/getPrompt/getAllPrompts on manager, 3 transports), sampling handler (createSamplingHandler factory), prompt namespacing (mcp__server__name). 14 tests. |

## Known follow-ups (for next round)

1. **MCP OAuth** — Claude Code has 2466-line auth.ts with OAuth flows, XAA (SEP-990), headersHelper. OpenAgent has zero auth.
2. **MCP WebSocket transport** — Claude Code supports `ws` and `ws-ide`. OpenAgent only has stdio/sse/http.
3. **MCP channel permission relay** — Claude Code relays permission prompts to messaging channels (242 lines). 
4. **Tool validateInput** — Pre-execution validation hook missing from OpenAgent.
5. **Tool mapToolResultToToolResultBlockParam** — SDK result format conversion.
6. **Dynamic tool description/prompt** — Claude Code generates context-aware descriptions; OpenAgent uses static strings.
7. **Tree-sitter bash parser** — Current tokenizer handles quoting but no full AST with fail-closed node allowlisting.
8. **Sidechain wiring** — recordSidechainTranscript exists but isn't called from agent executor paths.
