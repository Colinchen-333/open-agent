# Round 2 Capability Alignment Plan

> **Execution mode:** Serial dispatch in main checkout. No `isolation: "worktree"` (unreliable per Round 1 lessons). Each lane runs to completion before the next starts.

**Goal:** Close 11 additional gaps (L14-L25) against the leaked Claude Code source, building on Round 1's 13-lane foundation.

**Parent:** `docs/superpowers/plans/2026-04-05-capability-alignment-results.md` (Round 1 complete, 23 commits on `feat/core-alignment`)

**Dispatch order** (selected to minimize file conflicts on shared hot files like `engine.ts`, `conversation-loop.ts`, `slash-commands.ts`):

1. **L14** Feature Flags + DCE — standalone new module
2. **L17** Slash command expansion (25→~60+) — `packages/cli/src/slash-commands.ts`
3. **L25** Model capability query — new `packages/providers/src/model-capability.ts`
4. **L24** SDK Stream JSON protocol — `packages/sdk/src/types.ts` + `packages/cli/src/stream-json.ts`
5. **L16** Markdown config loaders — `packages/agents/*`, `packages/skills/*`, shared frontmatter parser
6. **L18** `userInvocable` skill flag — depends on L16; tiny
7. **L21** MCP tool annotations — `packages/tools/src/types.ts` + `permissions/engine.ts`
8. **L22** ExitPlanModeV2 — after L21 (engine.ts overlap)
9. **L23** Transcript classifier (fills L4 stub) — after L22 (engine.ts)
10. **L19** Extended thinking budget + real invocation — `providers/anthropic.ts` + `core/conversation-loop.ts`
11. **L20** File history + rewind — biggest; `tools/edit,write`, `core/session-manager`, `cli/slash-commands` (rewind handler)

**Per-lane verification gate (applies to every lane):**
```bash
bun test packages/<touched-packages>/
bun run typecheck
bun test   # full regression last
```

All three must pass. Baseline starting state: **957 tests** (Round 1 final 934 + smoke-test adjustments), 0 typecheck errors.

---

## L14 · Feature Flags + DCE

**Files:**
- New: `packages/core/src/feature-flags.ts`
- New: `packages/core/src/__tests__/feature-flags.test.ts`
- Modify: `packages/core/src/index.ts` (re-export)

**Scope.** A tiny `feature(name): boolean` API that reads from env vars (`OPEN_AGENT_FEATURE_<NAME>=1/0`) with compile-time defaults. Enables future gating of experimental tools/commands without runtime bloat.

**API:**
```ts
type FeatureFlagName = 'REACTIVE_COMPACT' | 'TRANSCRIPT_CLASSIFIER' | 'FORK_SUBAGENT' | 'THINKING_ADAPTIVE' | 'FILE_HISTORY' | 'WORKFLOW_SCRIPTS' | 'EXIT_PLAN_MODE_V2';
export function feature(name: FeatureFlagName): boolean;
export function setFeatureDefault(name: FeatureFlagName, value: boolean): void; // test-only
export const FEATURE_FLAG_DEFAULTS: Record<FeatureFlagName, boolean>;
```

**Tests:** env var read, default fallback, setFeatureDefault override.

**Commit:** `feat(core): add feature flag registry with env-driven overrides`

---

## L17 · Slash Command Expansion

**Files:**
- Modify: `packages/cli/src/slash-commands.ts` (add handlers)
- Modify: `packages/cli/src/__tests__/slash-commands.test.ts` (add tests)

**Scope.** Add stubs or full implementations for the following commands currently missing (check existing file first — may already have some):

Priority additions:
- `/effort` — cycle through effort levels (low/medium/high/max)
- `/thinking` — toggle thinking mode (off/adaptive/enabled)
- `/plugins` — list loaded plugins
- `/workflow` — show workflow status (stub OK if workflow system not built)
- `/keybindings` — print current keybindings (stub OK if L15 not done)
- `/insights` — session insights (cost, tokens, tool usage)
- `/upgrade` — check for newer open-agent version (stub)
- `/version` — print version
- `/env` — print environment info

Each new command: handler function + registry entry + test case asserting output structure.

**Commit:** `feat(cli): expand slash commands with effort/thinking/insights/env and stubs`

---

## L25 · Model Capability Query

**Files:**
- New: `packages/providers/src/model-capability.ts`
- New: `packages/providers/src/__tests__/model-capability.test.ts`
- Modify: `packages/providers/src/index.ts` (re-export)

**Scope.** Per-model metadata record + query APIs:
```ts
interface ModelCapability {
  contextWindow: number;       // tokens
  maxOutput: number;
  supportsThinking: boolean;
  supportsVision: boolean;
  supportsPromptCaching: boolean;
}
export function getModelCapability(model: string): ModelCapability | null;
export function supportsThinking(model: string): boolean;
export function getContextWindowForModel(model: string): number;
```

**Known models to hardcode (with accurate metadata):**
- `claude-opus-4`, `claude-opus-4-6`, `claude-sonnet-4`, `claude-sonnet-4-6`, `claude-haiku-4-5`
- `claude-3-5-sonnet`, `claude-3-5-haiku`, `claude-3-opus`
- `gpt-4o`, `gpt-4o-mini`, `gpt-5`
- `glm-4.7`, `glm-4`, `glm-4-flash`
- Unknown → return null → caller falls back to safe defaults (200k context, no thinking)

**Tests:** lookup hit, lookup miss, thinking predicate, context window predicate.

**Commit:** `feat(providers): add model capability registry with runtime queries`

---

## L24 · SDK Stream JSON Protocol

**Files:**
- Modify: `packages/sdk/src/types.ts` (refine SDKMessage union if needed)
- Modify or create: `packages/cli/src/stream-json.ts`
- Modify: `packages/cli/src/__tests__/stream-json.test.ts`

**Scope.** Ensure `stream-json.ts` emits exactly one JSON line per SDKMessage to stdout, with no ANSI, no partial writes. Add `--stream-json` flag routing in CLI entry point if not present.

**Format per Claude Code:**
```jsonl
{"type":"user","message":{"role":"user","content":"..."}}
{"type":"assistant","message":{"role":"assistant","content":[...]}}
{"type":"system","subtype":"init","session_id":"...","model":"...","cwd":"..."}
{"type":"result","subtype":"success","duration_ms":...,"total_cost_usd":...}
```

**Tests:** roundtrip JSON parse, type discriminator covers all SDKMessage variants, no TTY color codes in output.

**Commit:** `feat(cli): align stream-json output with Claude Code SDK protocol`

---

## L16 · Markdown Config Loaders

**Files:**
- New: `packages/core/src/frontmatter.ts` (YAML frontmatter parser shared util)
- New: `packages/core/src/__tests__/frontmatter.test.ts`
- New: `packages/core/src/markdown-config-loader.ts` (generic loader for `<subdir>/*.md` with layered precedence)
- New: `packages/core/src/__tests__/markdown-config-loader.test.ts`
- Modify: `packages/agents/src/agent-loader.ts` (use new loader for `agents/*.md`)
- Modify: `packages/skills/src/index.ts` (use new loader for `skills/*.md`)
- Modify: `packages/cli/src/slash-commands.ts` (use new loader for user `commands/*.md`)

**Scope.** 
- Frontmatter parser: reads `---\nkey: value\n---\n<body>` → `{ frontmatter: object, body: string }`. Use a minimal YAML subset (flat keys, strings, booleans, arrays of strings) — no need to pull in a full YAML lib.
- Markdown loader: given a subdir name ('agents' | 'commands' | 'skills'), scans `~/.claude/<subdir>/*.md` and `<cwd>/.claude/<subdir>/*.md`, parses frontmatter, deduplicates by file name (project overrides user), returns list.
- Agent loader refactor: replace its bespoke loading with the shared loader.
- Skill registry: add custom skill loading from disk on top of bundled skills.
- Slash commands: scan `commands/*.md` and register each as a `/<name>` handler that emits the body as a user message.

**Tests:** 
- Frontmatter parse + body extraction
- Loader precedence (project > user)
- Loader dedup by filename
- Agent loading end-to-end
- Custom skill loading end-to-end

**Commit:** `feat(core): add markdown config loaders for user-defined agents/commands/skills`

---

## L18 · `userInvocable` Skill Flag

**Files:**
- Modify: `packages/skills/src/types.ts` (add `userInvocable?: boolean`)
- Modify: `packages/skills/src/index.ts` (respect flag in list)
- Modify: `packages/cli/src/slash-commands.ts` (filter `/skills` output)
- Modify: tests for both

**Scope.** Tiny. Add optional boolean field to Skill metadata, default true. Frontmatter key `userInvocable: false` hides from `/skills` list and blocks `/<name>` user invocation (the skill can still be invoked internally by agents).

**Commit:** `feat(skills): add userInvocable flag for hiding internal-only skills`

---

## L21 · MCP Tool Annotations

**Files:**
- Modify: `packages/tools/src/types.ts` (add `annotations?` field to ToolDefinition)
- Modify: `packages/tools/src/mcp-tools.ts` (propagate MCP annotations)
- Modify: `packages/mcp/src/tool-info.ts` (extract annotations from MCP listTools response)
- Modify: `packages/permissions/src/engine.ts` (`stageValidateInput` consults annotations.destructive)

**Scope.**
```ts
interface ToolAnnotations {
  readOnly?: boolean;
  destructive?: boolean;
  openWorld?: boolean;
  idempotent?: boolean;
}
// ToolDefinition.annotations?: ToolAnnotations
```
MCP `listTools` response already includes this per MCP spec 2024-11-05. Propagate from MCP response into runtime ToolDefinition. Bash, Write, Edit get `destructive: true` hardcoded. Read, Grep, Glob, WebFetch, WebSearch get `readOnly: true`. Permission pipeline's `stageValidateInput` checks `destructive` to bump risk level.

**Tests:** annotations round-trip through MCP tool wrapper; permission pipeline respects destructive flag.

**Commit:** `feat(tools): add MCP-aligned tool annotations (readOnly/destructive/openWorld)`

---

## L22 · ExitPlanModeV2

**Files:**
- Modify: `packages/tools/src/plan-mode.ts` (add V2 variant)
- Modify: `packages/permissions/src/engine.ts` (accept semantic permission requests)
- Modify: `packages/tools/src/__tests__/plan-mode.test.ts`

**Scope.** New `ExitPlanModeV2` tool factory that accepts `allowedPrompts: Array<{ tool: string; prompt: string }>` — semantic permission requests (e.g., `{ tool: 'Bash', prompt: 'run tests' }`) rather than exact command matches. When exiting plan mode, these are registered as allow rules in the permission engine. The classifier (L23) then evaluates actual tool calls against these semantic permissions.

**Compat.** Keep V1 `ExitPlanMode` available behind `feature('EXIT_PLAN_MODE_V2')` flag (L14).

**Commit:** `feat(tools): add ExitPlanModeV2 with semantic permission requests`

---

## L23 · Transcript Classifier

**Files:**
- New: `packages/permissions/src/classifier.ts`
- New: `packages/permissions/src/__tests__/classifier.test.ts`
- Modify: `packages/permissions/src/engine.ts` (fill `stageClassifier` stub from L4)

**Scope.** A simple rule-based classifier (no ML) that evaluates a permission request's semantic intent against recent transcript context. Rules:
- If tool is readOnly annotated → auto-allow
- If recent user message contains explicit approval phrases ("yes", "go ahead", "continue") → allow
- If tool has `allowedPrompts` registered from L22 and current input matches semantically → allow
- Otherwise → pass-through (return undefined, let the pipeline continue to the prompt stage)

Semantic matching: simple keyword overlap (no embedding). Good enough for rule-based classifier v1.

**Feature gate:** only active when `feature('TRANSCRIPT_CLASSIFIER')` is true.

**Tests:** readOnly auto-allow, explicit approval detection, semantic match against allowedPrompts, no-match pass-through.

**Commit:** `feat(permissions): implement transcript classifier for auto-approve stage`

---

## L19 · Extended Thinking Budget + Real Invocation

**Files:**
- Modify: `packages/providers/src/anthropic.ts` (add `max_thinking_length` to API call, wire `thinking` param into body)
- Modify: `packages/providers/src/types.ts` (if `ThinkingConfig` needs budget field)
- Modify: `packages/core/src/conversation-loop.ts` (pass thinking config through)
- Modify: `packages/providers/src/__tests__/anthropic.test.ts`

**Scope.** Currently `ThinkingConfig` exists in types but `AnthropicProvider.chat()` doesn't actually send `thinking` in the API request body. Fix:
- Add `thinking: { type: 'enabled', budget_tokens: N }` to the Anthropic API request when enabled.
- N is derived from effort level: low=8k, medium=16k, high=32k, max=60k (conservative defaults).
- Ensure thinking blocks are preserved in the message trajectory (they must stay in assistant turns for follow-up thinking to work).
- When provider doesn't support thinking (per L25 `supportsThinking` query), silently drop the config.

**Tests:** thinking request body shape, budget derivation, non-supporting-model fallback.

**Commit:** `feat(providers): wire extended thinking budget into Anthropic API calls`

---

## L20 · File History + Rewind

**Files:**
- New: `packages/core/src/file-history.ts` (backup store + snapshot API)
- New: `packages/core/src/__tests__/file-history.test.ts`
- Modify: `packages/tools/src/write.ts` (call fileHistoryTrackEdit before write)
- Modify: `packages/tools/src/edit.ts` (call fileHistoryTrackEdit before edit)
- Modify: `packages/core/src/session-manager.ts` (persist snapshots to session JSONL)
- Modify: `packages/cli/src/slash-commands.ts` (`/rewind <n>` actually restores files)

**Scope.** Before any Write/Edit, capture current file content → push backup into `FileHistoryStore` keyed by session + message UUID. Snapshot contains `{ sessionId, messageUuid, filePath, prevContent, timestamp }`. On `/rewind <n>`, find the Nth-most-recent snapshot, restore file content, emit a system message describing the restore.

Max 100 snapshots per session (FIFO eviction). Snapshots serialized into session JSONL as `{ type: 'file_history_snapshot', ... }` lines so they survive session restart.

**Tests:** 
- backup capture on write
- backup capture on edit
- rewind 1 turn restores most recent
- rewind 3 turns restores older
- eviction at 100 snapshots
- session JSONL roundtrip

**Commit:** `feat(core): add file history with turn-level attribution and /rewind restore`

---

## Integration Gate (after all 11 lanes merge)

```bash
bun test                 # expect 980+ pass / 0 fail
bun run typecheck        # clean
bun run build            # clean (except pre-existing cli-app)
```

Then a short smoke against real glm-4.7 API exercising any of the new capabilities that are reachable via a REPL-style session (L17 new commands, L19 thinking if provider accepts, L20 file history via Edit + /rewind).

---

## Rollback strategy

- Every lane is a single commit (or small atomic group). If a lane breaks something unrelated, `git revert <sha>` isolates damage.
- If the entire round goes sideways, `git reset --hard c10dad3` restores Round 1 end state.
- Nothing is force-pushed.
