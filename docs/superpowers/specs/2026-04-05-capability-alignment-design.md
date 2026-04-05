# Capability Alignment with Leaked Claude Code Source

Date: 2026-04-05
Status: Draft (awaiting user review)
Prerequisite: `2026-04-01-core-alignment-design.md` (Phases A-D: State / Messages / ToolExecutor / Ink UI) — already in flight, continues in parallel

---

## Context

The 04-01 spec covered **architectural** alignment (reactive store, message type system, streaming executor, React/Ink UI). It is currently being implemented; several packages (`state`, `ink`, `runtime`, `agents`) have landed substantial work.

On 2026-04-04 the official Claude Code source code was leaked and is now available at `/Users/colin/Projects/ai/research/claude-code-reverse/claude-code-nirholas`. A two-sided inventory (both our codebase and the leaked source) identified **13 capability / behavior gaps** that are orthogonal to 04-01:

- 04-01 makes the plumbing right (state, messages, executor, renderer)
- 04-05 makes the runtime behavior match Claude Code's (prompt caching, context management, hook contract, permission pipeline, subagent semantics, etc.)

Both specs can progress concurrently because they touch mostly non-overlapping files. Known overlap is documented in §WIP Handling.

---

## The 13 Gaps

Each gap is sized so one subagent can own it end-to-end.

### P0 · Foundation (5 gaps — maximum leverage)

#### Gap 1 — Prompt Cache Dual Boundary
**Problem.** `AnthropicProvider` emits `cache_control` blocks but has no explicit static/dynamic boundary. Session-specific content can poison the static cache. No `scope: 'global' | 'ephemeral'` split.

**Target.** Reproduce Claude Code's `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` pattern:
- Static prefix (identity, tool descriptions, invariant guidance) → `cache_control: { type: 'ephemeral', scope: 'global' }`
- Dynamic suffix (project info, CLAUDE.md, git state, session ID) → `cache_control: { type: 'ephemeral' }` (no scope, session-local)
- Marker function `insertDynamicBoundary(blocks)` inserted by `buildSystemPrompt()` at the exact transition point

**Files.** `packages/providers/src/anthropic.ts`, `packages/core/src/system-prompt.ts`, `packages/core/src/runtime-prompt-sections.ts`

**Verification.** Unit test asserts cache_control positions; integration test logs cache hits with real API.

---

#### Gap 2 — Layered Auto-Compact
**Problem.** `ConversationLoop.compactInternal()` is a single-shot full-history summarizer. No microcompact, no reactive compact on 413 errors, no snip strategy.

**Target.** Four compact tiers matching Claude Code:
1. **snip** — drop tool_result blocks older than N turns, keep tool_use blocks (prunes bulk without losing intent)
2. **microcompact** — per-`tool_use` result truncation when result exceeds `maxResultSizeChars`, replaced with `<result truncated — use Read to retrieve full content>` pointer
3. **autocompact** — current behavior, triggered at `compactThreshold`
4. **reactive compact** — on `prompt_too_long` API error, trigger compact + retry (no user intervention)

**Files.** `packages/core/src/conversation-loop.ts`, new `packages/core/src/compact/` directory (`snip.ts`, `microcompact.ts`, `autocompact.ts`, `reactive.ts`)

**Verification.** Each tier has a unit test; integration test simulates 413 retry.

---

#### Gap 3 — System Prompt Static Text Alignment
**Problem.** `packages/core/src/system-prompt.ts` is 2500+ lines but predates the leaked source. Several Claude Code principles are missing or differently worded:
- "Don't add features beyond what was asked"
- "Default to writing no comments. Only when WHY is non-obvious."
- "Before reporting a task complete, verify it actually works."
- "Never claim 'all tests pass' when output shows failures."
- "Don't add error handling for scenarios that can't happen."

**Target.** Line-by-line diff of `system-prompt.ts` against `claude-code-nirholas/src/constants/prompts.ts` and `systemPromptSections.ts`. Each official principle must be present (verbatim or paraphrased) unless we have a documented reason to drop it.

**Files.** `packages/core/src/system-prompt.ts`, `packages/core/src/runtime-prompt-sections.ts`

**Verification.** Grep checklist of required phrases. Snapshot test of assembled system prompt with fixed inputs.

---

#### Gap 4 — Session Storage → JSONL
**Problem.** `SessionManager` stores sessions as whole JSON files in `~/.open-agent/sessions/`. Claude Code uses per-message JSONL in `~/.claude/projects/[hash]/sessions/[id].jsonl` — incremental append, crash-safe, tail-recoverable.

**Target.** 
- Session path: `~/.open-agent/projects/[sha256(cwd)]/sessions/[sessionId].jsonl`
- Write mode: append each message as a JSON line on emission (not at session end)
- Read mode: stream lines, parse, reconstruct state
- Migration: detect old single-file sessions on load, migrate in place
- `recordTranscript()` function matching Claude Code's interface

**Files.** `packages/core/src/session-manager.ts`, new `packages/core/src/session-io.ts`

**Verification.** Unit tests for append, crash-recovery, migration. Integration test that kills a session mid-turn and resumes.

---

#### Gap 5 — Hook Contract Alignment
**Problem.** `HookExecutor` exists but the stdin/stdout JSON schema and async semantics don't match Claude Code's format. Users' existing Claude Code hooks wouldn't run unmodified.

**Target.** Exact contract match:
- **stdin JSON**: `{ hookEvent, toolName, toolUse: { id, input }, message, additionalContext }`
- **stdout JSON**: `{ continue, decision: 'approve'|'block', updatedInput, additionalContext, systemMessage, hookSpecificOutput }`
- Support `asyncTimeout` for non-blocking hooks (run in parallel with tool execution)
- Event enum: `PreToolUse / PostToolUse / UserPromptSubmit / SessionStart / SubagentStart / PermissionDenied / PermissionRequest / Notification / Elicitation / FileChanged / CwdChanged / Stop / SubagentStop`

**Files.** `packages/hooks/src/hook-executor.ts`, `packages/hooks/src/types.ts`, `packages/core/src/conversation-loop.ts` (trigger points)

**Verification.** Unit tests for stdin/stdout roundtrip. Integration test with real shell hook script reading stdin and writing stdout.

---

### P1 · Capability (5 gaps — enables new behaviors)

#### Gap 6 — Permission 5-Step Pipeline
**Target.** `validateInput → alwaysDeny → alwaysAllow → PreToolUse hooks → classifier → prompt`. Current engine jumps straight from rule matching to prompt. Missing: validateInput gate, classifier stub (even if classifier is placeholder, the pipeline shape must be present for future hookability).

**Files.** `packages/permissions/src/engine.ts`, `packages/permissions/src/pipeline.ts` (new)

---

#### Gap 7 — Subagent Fork Mode + Sidechain
**Target.** 
- `createForkContext()` clones parent `toolPermissionContext` + messages snapshot
- Fork mode runs in background, does NOT populate parent message history
- Sidechain persistence: `~/.open-agent/sidechain/[agentId]/messages.jsonl`
- `SendMessage` tool routes parent↔fork communication via sidechain

**Files.** `packages/agents/src/agent-runner.ts`, `packages/agents/src/agent-executor.ts`, `packages/agents/src/fork-context.ts` (new), `packages/agents/src/sidechain.ts` (new)

**⚠️ Overlaps with current WIP** — see §WIP Handling.

---

#### Gap 8 — ToolSearch Semantic + Deferred Tools
**Target.**
- Add `shouldDefer?: boolean` to `ToolDefinition`
- MCP tools default to `shouldDefer: true` (discovered but not loaded)
- `ToolSearchTool` accepts natural language query, returns matching tool schemas to be loaded into the current turn
- Ranking: keyword overlap (Phase 1) → embedding-based (Phase 2 follow-up, not in this spec)

**Files.** `packages/tools/src/tool-search.ts`, `packages/runtime/src/capability.ts`, `packages/tools/src/types.ts`

---

#### Gap 9 — Tool Interface Depth
**Target.** Expand `ToolDefinition` to match Claude Code's `Tool` contract:
- `preparePermissionMatcher(input) → (pattern: string) => boolean` for lazy compile of per-tool permission patterns
- `renderToolUseMessage / renderToolResultMessage / renderToolUseProgressMessage / renderToolUseErrorMessage` (React.ReactNode in ink, plain string in cli renderer)
- `extractSearchText(output) → string` for session search
- `isResultTruncated(output) → boolean`
- `maxResultSizeChars: number`
- `interruptBehavior: 'cancel' | 'block'`
- `isSearchOrReadCommand(input) → { isSearch, isRead, isList }` (for permission classifier)
- `backfillObservableInput(input) → void`

All 28 existing tools updated; default implementations provided where behavior is obvious.

**Files.** `packages/tools/src/types.ts`, all 28 files in `packages/tools/src/*.ts`

---

#### Gap 10 — CLAUDE.md Lookup Chain
**Target.** Official order: `$PWD/.claude/CLAUDE.md → $PWD/CLAUDE.md → ~/.claude/CLAUDE.md`. Current impl walks AGENT.md differently. Preserve AGENT.md as a fallback alias but prioritize CLAUDE.md per official precedence.

**Files.** `packages/core/src/config-loader.ts`, `packages/core/src/context-providers.ts`

---

### P2 · Polish (3 gaps — feature completeness)

#### Gap 11 — Plan Mode Real Downgrade
**Target.** When `EnterPlanMode` runs, the permission engine actually downgrades to read-only mode: all write/edit/bash/execute tools return `deny`. `ExitPlanMode` restores previous mode.

**Files.** `packages/tools/src/enter-plan-mode.ts`, `packages/tools/src/exit-plan-mode.ts`, `packages/permissions/src/engine.ts`

---

#### Gap 12 — Bash Persistent PTY
**Target.** Replace per-call `spawn()` with `node-pty` pseudoterminal persisted across calls within a session. State (cwd, env, shell history, shell functions) survives between tool_use invocations.

**Files.** `packages/tools/src/bash.ts`, new `packages/tools/src/bash-pty.ts`

**Risk.** `node-pty` is a native module; may require platform-specific binary handling. Verify Bun compatibility first.

---

#### Gap 13 — Settings 6-Layer Hierarchy
**Target.** `flag → policy → project → local → user → mdm(macOS) → defaults`, deep-merge with precedence. Current impl only covers user + project.

**Files.** `packages/permissions/src/settings-loader.ts`, `packages/core/src/config-loader.ts`

---

## Execution Strategy: Wave-based Parallelism with Worktree Isolation

### Wave 1 — 9 fully parallel lanes (zero file conflicts)

Each lane launches in its own `git worktree` branched from the current HEAD of `feat/core-alignment`:

| Lane | Gap | Primary files |
|---|---|---|
| L1 | #4 Session JSONL | `packages/core/src/session-manager.ts`, new `session-io.ts` |
| L2 | #10 CLAUDE.md chain | `packages/core/src/config-loader.ts` |
| L3 | #5 Hook contract | `packages/hooks/**` |
| L4 | #6 Permission pipeline | `packages/permissions/src/engine.ts`, new `pipeline.ts` |
| L5 | #13 Settings 6 layers | `packages/permissions/src/settings-loader.ts` |
| L6 | #7 Subagent fork | `packages/agents/src/*` (⚠️ WIP overlap) |
| L7 | #8 ToolSearch semantic | `packages/tools/src/tool-search.ts`, `runtime/capability.ts` |
| L8 | #12 Bash PTY | `packages/tools/src/bash.ts`, new `bash-pty.ts` |
| L9 | #11 Plan mode downgrade | `packages/tools/src/enter-plan-mode.ts` + `permissions/engine.ts` |

**Note on L4/L5/L9 all touching `permissions/engine.ts`:** L4 refactors the evaluate pipeline, L9 adds a mode downgrade hook into that pipeline, L5 is in a different file (`settings-loader.ts`). L4 and L9 will merge sequentially (L4 first, L9 rebases onto L4's worktree).

### Wave 2 — 4 sequential lanes (core hot files, semantic dependencies)

| Order | Lane | Gap | Dependency |
|---|---|---|---|
| 1 | L10 | #9 Tool interface depth | None (but huge change — 28 files) |
| 2 | L11 | #2 Auto-compact layering | Depends on L10 (`maxResultSizeChars` from Tool contract) |
| 3 | L12 | #3 System prompt alignment | None structurally, but L13 must see final text |
| 4 | L13 | #1 Prompt cache boundary | Depends on L12 (boundary placement in finalized prompt text) |

Each Wave 2 lane still runs in its own worktree, but the next lane only starts after the previous merges.

### Verification gate (applied to every lane)

Before a lane is merged:
```bash
bun test                # all suites green
bun run typecheck       # tsc --noEmit clean
bun run build           # bundle success
```

Lane-specific tests (enumerated per-gap above) must also pass.

### Integration gate (after all 13 lanes merge)

1. Full suite: `bun test` (expect 334+ growing to ~400 with new tests)
2. Typecheck clean
3. End-to-end smoke test: `bun run dev -- --provider openai --api-key ... --base-url https://open.bigmodel.cn/api/coding/paas/v4 --model glm-4.7` with a non-trivial multi-tool prompt, verifying:
   - Session file written as JSONL
   - CLAUDE.md loaded from correct path
   - Prompt cache boundary visible in API logs
   - At least one compact tier exercised (either snip or microcompact)

---

## WIP Handling

Current uncommitted changes on `feat/core-alignment`:

```
M packages/agents/src/agent-executor.ts      ← L6 overlap
M packages/agents/src/agent-runner.ts        ← L6 overlap
M packages/agents/src/__tests__/agent-runner.test.ts
M packages/cli/src/task-command-helpers.ts
M packages/cli/src/__tests__/task-command-helpers.test.ts
M packages/sdk/src/__tests__/query-handle-methods.test.ts
M packages/state/src/app-state.ts
M packages/state/src/control-plane.ts
?? packages/sdk/src/__tests__/query-task-dispatch.test.ts (new file)
```

**Strategy:**
1. Before any worktree is created, commit current WIP as a single checkpoint commit with message `chore(checkpoint): WIP before 04-05 capability alignment`. This ensures all worktrees branch from a state that includes the WIP work. **User must explicitly approve this commit when the plan is executed — not now.**
2. L6 subagent is briefed with a diff of the WIP so it knows `agentType` and `CoordinatorContext` integration already exists and should not be undone.

---

## Rollback Strategy

- Every lane is isolated in a worktree; a failed lane is abandoned by deleting its worktree
- The `feat/core-alignment` branch only advances when a lane merges cleanly
- No `push --force`, no `reset --hard`, no amending committed checkpoint
- If integration gate fails catastrophically, revert to the checkpoint commit and diagnose

---

## Out of Scope (explicitly deferred)

- **Embedding-based ToolSearch ranking** (Gap 8 Phase 2) — requires embedding model infra
- **Bridge Mode / Coordinator Mode** (remote session connection) — feature-gated in Claude Code, low utility until we have UI
- **TRANSCRIPT_CLASSIFIER** for Permission auto mode (Gap 6) — classifier is stubbed, prompt flow remains
- **Plugin lifecycle hooks** — orthogonal
- **Full slash command expansion to match Claude Code's 70+ commands** — separate spec
- **File history attribution state** — orthogonal

---

## Testing Strategy Summary

- **Unit**: every new module has tests (compact tiers, session-io, fork-context, pipeline, hook-contract, pty wrapper, plan-mode downgrade)
- **Integration**: end-to-end smoke test against real provider
- **Contract**: snapshot tests for system prompt assembly, hook stdin/stdout roundtrip
- **Regression**: all existing 334 tests must still pass

---

## Success Criteria

Upon merge of all 13 lanes:
1. A user's existing Claude Code hook script runs unmodified in OpenAgent
2. A long session (>100 turns) self-compacts without user intervention and without losing tool-use intent
3. API cost drops measurably on repeated identical-project runs (cache hit proof)
4. Crashing a session mid-turn and resuming yields a clean state from JSONL
5. Plan mode with attempted file edit returns `deny` with clear reason
