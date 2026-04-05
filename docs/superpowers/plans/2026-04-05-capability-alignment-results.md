# Capability Alignment Results

Date: 2026-04-05
Branch: `feat/core-alignment`
Spec: `docs/superpowers/specs/2026-04-05-capability-alignment-design.md`
Plan: `docs/superpowers/plans/2026-04-05-capability-alignment.md`

---

## Summary

Completed the 13-lane alignment of OpenAgent with the leaked Claude Code source. 22 commits land between the baseline `8dbf557` and the final `25908eb`. All unit tests pass; one end-to-end smoke test against the real `glm-4.7` via BigModel coding endpoint confirmed the headline L8 Bash PTY persistence and multi-tool orchestration work live.

| Metric | Baseline (`8dbf557`) | Final | Δ |
|---|---|---|---|
| Tests | ~334 | **934** | **+600** |
| Failures | 0 | **0** | — |
| `tsc --noEmit` errors | 0 | **0** | — |
| New commits | — | **22** | — |

## Lanes landed

| Lane | Commit(s) | Subject |
|---|---|---|
| L1 | d0aa89e / 4420f96 / a66403a / 1238682 | JSONL session storage (see Known follow-up below) |
| L2 | 0a472c5 | CLAUDE.md lookup chain (`.claude/CLAUDE.md → CLAUDE.md → ~/.claude/CLAUDE.md`, AGENT.md fallback) |
| L3 | ea82ffc | Hook `asyncTimeout` + `hookSpecificOutput` fields + fire-and-forget executor |
| L4 | b1e8ff1 | `PermissionEngine.evaluate` → explicit 5-step pipeline (`validateInput → alwaysDeny → alwaysAllow → preToolUseHooks → classifier → prompt`) via new `pipeline.ts` |
| L5 | 0ca5aaa | 6-layer settings hierarchy (`flag > policy > project > local > user > mdm > defaults`) via `loadLayeredSettings` |
| L6 | 682299e | Subagent fork mode: `executeForked`, `createForkContext`, `SidechainWriter` persisting to `~/.open-agent/sidechain/<agentId>/messages.jsonl` |
| L7 | fd81dc6 | `shouldDefer` field on `ToolDefinition` + keyword-overlap `ToolSearch` ranking |
| L8 | 2ba7a20 / 2cadab8 / ce2b93a | Persistent Bash PTY via Node.js helper process bridge (`bash-pty-worker.js`) — Bun + native node-pty workaround |
| L9 | 84e31a2 / ee1a463 | Plan mode real downgrade: `pushMode`/`popMode` + `stageValidateInput` denies non-readonly tools |
| L10 | 01a8f3c | `ToolDefinition` expanded (10 new fields) + `withToolDefaults` helper applied to all 28 tool factories; specialized overrides on bash/read/grep |
| L11 | 401817f / 2d34ca8 / 0871d84 | Layered compact (`snip`, `microcompact`, `runCompactPipeline`) + reactive retry on `prompt_too_long` errors in `ConversationLoop` |
| L12 | 7dbeb1d | System prompt principles aligned with Claude Code verbatim text ("don't add features beyond...", "only add comments where WHY isn't self-evident", etc.) |
| L13 | 4b38e5a / 25908eb | `SystemPromptBlock[]` static/dynamic boundary + `buildAnthropicSystemParam` marking only last static block with `cache_control.ephemeral` |

## End-to-end smoke test

Against `glm-4.7` via `https://open.bigmodel.cn/api/coding/paas/v4`:

```
Session:        288e4085-43cb-408c-8b0a-f40af75f2a80
Duration:       13.9s
Turns:          5
Tool calls:     4  (Bash x2, Read, Grep)
Cost:           $0 (coding subscription)
Result:         success
```

Verified capabilities:

- **L8 Bash PTY persistence.** First Bash call `cd /tmp/oa-smoke-test && export OA_SMOKE=yes && echo > marker.txt`; second independent Bash call observed `$OA_SMOKE=yes`, correct `pwd`, and could `cat marker.txt`. The Node.js helper bridge architecture works transparently.
- **Multi-tool orchestration.** Bash + Read + Grep co-operated cleanly in one session with no error paths hit.
- **JSONL session persistence.** 20 lines written to `~/.open-agent/projects/v2-<hash32>/<sessionId>.jsonl`.
- **Clean model close.** Model returned a coherent one-line summary and `stop_reason: end_turn`.

Not exercised by the smoke session (unit-tested only): L2, L3, L4/L9 pipeline behaviour, L5, L6, L7 (MCP-dependent), L10 contract, L11 compact tiers, L12 prompt phrases, L13 cache boundary (Anthropic-specific, glm-4.7 uses OpenAI-compatible path).

## Known follow-ups (deferred)

1. **L1 dead code.** The new `SessionJsonlWriter` / `readJsonlSession` / `resolveSessionPath` in `packages/core/src/session-io.ts` and the `SessionManager.appendMessage()` method are **not wired into any call site**. `ConversationLoop` still persists via the pre-existing `SessionManager.appendToTranscript()`, which itself already produces JSONL under a hashed-cwd project key (`~/.open-agent/projects/v2-<hash32>/<id>.jsonl`). The functional goal of L1 was met by the legacy path; only the exact directory layout (a `sessions/` subdirectory, 64-char sha256 instead of 32-char prefix) differs from Claude Code. Either delete the dead code or migrate call sites if byte-exact layout parity is required.

2. **L7 ToolSearch for runtime-registered MCP tools.** L7 marked `mcp-tools.ts` helpers as `shouldDefer: true`, but `runtime/src/index.ts::createMcpToolDefinition` is the main factory for the `mcp__<server>__<tool>` wrappers and was out of L7's scope. Add `shouldDefer: true` there when the ToolSearch semantic surface is exercised for real MCP tools.

3. **`@open-agent/cli-app` build.** Pre-existing failure to resolve `react-devtools-core` (pulled in by `ink`). Not caused by this work. Fix: `bun add react-devtools-core --cwd apps/cli-app` or mark it as an optional peer dep.

4. **Wave 2 end-to-end coverage.** L11 compact tiers and L13 cache boundary are only validated at unit-test level. A long-session stress test would confirm the reactive-compact retry path fires correctly against a real API; a cache-hit delta measurement would validate the boundary marker produces real savings on repeated runs of the same project.

## Agent dispatching lessons (for future alignment work)

- **`isolation: "worktree"` on the Agent tool is not a correctness guarantee.** During Wave 1 dispatch, 3 of 8 parallel subagents leaked writes into the parent checkout despite `isolation: "worktree"`, requiring stash recovery and manual cherry-pick. L9 onward used direct main-checkout dispatch (no isolation) and was consistently reliable. Use worktree isolation as a best-effort hint, not as a guarantee; verify `git status` on the parent after each subagent completes.
- **Subagents' actual work is not always lost even if they appear to pollute main.** Stashed changes (often auto-created by concurrent `git stash` operations inside the subagent) can be recovered via `git stash list` + `git stash apply` + manual cherry-pick into lane-scoped commits. This saved L4 and L6 without re-running them.
- **Bun + native node-pty is incompatible.** Bun's runtime does not drive node-pty's libuv I/O callbacks. Persistent PTY features in Bun projects must use a Node.js child process bridge. See memory: `bun-node-pty-incompatibility.md`.
