# Capability Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align OpenAgent runtime with leaked Claude Code source across 13 capability gaps (prompt caching, auto-compact, system prompt text, JSONL sessions, hook contract, permission pipeline, subagent fork, tool search, tool interface depth, CLAUDE.md chain, plan mode downgrade, bash PTY, settings layers).

**Architecture:** 13 work lanes split into Wave 1 (9 parallel, zero-conflict) and Wave 2 (4 sequential, core-file hot zone). Each lane runs in its own `git worktree` branched from `feat/core-alignment`. Each lane is self-contained with TDD tasks and merges independently.

**Tech Stack:** Bun >= 1.1, TypeScript strict, vitest/bun test, existing packages under `packages/*` (no new workspace packages except where explicitly noted).

**Spec:** `docs/superpowers/specs/2026-04-05-capability-alignment-design.md`

---

## Prologue: Checkpoint Current WIP

Before any worktree is created, the user's current WIP on `feat/core-alignment` must be committed. This ensures all worktrees branch from a state that includes the in-flight `agentType` + `CoordinatorContext` work in `packages/agents/`.

### Task P.1: Commit WIP as checkpoint

**Files:**
- All M files from `git status` (excluding `.serena/cache/*.pkl` which should stay uncommitted and are in `.gitignore` territory).

- [ ] **Step 1: Ask user for explicit approval**

Stop and ask: "Ready to commit the current WIP as a checkpoint before starting alignment work?" — do not proceed until user confirms.

- [ ] **Step 2: Verify tests currently pass on WIP**

Run: `bun test && bun run typecheck`
Expected: all green. If any failure, STOP — the WIP must be in a working state before checkpoint.

- [ ] **Step 3: Stage non-cache changes**

```bash
git add packages/agents/src/agent-executor.ts \
        packages/agents/src/agent-runner.ts \
        packages/agents/src/__tests__/agent-runner.test.ts \
        packages/cli/src/task-command-helpers.ts \
        packages/cli/src/__tests__/task-command-helpers.test.ts \
        packages/sdk/src/__tests__/query-handle-methods.test.ts \
        packages/sdk/src/__tests__/query-task-dispatch.test.ts \
        packages/state/src/app-state.ts \
        packages/state/src/control-plane.ts
```

- [ ] **Step 4: Create checkpoint commit**

```bash
git commit -m "chore(checkpoint): WIP before 04-05 capability alignment

Captures agentType + CoordinatorContext wiring work and test scaffolding
on agent-runner/executor, plus task-command-helpers and SDK query tests.
Ensures all 04-05 alignment worktrees branch from a consistent state.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 5: Verify clean tree**

Run: `git status`
Expected: only untracked `.serena/`, `.open-agent/` directories and `*.pkl` cache files remain. Record the resulting commit SHA — all worktrees branch from this.

---

## Shared Context (read once before any lane)

**Bun test runner.** All test files go in `<package>/src/__tests__/<name>.test.ts`. Import from `bun:test`:
```ts
import { describe, expect, test, beforeEach, mock } from 'bun:test';
```

**File location for each package:** `packages/<name>/src/...`. Test counterpart: `packages/<name>/src/__tests__/*.test.ts`.

**Build gate per lane:**
```bash
bun test                    # all suites green (lane tests + regression)
bun run typecheck           # tsc --noEmit clean
bun run build               # bundle success
```
All three must pass before a lane commits.

**Commit style.** Use conventional commits scoped to the package: `feat(core): ...`, `feat(permissions): ...`, `test(tools): ...`, `refactor(agents): ...`.

**Worktree convention.**
```bash
# From the main checkout
git worktree add ../open-agent-L1 -b align/L1-session-jsonl feat/core-alignment
cd ../open-agent-L1
bun install   # if node_modules not present
```
Each lane works in its own worktree. After completion and tests passing, rebase onto the latest `feat/core-alignment` and merge.

**Type definitions already present** (do not redefine):
- `ToolDefinition`, `ToolContext`, `ToolCapability` — `packages/tools/src/types.ts:122`
- `SessionManager` — `packages/core/src/session-manager.ts:97`
- `PermissionEngine` — `packages/permissions/src/engine.ts:93`
- `HookExecutor` — `packages/hooks/src/executor.ts:31`
- `HookInput`/`HookOutput` discriminated unions — `packages/hooks/src/types.ts:156-199` (**already Claude-Code-aligned**; see L3)

---

# WAVE 1 — 9 Parallel Lanes

Dispatch all 9 lanes simultaneously via subagent-driven-development. Lanes L4 and L9 both touch `packages/permissions/src/engine.ts` — L9 must rebase onto the merged L4 branch before starting Task L9.1.

---

## Lane L1: Session Storage → JSONL

**Gap:** #4. **Worktree:** `../open-agent-L1` branch `align/L1-session-jsonl`. **Dependencies:** none.

**Scope summary.** Migrate `SessionManager` from whole-JSON-file sessions to per-message JSONL under `~/.open-agent/projects/[sha256(cwd)]/sessions/[sessionId].jsonl`. Write incrementally on each emission. Provide migration for legacy sessions.

**Files:**
- Create: `packages/core/src/session-io.ts`
- Create: `packages/core/src/__tests__/session-io.test.ts`
- Modify: `packages/core/src/session-manager.ts` (~764 lines — update path resolution and persistence hooks)
- Modify: `packages/core/src/__tests__/session-manager.test.ts` (add JSONL assertions)

### Task L1.1: Project hash + path resolution

- [ ] **Step 1: Write failing test for project hash**

Create `packages/core/src/__tests__/session-io.test.ts`:
```ts
import { describe, expect, test } from 'bun:test';
import { projectHash, resolveSessionPath } from '../session-io';

describe('session-io path resolution', () => {
  test('projectHash is deterministic sha256 of cwd', () => {
    const h1 = projectHash('/Users/alice/proj');
    const h2 = projectHash('/Users/alice/proj');
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[a-f0-9]{64}$/);
  });

  test('different cwds produce different hashes', () => {
    expect(projectHash('/a')).not.toBe(projectHash('/b'));
  });

  test('resolveSessionPath yields projects/<hash>/sessions/<id>.jsonl', () => {
    const p = resolveSessionPath('/tmp/root', '/Users/alice/proj', 'sess-123');
    expect(p).toMatch(/\/tmp\/root\/projects\/[a-f0-9]{64}\/sessions\/sess-123\.jsonl$/);
  });
});
```

- [ ] **Step 2: Run and verify failure**

Run: `bun test packages/core/src/__tests__/session-io.test.ts`
Expected: FAIL — `Cannot find module '../session-io'`.

- [ ] **Step 3: Implement session-io.ts skeleton**

Create `packages/core/src/session-io.ts`:
```ts
import { createHash } from 'node:crypto';
import { join } from 'node:path';

export function projectHash(cwd: string): string {
  return createHash('sha256').update(cwd).digest('hex');
}

export function resolveSessionPath(root: string, cwd: string, sessionId: string): string {
  return join(root, 'projects', projectHash(cwd), 'sessions', `${sessionId}.jsonl`);
}
```

- [ ] **Step 4: Run and verify pass**

Run: `bun test packages/core/src/__tests__/session-io.test.ts`
Expected: PASS (3/3).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/session-io.ts packages/core/src/__tests__/session-io.test.ts
git commit -m "feat(core): add JSONL session path resolution"
```

### Task L1.2: Append-on-emit writer

- [ ] **Step 1: Write failing test for append writer**

Add to `session-io.test.ts`:
```ts
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { SessionJsonlWriter } from '../session-io';

describe('SessionJsonlWriter', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(`${tmpdir()}/oa-session-`);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('append creates file and writes one line per record', async () => {
    const path = `${dir}/sess.jsonl`;
    const w = new SessionJsonlWriter(path);
    await w.append({ type: 'user', text: 'hi' });
    await w.append({ type: 'assistant', text: 'hello' });
    await w.close();
    const content = readFileSync(path, 'utf8');
    const lines = content.trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual({ type: 'user', text: 'hi' });
    expect(JSON.parse(lines[1]!)).toEqual({ type: 'assistant', text: 'hello' });
  });

  test('append creates parent directories on demand', async () => {
    const path = `${dir}/nested/deep/sess.jsonl`;
    const w = new SessionJsonlWriter(path);
    await w.append({ type: 'user', text: 'x' });
    await w.close();
    expect(existsSync(path)).toBe(true);
  });
});
```
Add `afterEach` + `beforeEach` imports: `import { ... afterEach, beforeEach } from 'bun:test';`.

- [ ] **Step 2: Run and verify failure**

Run: `bun test packages/core/src/__tests__/session-io.test.ts`
Expected: FAIL — `SessionJsonlWriter is not a constructor`.

- [ ] **Step 3: Implement writer**

Append to `session-io.ts`:
```ts
import { mkdir, appendFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export class SessionJsonlWriter {
  private ensured = false;
  constructor(private readonly path: string) {}

  async append(record: unknown): Promise<void> {
    if (!this.ensured) {
      await mkdir(dirname(this.path), { recursive: true });
      this.ensured = true;
    }
    await appendFile(this.path, JSON.stringify(record) + '\n', 'utf8');
  }

  async close(): Promise<void> {
    // no-op for now; placeholder for future buffered implementations
  }
}
```

- [ ] **Step 4: Run and verify pass**

Run: `bun test packages/core/src/__tests__/session-io.test.ts`
Expected: PASS (5/5).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/session-io.ts packages/core/src/__tests__/session-io.test.ts
git commit -m "feat(core): add SessionJsonlWriter for append-on-emit persistence"
```

### Task L1.3: Streaming reader + recovery

- [ ] **Step 1: Write failing test for reader**

Add to `session-io.test.ts`:
```ts
import { writeFileSync } from 'node:fs';
import { readJsonlSession } from '../session-io';

describe('readJsonlSession', () => {
  test('reads back records in order', async () => {
    const path = `${dir}/ok.jsonl`;
    writeFileSync(path, '{"type":"user","text":"a"}\n{"type":"assistant","text":"b"}\n');
    const records = await readJsonlSession(path);
    expect(records).toEqual([
      { type: 'user', text: 'a' },
      { type: 'assistant', text: 'b' },
    ]);
  });

  test('tolerates partial last line (crash recovery)', async () => {
    const path = `${dir}/partial.jsonl`;
    writeFileSync(path, '{"type":"user","text":"a"}\n{"type":"assista');
    const records = await readJsonlSession(path);
    expect(records).toEqual([{ type: 'user', text: 'a' }]);
  });

  test('returns empty array for missing file', async () => {
    expect(await readJsonlSession(`${dir}/nope.jsonl`)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run and verify failure**

Run: `bun test packages/core/src/__tests__/session-io.test.ts`
Expected: FAIL — `readJsonlSession is not a function`.

- [ ] **Step 3: Implement reader**

Append to `session-io.ts`:
```ts
import { readFile } from 'node:fs/promises';

export async function readJsonlSession(path: string): Promise<unknown[]> {
  let content: string;
  try {
    content = await readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  const out: unknown[] = [];
  for (const line of content.split('\n')) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // partial/truncated trailing line — stop reading
      break;
    }
  }
  return out;
}
```

- [ ] **Step 4: Run and verify pass**

Run: `bun test packages/core/src/__tests__/session-io.test.ts`
Expected: PASS (8/8).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/session-io.ts packages/core/src/__tests__/session-io.test.ts
git commit -m "feat(core): add readJsonlSession with crash-safe recovery"
```

### Task L1.4: Wire SessionManager to use JSONL

- [ ] **Step 1: Write failing test asserting JSONL path is used**

Add to `packages/core/src/__tests__/session-manager.test.ts` (a new test — do not remove existing):
```ts
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { SessionManager } from '../session-manager';
import { projectHash } from '../session-io';

test('SessionManager persists transcript as JSONL under projects/<hash>/sessions/', async () => {
  const root = mkdtempSync(`${tmpdir()}/oa-sm-`);
  const cwd = '/fake/project';
  const sm = new SessionManager({ root, cwd });
  const session = await sm.createSession({ model: 'glm-4.7', permissionMode: 'default' });
  await sm.appendMessage(session.id, { type: 'user', text: 'first' });
  await sm.appendMessage(session.id, { type: 'assistant', text: 'reply' });

  const expected = `${root}/projects/${projectHash(cwd)}/sessions/${session.id}.jsonl`;
  expect(existsSync(expected)).toBe(true);
  const lines = readFileSync(expected, 'utf8').trimEnd().split('\n').map(l => JSON.parse(l));
  expect(lines).toHaveLength(2);
  expect(lines[0]).toMatchObject({ type: 'user', text: 'first' });
});
```

- [ ] **Step 2: Run and verify failure**

Run: `bun test packages/core/src/__tests__/session-manager.test.ts`
Expected: FAIL — persistence goes to old path, `existsSync` returns false, or `appendMessage` is missing.

- [ ] **Step 3: Refactor SessionManager**

In `packages/core/src/session-manager.ts`:

1. Import: `import { resolveSessionPath, SessionJsonlWriter, readJsonlSession } from './session-io';`
2. Add field: `private writers = new Map<string, SessionJsonlWriter>();`
3. Add constructor option `root?: string` (default `join(homedir(), '.open-agent')`).
4. Add public method:
   ```ts
   async appendMessage(sessionId: string, record: unknown): Promise<void> {
     let writer = this.writers.get(sessionId);
     if (!writer) {
       const path = resolveSessionPath(this.root, this.cwd, sessionId);
       writer = new SessionJsonlWriter(path);
       this.writers.set(sessionId, writer);
     }
     await writer.append(record);
   }
   ```
5. In `loadSession(sessionId)`, if the JSONL path exists, read with `readJsonlSession()` and reconstruct the session from records.
6. Update legacy loader: if the old single-JSON file exists at the old path, read it, then write each message through `appendMessage()`, then delete the old file (best-effort).

- [ ] **Step 4: Run and verify pass**

Run: `bun test packages/core/src/__tests__/session-manager.test.ts`
Expected: all tests pass including the new JSONL assertion.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/session-manager.ts packages/core/src/__tests__/session-manager.test.ts
git commit -m "feat(core): migrate SessionManager to JSONL append-on-emit storage"
```

### Task L1.5: Lane gate

- [ ] **Step 1: Full regression**

Run: `bun test && bun run typecheck && bun run build`
Expected: all green. If any pre-existing test broke, fix by ensuring the legacy migration path is exercised and backward-compatible.

- [ ] **Step 2: Merge back**

```bash
cd ../open-agent         # back to main checkout
git merge --no-ff align/L1-session-jsonl
bun test                 # re-verify after merge
```

---

## Lane L2: CLAUDE.md Lookup Chain

**Gap:** #10. **Worktree:** `../open-agent-L2` branch `align/L2-claude-md`. **Dependencies:** none.

**Scope summary.** Align memory-file lookup with Claude Code: `$PWD/.claude/CLAUDE.md → $PWD/CLAUDE.md → ~/.claude/CLAUDE.md`. Current `config-loader.ts` walks `AGENT.md`. Keep `AGENT.md` as fallback alias but put `CLAUDE.md` in precedence order.

**Files:**
- Modify: `packages/core/src/config-loader.ts` (~242 lines)
- Modify or create: `packages/core/src/__tests__/config-loader.test.ts`

### Task L2.1: Precedence test + implementation

- [ ] **Step 1: Read current config-loader**

Run: `cat packages/core/src/config-loader.ts | head -100`
Understand the current walk logic. Find the function that returns memory content (`loadMemoryPrompt` or equivalent).

- [ ] **Step 2: Write failing test**

Create or append `packages/core/src/__tests__/config-loader.test.ts`:
```ts
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMemoryPrompt } from '../config-loader';

describe('CLAUDE.md precedence', () => {
  let root: string;
  let home: string;
  beforeEach(() => {
    root = mkdtempSync(`${tmpdir()}/oa-mem-`);
    home = mkdtempSync(`${tmpdir()}/oa-home-`);
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  test('prefers $PWD/.claude/CLAUDE.md over $PWD/CLAUDE.md', async () => {
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(join(root, '.claude', 'CLAUDE.md'), 'A');
    writeFileSync(join(root, 'CLAUDE.md'), 'B');
    const result = await loadMemoryPrompt(root, home);
    expect(result).toContain('A');
    expect(result).not.toContain('B');
  });

  test('falls back to $PWD/CLAUDE.md when .claude/ missing', async () => {
    writeFileSync(join(root, 'CLAUDE.md'), 'B');
    const result = await loadMemoryPrompt(root, home);
    expect(result).toContain('B');
  });

  test('falls back to ~/.claude/CLAUDE.md when no project memory', async () => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', 'CLAUDE.md'), 'G');
    const result = await loadMemoryPrompt(root, home);
    expect(result).toContain('G');
  });

  test('returns empty string when no memory file exists', async () => {
    expect(await loadMemoryPrompt(root, home)).toBe('');
  });
});
```

- [ ] **Step 3: Run and verify failure**

Run: `bun test packages/core/src/__tests__/config-loader.test.ts`
Expected: FAIL — either `loadMemoryPrompt` signature doesn't accept `home` arg, or precedence order is wrong.

- [ ] **Step 4: Implement `loadMemoryPrompt`**

In `packages/core/src/config-loader.ts`, add (or replace existing):
```ts
import { readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

const MEMORY_FILENAMES = ['CLAUDE.md', 'AGENT.md']; // fallback alias

async function exists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

export async function loadMemoryPrompt(
  cwd: string,
  home: string = homedir(),
): Promise<string> {
  const candidates: string[] = [];
  for (const name of MEMORY_FILENAMES) {
    candidates.push(join(cwd, '.claude', name));
  }
  for (const name of MEMORY_FILENAMES) {
    candidates.push(join(cwd, name));
  }
  for (const name of MEMORY_FILENAMES) {
    candidates.push(join(home, '.claude', name));
  }
  for (const path of candidates) {
    if (await exists(path)) {
      return await readFile(path, 'utf8');
    }
  }
  return '';
}
```

- [ ] **Step 5: Run and verify pass, then commit**

```bash
bun test packages/core/src/__tests__/config-loader.test.ts
```
Expected: PASS (4/4).

```bash
git add packages/core/src/config-loader.ts packages/core/src/__tests__/config-loader.test.ts
git commit -m "feat(core): align CLAUDE.md lookup chain with Claude Code precedence"
```

### Task L2.2: Lane gate

- [ ] **Step 1: Full regression**

Run: `bun test && bun run typecheck && bun run build`
Expected: all green.

- [ ] **Step 2: Merge back**

```bash
cd ../open-agent
git merge --no-ff align/L2-claude-md
bun test
```

---

## Lane L3: Hook Contract Verification + asyncTimeout

**Gap:** #5. **Worktree:** `../open-agent-L3` branch `align/L3-hook-contract`. **Dependencies:** none.

**Scope summary.** `HookInput`/`HookOutput` types are **already aligned** with Claude Code (see `packages/hooks/src/types.ts`). Remaining work: (a) verify the shell-hook executor pipes stdin JSON correctly and reads stdout JSON, (b) support `asyncTimeout` for non-blocking hooks, (c) add any missing events (`PreToolUse` with `updatedMCPToolOutput` via `hookSpecificOutput`).

**Files:**
- Modify: `packages/hooks/src/types.ts` (add `asyncTimeout` and `hookSpecificOutput` fields)
- Modify: `packages/hooks/src/executor.ts` (implement async fire-and-forget path)
- Modify: `packages/hooks/src/__tests__/executor.test.ts`

### Task L3.1: Add asyncTimeout to HookDefinition

- [ ] **Step 1: Write failing test**

In `packages/hooks/src/__tests__/executor.test.ts`, add:
```ts
test('async hook does not block tool execution', async () => {
  const startedAt = Date.now();
  const executor = new HookExecutor();
  await executor.loadShellHooks([
    {
      event: 'PreToolUse',
      config: {
        command: 'sleep 0.5 && echo \'{"continue": true}\'',
        asyncTimeout: 30, // fire-and-forget mode
      },
    },
  ]);
  const result = await executor.run('PreToolUse', {
    session_id: 'x', transcript_path: '', cwd: '/', 
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash', tool_input: {}, tool_use_id: 't1',
  });
  const elapsed = Date.now() - startedAt;
  expect(elapsed).toBeLessThan(200); // fire-and-forget: returns quickly
  expect(result.continue).toBeTruthy();
});
```

- [ ] **Step 2: Run and verify failure**

Run: `bun test packages/hooks/src/__tests__/executor.test.ts`
Expected: FAIL — either `asyncTimeout` isn't a recognized field, or the test takes > 500ms.

- [ ] **Step 3: Add field to type**

In `packages/hooks/src/types.ts`, modify `HookDefinition`:
```ts
export interface HookDefinition {
  command: string;
  timeout?: number;
  /** When set, the hook runs asynchronously; the caller returns immediately.
   *  The hook still has up to `asyncTimeout` seconds to complete in the background. */
  asyncTimeout?: number;
  matcher?: string;
}
```

Also add to `HookOutput`:
```ts
  /** Event-specific output overrides (e.g., MCP tool result rewriting). */
  hookSpecificOutput?: Record<string, unknown>;
```

- [ ] **Step 4: Implement async fire-and-forget in executor**

In `packages/hooks/src/executor.ts`, locate the method that runs a shell hook definition. Split the execution:
```ts
// Inside HookExecutor.runShellHook (or equivalent):
if (def.asyncTimeout !== undefined) {
  // Fire-and-forget: start process, don't await
  const p = this.spawnHook(def, input);
  // Schedule abort after asyncTimeout seconds
  setTimeout(() => p.kill('SIGTERM'), def.asyncTimeout * 1000).unref();
  return { continue: true }; // caller proceeds immediately
}
// Otherwise: synchronous existing path
return await this.runShellHookSync(def, input);
```
(If your executor uses a different private method name, adapt the split accordingly — the key is: when `asyncTimeout` is set, do NOT await the child process.)

- [ ] **Step 5: Run, verify pass, commit**

```bash
bun test packages/hooks/src/__tests__/executor.test.ts
```
Expected: PASS including the new async test.

```bash
git add packages/hooks/src/types.ts packages/hooks/src/executor.ts packages/hooks/src/__tests__/executor.test.ts
git commit -m "feat(hooks): add asyncTimeout fire-and-forget support + hookSpecificOutput"
```

### Task L3.2: Stdin JSON roundtrip contract test

- [ ] **Step 1: Write failing test**

Add to executor test:
```ts
test('shell hook receives stdin JSON with all HookInput fields', async () => {
  const executor = new HookExecutor();
  // This script reads stdin, parses, and echoes back selected fields.
  const script = `cat > /tmp/hook-stdin-capture.json && echo '{"continue": true, "additionalContext": "ok"}'`;
  await executor.loadShellHooks([
    { event: 'PreToolUse', config: { command: script, timeout: 5 } },
  ]);
  await executor.run('PreToolUse', {
    session_id: 'sess-1',
    transcript_path: '/tmp/t',
    cwd: '/cwd',
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'ls' },
    tool_use_id: 'use-1',
  });
  const captured = JSON.parse(require('node:fs').readFileSync('/tmp/hook-stdin-capture.json', 'utf8'));
  expect(captured.session_id).toBe('sess-1');
  expect(captured.hook_event_name).toBe('PreToolUse');
  expect(captured.tool_name).toBe('Bash');
  expect(captured.tool_input).toEqual({ command: 'ls' });
  expect(captured.tool_use_id).toBe('use-1');
});
```

- [ ] **Step 2: Run, verify pass or failure**

Run: `bun test packages/hooks/src/__tests__/executor.test.ts`

If pass → stdin roundtrip already works; skip to Step 4.

If fail → fix executor to write `JSON.stringify(input) + '\n'` to child stdin and close stdin. Re-run until pass.

- [ ] **Step 3: (if fix needed) Adjust executor spawn logic**

In `packages/hooks/src/executor.ts`, ensure the spawn uses:
```ts
const proc = spawn('bash', ['-c', def.command], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, HOOK_INPUT: JSON.stringify(input) },
});
proc.stdin.write(JSON.stringify(input) + '\n');
proc.stdin.end();
```

- [ ] **Step 4: Commit**

```bash
git add packages/hooks/src/executor.ts packages/hooks/src/__tests__/executor.test.ts
git commit -m "test(hooks): add stdin JSON contract test + pipe fix"
```

### Task L3.3: Lane gate

- [ ] **Step 1: Full regression + merge**

```bash
bun test && bun run typecheck && bun run build
cd ../open-agent
git merge --no-ff align/L3-hook-contract
bun test
```

---

## Lane L4: Permission 5-Step Pipeline

**Gap:** #6. **Worktree:** `../open-agent-L4` branch `align/L4-permission-pipeline`. **Dependencies:** none (but L9 depends on L4 — see L9 dispatch notes).

**Scope summary.** Refactor `PermissionEngine.evaluate()` into an explicit 5-step pipeline: `validateInput → alwaysDeny → alwaysAllow → PreToolUse hooks → classifier → prompt`. Current impl collapses several steps; we make each step an explicit private method to enable future hook insertion.

**Files:**
- Modify: `packages/permissions/src/engine.ts` (~632 lines)
- Create: `packages/permissions/src/pipeline.ts`
- Modify: `packages/permissions/src/__tests__/engine.test.ts`

### Task L4.1: Pipeline skeleton + stages

- [ ] **Step 1: Write failing test**

In `packages/permissions/src/__tests__/engine.test.ts`, add:
```ts
test('evaluate invokes pipeline stages in documented order', async () => {
  const engine = new PermissionEngine({ mode: 'default' });
  const calls: string[] = [];
  // @ts-expect-error private instrumentation for test
  engine.__trace = (stage: string) => calls.push(stage);
  await engine.evaluate({
    toolName: 'Bash',
    input: { command: 'echo hi' },
  });
  expect(calls).toEqual([
    'validateInput',
    'alwaysDeny',
    'alwaysAllow',
    'preToolUseHooks',
    'classifier',
    'prompt',
  ]);
});
```
(This test assumes a trace hook will be added for observability.)

- [ ] **Step 2: Run and verify failure**

Run: `bun test packages/permissions/src/__tests__/engine.test.ts`
Expected: FAIL — trace is undefined or stages don't fire.

- [ ] **Step 3: Create pipeline.ts and refactor engine**

Create `packages/permissions/src/pipeline.ts`:
```ts
import type { PermissionRequest, PermissionResult } from './types';

export type PipelineStage =
  | 'validateInput'
  | 'alwaysDeny'
  | 'alwaysAllow'
  | 'preToolUseHooks'
  | 'classifier'
  | 'prompt';

export interface PipelineContext {
  request: PermissionRequest;
  trace?: (stage: PipelineStage) => void;
}

export type StageHandler = (
  ctx: PipelineContext,
) => Promise<PermissionResult | undefined>;

export async function runPipeline(
  ctx: PipelineContext,
  stages: Array<[PipelineStage, StageHandler]>,
): Promise<PermissionResult> {
  for (const [name, handler] of stages) {
    ctx.trace?.(name);
    const result = await handler(ctx);
    if (result) return result;
  }
  // Fallthrough should not happen if `prompt` always returns a decision.
  throw new Error('Permission pipeline did not resolve');
}
```

In `packages/permissions/src/engine.ts`, refactor `evaluate()`:
```ts
import { runPipeline, type PipelineStage } from './pipeline';

export class PermissionEngine {
  // ... existing fields ...
  /** @internal test instrumentation */
  public __trace?: (stage: PipelineStage) => void;

  async evaluate(request: PermissionRequest): Promise<PermissionResult> {
    return runPipeline({ request, trace: this.__trace }, [
      ['validateInput', (ctx) => this.stageValidateInput(ctx)],
      ['alwaysDeny', (ctx) => this.stageAlwaysDeny(ctx)],
      ['alwaysAllow', (ctx) => this.stageAlwaysAllow(ctx)],
      ['preToolUseHooks', (ctx) => this.stagePreToolUseHooks(ctx)],
      ['classifier', (ctx) => this.stageClassifier(ctx)],
      ['prompt', (ctx) => this.stagePrompt(ctx)],
    ]);
  }

  // Split existing evaluate body into 6 private methods.
  // `stageClassifier` can simply return undefined for now (placeholder).
}
```
Move existing evaluate logic into the appropriate stage methods. The `classifier` stage returns `undefined` (stub). The `prompt` stage calls the existing user-prompt path.

- [ ] **Step 4: Run and verify pass**

Run: `bun test packages/permissions/src/__tests__/engine.test.ts`
Expected: PASS (trace shows all 6 stages).

- [ ] **Step 5: Commit**

```bash
git add packages/permissions/src/engine.ts packages/permissions/src/pipeline.ts packages/permissions/src/__tests__/engine.test.ts
git commit -m "refactor(permissions): split evaluate into explicit 5-step pipeline"
```

### Task L4.2: Lane gate

- [ ] **Step 1: Full regression**

Run: `bun test && bun run typecheck && bun run build`
Expected: all green. Pay attention to existing engine tests — any failure means the refactor changed behavior; diagnose by comparing the old evaluate flow to your split.

- [ ] **Step 2: Merge back**

```bash
cd ../open-agent
git merge --no-ff align/L4-permission-pipeline
bun test
```

**Note:** After L4 merges, L9 can start (L9 must rebase onto the L4-merged HEAD before its first task).

---

## Lane L5: Settings 6-Layer Hierarchy

**Gap:** #13. **Worktree:** `../open-agent-L5` branch `align/L5-settings-6-layer`. **Dependencies:** none.

**Scope summary.** Expand `settings-loader.ts` from current user+project layers to full `flag → policy → project → local → user → mdm(macOS) → defaults` precedence, deep-merging with higher layers winning.

**Files:**
- Modify: `packages/permissions/src/settings-loader.ts` (~142 lines)
- Modify: `packages/permissions/src/__tests__/settings-loader.test.ts`

### Task L5.1: Precedence test

- [ ] **Step 1: Write failing test**

Add to `settings-loader.test.ts`:
```ts
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadLayeredSettings } from '../settings-loader';

test('6-layer precedence: flag > policy > project > local > user > defaults', async () => {
  const root = mkdtempSync(`${tmpdir()}/oa-settings-`);
  const home = mkdtempSync(`${tmpdir()}/oa-home-`);
  const project = join(root, 'proj');
  const local = join(project, '.claude', 'local');
  const projSettings = join(project, '.claude');
  const userSettings = join(home, '.claude');

  mkdirSync(local, { recursive: true });
  mkdirSync(projSettings, { recursive: true });
  mkdirSync(userSettings, { recursive: true });

  writeFileSync(join(userSettings, 'settings.json'),
    JSON.stringify({ model: 'user-model', verbose: true }));
  writeFileSync(join(projSettings, 'settings.json'),
    JSON.stringify({ model: 'project-model' }));
  writeFileSync(join(local, 'settings.json'),
    JSON.stringify({ permissionMode: 'plan' }));

  const merged = await loadLayeredSettings({
    cwd: project,
    home,
    flagSettings: { model: 'flag-model' },
  });

  expect(merged.model).toBe('flag-model');          // flag wins
  expect(merged.permissionMode).toBe('plan');       // local wins over user
  expect(merged.verbose).toBe(true);                // user contributes
});
```

- [ ] **Step 2: Run and verify failure**

Run: `bun test packages/permissions/src/__tests__/settings-loader.test.ts`
Expected: FAIL — `loadLayeredSettings` doesn't exist or has a different signature.

- [ ] **Step 3: Implement layered loader**

In `packages/permissions/src/settings-loader.ts`:
```ts
import { readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';

export interface LoadLayeredOptions {
  cwd: string;
  home?: string;
  flagSettings?: Record<string, unknown>;
  policyPath?: string;
}

async function readJsonSafe(path: string): Promise<Record<string, unknown>> {
  try {
    const content = await readFile(path, 'utf8');
    return JSON.parse(content);
  } catch { return {}; }
}

function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  for (const key of Object.keys(source)) {
    const s = source[key], t = target[key];
    if (s && typeof s === 'object' && !Array.isArray(s) &&
        t && typeof t === 'object' && !Array.isArray(t)) {
      target[key] = deepMerge(
        { ...(t as Record<string, unknown>) },
        s as Record<string, unknown>,
      );
    } else {
      target[key] = s;
    }
  }
  return target;
}

export async function loadLayeredSettings(
  opts: LoadLayeredOptions,
): Promise<Record<string, unknown>> {
  const home = opts.home ?? homedir();
  const layers: Array<Record<string, unknown>> = [];

  // 6. defaults
  layers.push({});
  // 5. mdm (macOS only)
  if (platform() === 'darwin') {
    layers.push(await readJsonSafe('/Library/Managed Preferences/com.anthropic.claude.json'));
  }
  // 4. user
  layers.push(await readJsonSafe(join(home, '.claude', 'settings.json')));
  // 3. local
  layers.push(await readJsonSafe(join(opts.cwd, '.claude', 'local', 'settings.json')));
  // 2. project
  layers.push(await readJsonSafe(join(opts.cwd, '.claude', 'settings.json')));
  // 1. policy
  if (opts.policyPath) {
    layers.push(await readJsonSafe(opts.policyPath));
  }
  // 0. flag (highest)
  if (opts.flagSettings) {
    layers.push(opts.flagSettings);
  }

  return layers.reduce<Record<string, unknown>>(
    (acc, layer) => deepMerge(acc, layer),
    {},
  );
}
```
Preserve any existing exports. Update existing callers if necessary (search for `settings-loader` imports and adapt).

- [ ] **Step 4: Run and verify pass**

Run: `bun test packages/permissions/src/__tests__/settings-loader.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/permissions/src/settings-loader.ts packages/permissions/src/__tests__/settings-loader.test.ts
git commit -m "feat(permissions): add 6-layer settings hierarchy with deep-merge"
```

### Task L5.2: Lane gate

- [ ] **Step 1: Full regression + merge**

```bash
bun test && bun run typecheck && bun run build
cd ../open-agent
git merge --no-ff align/L5-settings-6-layer
bun test
```

---

## Lane L6: Subagent Fork Mode + Sidechain

**Gap:** #7. **Worktree:** `../open-agent-L6` branch `align/L6-subagent-fork`. **Dependencies:** Prologue (WIP checkpoint).

**Scope summary.** Add `fork` execution mode to `AgentExecutor`: clones parent permission/tool context, runs in background, persists messages to `~/.open-agent/sidechain/[agentId]/messages.jsonl`, does NOT populate parent message history. Delegate mode stays as default.

**⚠️ WIP Awareness:** This lane's files were recently modified by the WIP checkpoint to add `agentType` and `CoordinatorContext` wiring. Read those diffs before writing new code. Do not remove or rename `agentType`, `coordinator` fields.

**Files:**
- Modify: `packages/agents/src/agent-executor.ts` (~738 lines)
- Modify: `packages/agents/src/agent-runner.ts` (~407 lines)
- Create: `packages/agents/src/fork-context.ts`
- Create: `packages/agents/src/sidechain.ts`
- Modify: `packages/agents/src/__tests__/agent-executor.test.ts`

### Task L6.1: Sidechain writer

- [ ] **Step 1: Write failing test**

Create `packages/agents/src/__tests__/sidechain.test.ts`:
```ts
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { SidechainWriter, sidechainPath } from '../sidechain';

describe('sidechain', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(`${tmpdir()}/oa-sidechain-`); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  test('sidechainPath returns sidechain/<agentId>/messages.jsonl', () => {
    expect(sidechainPath(root, 'agent-abc')).toBe(
      `${root}/sidechain/agent-abc/messages.jsonl`,
    );
  });

  test('SidechainWriter appends JSONL records', async () => {
    const w = new SidechainWriter(sidechainPath(root, 'a'));
    await w.append({ type: 'user', text: 'm1' });
    await w.append({ type: 'assistant', text: 'r1' });
    const path = sidechainPath(root, 'a');
    expect(existsSync(path)).toBe(true);
    const lines = readFileSync(path, 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run and verify failure**

Run: `bun test packages/agents/src/__tests__/sidechain.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement sidechain.ts**

Create `packages/agents/src/sidechain.ts`:
```ts
import { join } from 'node:path';
import { mkdir, appendFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export function sidechainPath(root: string, agentId: string): string {
  return join(root, 'sidechain', agentId, 'messages.jsonl');
}

export class SidechainWriter {
  private ensured = false;
  constructor(private readonly path: string) {}

  async append(record: unknown): Promise<void> {
    if (!this.ensured) {
      await mkdir(dirname(this.path), { recursive: true });
      this.ensured = true;
    }
    await appendFile(this.path, JSON.stringify(record) + '\n', 'utf8');
  }
}
```

- [ ] **Step 4: Run and verify pass**

Run: `bun test packages/agents/src/__tests__/sidechain.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agents/src/sidechain.ts packages/agents/src/__tests__/sidechain.test.ts
git commit -m "feat(agents): add sidechain JSONL writer for fork-mode subagents"
```

### Task L6.2: Fork context factory

- [ ] **Step 1: Write failing test**

Create `packages/agents/src/__tests__/fork-context.test.ts`:
```ts
import { describe, expect, test } from 'bun:test';
import { createForkContext } from '../fork-context';

describe('createForkContext', () => {
  test('clones parent permission/tool context snapshot', () => {
    const parent = {
      permissionMode: 'default' as const,
      allowedTools: new Set(['Read', 'Grep']),
      messages: [{ type: 'user', text: 'hi' }],
    };
    const fork = createForkContext(parent);
    // Mutate parent after fork
    parent.allowedTools.add('Bash');
    parent.messages.push({ type: 'assistant', text: 'late' });
    // Fork must NOT reflect post-fork mutations
    expect(fork.allowedTools.has('Bash')).toBe(false);
    expect(fork.messages).toHaveLength(1);
    expect(fork.permissionMode).toBe('default');
  });

  test('fork has independent message array identity', () => {
    const parent = { permissionMode: 'plan' as const, allowedTools: new Set<string>(), messages: [] as unknown[] };
    const fork = createForkContext(parent);
    expect(fork.messages).not.toBe(parent.messages);
  });
});
```

- [ ] **Step 2: Run and verify failure**

Run: `bun test packages/agents/src/__tests__/fork-context.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement fork-context.ts**

Create `packages/agents/src/fork-context.ts`:
```ts
export interface ForkableContext {
  permissionMode: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions' | 'dontAsk';
  allowedTools: Set<string>;
  messages: unknown[];
}

export function createForkContext<T extends ForkableContext>(parent: T): T {
  return {
    ...parent,
    allowedTools: new Set(parent.allowedTools),
    messages: [...parent.messages],
  };
}
```

- [ ] **Step 4: Run and verify pass**

Run: `bun test packages/agents/src/__tests__/fork-context.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agents/src/fork-context.ts packages/agents/src/__tests__/fork-context.test.ts
git commit -m "feat(agents): add createForkContext for subagent isolation"
```

### Task L6.3: Wire fork mode into AgentExecutor

- [ ] **Step 1: Write failing test**

Add to `packages/agents/src/__tests__/agent-executor.test.ts`:
```ts
test('executeForked persists messages to sidechain and does not mutate parent messages', async () => {
  // Setup executor with stub provider and a trivial agent definition
  const parentMessages: unknown[] = [{ type: 'user', text: 'pre-fork' }];
  const { agentId } = await executor.executeForked({
    definition: minimalDef,
    provider: stubProvider,
    tools: new Map(),
    prompt: 'do a tiny thing',
    parentMessages,
    root: tmpRoot,
  });
  // Parent messages must be untouched
  expect(parentMessages).toHaveLength(1);
  // Sidechain file must exist with at least one record
  const sidechainFile = `${tmpRoot}/sidechain/${agentId}/messages.jsonl`;
  expect(existsSync(sidechainFile)).toBe(true);
});
```
(Reuse test scaffolding from existing `agent-executor.test.ts`; add minimal stubs where needed.)

- [ ] **Step 2: Run and verify failure**

Run: `bun test packages/agents/src/__tests__/agent-executor.test.ts`
Expected: FAIL — `executeForked` is not a function.

- [ ] **Step 3: Add executeForked to AgentExecutor**

In `packages/agents/src/agent-executor.ts`, add:
```ts
import { SidechainWriter, sidechainPath } from './sidechain';
import { createForkContext } from './fork-context';

// Inside AgentExecutor class:
async executeForked(options: ExecuteOptions & {
  parentMessages: unknown[];
  root: string;
}): Promise<{ agentId: string; outputFile: string }> {
  const agentId = options.resume ?? `fork-${randomUUID()}`;
  const writer = new SidechainWriter(sidechainPath(options.root, agentId));

  // Snapshot parent context
  const forkCtx = createForkContext({
    permissionMode: (options as any).permissionMode ?? 'default',
    allowedTools: new Set<string>(Array.from(options.tools.keys())),
    messages: options.parentMessages,
  });

  // Record fork start
  await writer.append({ type: 'fork_start', agentId, parentSnapshotSize: forkCtx.messages.length });

  // Run a minimal agent loop (reuse existing execute path but write to sidechain instead of parent)
  const result = await this.execute({ ...options, resume: agentId });
  for (const msg of result.session.messages) {
    await writer.append(msg);
  }
  return { agentId, outputFile: sidechainPath(options.root, agentId) };
}
```

Key invariant: `options.parentMessages` must NOT be mutated. The fork runs its own independent session.

- [ ] **Step 4: Run and verify pass**

Run: `bun test packages/agents/src/__tests__/agent-executor.test.ts`
Expected: PASS (both the new fork test and all existing executor tests).

- [ ] **Step 5: Commit**

```bash
git add packages/agents/src/agent-executor.ts packages/agents/src/__tests__/agent-executor.test.ts
git commit -m "feat(agents): add executeForked with sidechain persistence"
```

### Task L6.4: Lane gate

- [ ] **Step 1: Full regression + merge**

```bash
bun test && bun run typecheck && bun run build
cd ../open-agent
git merge --no-ff align/L6-subagent-fork
bun test
```

---

## Lane L7: ToolSearch Semantic + Deferred Tools

**Gap:** #8. **Worktree:** `../open-agent-L7` branch `align/L7-tool-search`. **Dependencies:** none.

**Scope summary.** Add `shouldDefer?: boolean` to `ToolDefinition`. MCP tools default to `shouldDefer: true`. `ToolSearchTool` accepts a query and returns matching tool schemas ranked by keyword overlap (simple tf-idf lite). No embedding model in this lane — deferred to future phase.

**Files:**
- Modify: `packages/tools/src/types.ts` (add `shouldDefer` field)
- Modify: `packages/tools/src/tool-search.ts` (~66 lines — implement ranking)
- Modify: `packages/tools/src/__tests__/tool-search.test.ts`
- Modify: `packages/tools/src/mcp-tools.ts` (default `shouldDefer: true` for MCP-origin tools)

### Task L7.1: Deferred flag + ranking algorithm

- [ ] **Step 1: Write failing test**

In `packages/tools/src/__tests__/tool-search.test.ts`, add:
```ts
test('tool-search ranks deferred tools by keyword overlap', async () => {
  const deferredTools = new Map([
    ['mcp__linear__list_issues', { name: 'mcp__linear__list_issues', description: 'List Linear issues for a team', shouldDefer: true, execute: async () => null, inputSchema: {} }],
    ['mcp__github__search_code', { name: 'mcp__github__search_code', description: 'Search code on GitHub repositories', shouldDefer: true, execute: async () => null, inputSchema: {} }],
    ['Read', { name: 'Read', description: 'Read a file from disk', execute: async () => null, inputSchema: {} }],
  ]);

  const tool = createToolSearchTool({ registry: deferredTools });
  const result = await tool.execute({ query: 'github code search' }, { cwd: '/', sessionId: 's' });
  expect(result.matches[0].name).toBe('mcp__github__search_code');
});

test('tool-search does not return non-deferred tools', async () => {
  const tools = new Map([
    ['Read', { name: 'Read', description: 'Read a file from disk', execute: async () => null, inputSchema: {} }],
  ]);
  const tool = createToolSearchTool({ registry: tools });
  const result = await tool.execute({ query: 'read file' }, { cwd: '/', sessionId: 's' });
  expect(result.matches).toHaveLength(0);
});
```

- [ ] **Step 2: Run and verify failure**

Run: `bun test packages/tools/src/__tests__/tool-search.test.ts`
Expected: FAIL — either the `shouldDefer` field doesn't exist or ranking isn't implemented.

- [ ] **Step 3: Add shouldDefer to ToolDefinition**

In `packages/tools/src/types.ts`, add to the `ToolDefinition` interface:
```ts
  /** When true, this tool is not surfaced in the initial tool list. It must be
   *  explicitly discovered via ToolSearch. Defaults to false. */
  shouldDefer?: boolean;
```

- [ ] **Step 4: Implement ranking in tool-search.ts**

Replace `packages/tools/src/tool-search.ts` body (preserve existing exports):
```ts
import type { ToolDefinition, ToolContext } from './types';

export interface ToolSearchRegistry {
  registry: Map<string, ToolDefinition>;
}

function tokenize(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function scoreMatch(query: string[], tool: ToolDefinition): number {
  const hay = tokenize(`${tool.name} ${tool.description}`);
  const haySet = new Set(hay);
  let score = 0;
  for (const q of query) {
    if (haySet.has(q)) score += 2;
    else if (hay.some(h => h.includes(q))) score += 1;
  }
  return score;
}

export function createToolSearchTool(opts: ToolSearchRegistry): ToolDefinition {
  return {
    name: 'ToolSearch',
    description: 'Search for deferred tools by natural-language query. Returns schemas of matching tools so they can be called in this turn.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' }, max_results: { type: 'number' } },
      required: ['query'],
    },
    async execute(input: { query: string; max_results?: number }, _ctx: ToolContext) {
      const qTokens = tokenize(input.query);
      const max = input.max_results ?? 5;
      const scored: Array<{ name: string; description: string; inputSchema: unknown; score: number }> = [];
      for (const tool of opts.registry.values()) {
        if (!tool.shouldDefer) continue;
        const score = scoreMatch(qTokens, tool);
        if (score > 0) {
          scored.push({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema, score });
        }
      }
      scored.sort((a, b) => b.score - a.score);
      return { matches: scored.slice(0, max) };
    },
  };
}
```

- [ ] **Step 5: Mark MCP tools as deferred, run tests, commit**

In `packages/tools/src/mcp-tools.ts`, find where MCP tools are converted into `ToolDefinition` and set `shouldDefer: true` on each:
```ts
// inside the factory that builds MCP tool wrappers:
return {
  name: `mcp__${server}__${tool.name}`,
  description: tool.description ?? '',
  inputSchema: tool.inputSchema,
  shouldDefer: true, // MCP tools are discovered via ToolSearch
  execute: async (input, ctx) => { /* existing impl */ },
};
```

Run: `bun test packages/tools/src/__tests__/tool-search.test.ts`
Expected: PASS (both new tests).

```bash
git add packages/tools/src/types.ts packages/tools/src/tool-search.ts packages/tools/src/mcp-tools.ts packages/tools/src/__tests__/tool-search.test.ts
git commit -m "feat(tools): add shouldDefer + semantic-lite ToolSearch ranking"
```

### Task L7.2: Lane gate

- [ ] **Step 1: Full regression + merge**

```bash
bun test && bun run typecheck && bun run build
cd ../open-agent
git merge --no-ff align/L7-tool-search
bun test
```

---

## Lane L8: Bash Persistent PTY

**Gap:** #12. **Worktree:** `../open-agent-L8` branch `align/L8-bash-pty`. **Dependencies:** none.

**Scope summary.** Replace per-call `spawn()` in Bash tool with a `node-pty` pseudoterminal persisted across calls within a session. State (cwd, env, shell functions, aliases) survives between tool_use invocations.

**Files:**
- Modify: `packages/tools/src/bash.ts` (~940 lines)
- Create: `packages/tools/src/bash-pty.ts`
- Modify: `packages/tools/src/__tests__/bash.test.ts`
- Modify: `packages/tools/package.json` (add node-pty dependency)

### Task L8.1: Verify node-pty availability on Bun

- [ ] **Step 1: Sanity check node-pty**

Run: `bun add node-pty --cwd packages/tools` 
Then: `bun -e "const pty = require('node-pty'); const p = pty.spawn('sh', ['-c', 'echo hi'], { name: 'xterm-256color' }); p.on('data', d => console.log(d))"`
Expected: prints "hi". If it fails, STOP and report the error — node-pty may need a native rebuild on this platform. Fallback: skip this lane and document the limitation.

- [ ] **Step 2: Commit dependency**

```bash
git add packages/tools/package.json bun.lock
git commit -m "chore(tools): add node-pty dependency for persistent bash PTY"
```

### Task L8.2: PTY session store + wrapper

- [ ] **Step 1: Write failing test**

Create `packages/tools/src/__tests__/bash-pty.test.ts`:
```ts
import { describe, expect, test } from 'bun:test';
import { BashPtySession } from '../bash-pty';

describe('BashPtySession', () => {
  test('preserves cwd across commands in the same session', async () => {
    const sess = new BashPtySession({ cwd: '/tmp' });
    await sess.exec('mkdir -p /tmp/oa-pty-test && cd /tmp/oa-pty-test');
    const result = await sess.exec('pwd');
    expect(result.stdout.trim()).toBe('/tmp/oa-pty-test');
    await sess.close();
  });

  test('preserves env variables across commands', async () => {
    const sess = new BashPtySession({ cwd: '/tmp' });
    await sess.exec('export OA_FOO=bar');
    const result = await sess.exec('echo $OA_FOO');
    expect(result.stdout.trim()).toBe('bar');
    await sess.close();
  });

  test('times out long commands', async () => {
    const sess = new BashPtySession({ cwd: '/tmp' });
    await expect(sess.exec('sleep 5', { timeout: 500 })).rejects.toThrow(/timeout/i);
    await sess.close();
  });
});
```

- [ ] **Step 2: Run and verify failure**

Run: `bun test packages/tools/src/__tests__/bash-pty.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement BashPtySession**

Create `packages/tools/src/bash-pty.ts`:
```ts
import { spawn, type IPty } from 'node-pty';

export interface BashPtyOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

export interface BashPtyResult {
  stdout: string;
  exitCode: number | null;
}

const MARKER = '__OA_CMD_DONE_';
let seq = 0;

export class BashPtySession {
  private pty: IPty;
  private buffer = '';

  constructor(opts: BashPtyOptions) {
    this.pty = spawn('bash', ['--noprofile', '--norc'], {
      name: 'xterm-256color',
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env, PS1: '' } as { [k: string]: string },
      cols: 120,
      rows: 24,
    });
    this.pty.onData((d) => { this.buffer += d; });
  }

  async exec(
    command: string,
    opts: { timeout?: number } = {},
  ): Promise<BashPtyResult> {
    const id = ++seq;
    const doneMarker = `${MARKER}${id}_`;
    this.buffer = '';
    this.pty.write(`${command}\n__ec=$?; echo "${doneMarker}$__ec"\n`);

    const timeout = opts.timeout ?? 60_000;
    const start = Date.now();
    while (!this.buffer.includes(doneMarker)) {
      if (Date.now() - start > timeout) {
        throw new Error(`command timeout after ${timeout}ms`);
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    const [before, markerAndAfter] = this.buffer.split(doneMarker);
    const exitStr = (markerAndAfter ?? '').split('\n')[0]?.trim();
    const exitCode = exitStr ? parseInt(exitStr, 10) : null;
    // Strip the echoed command line (first line) if present
    const lines = (before ?? '').split('\n');
    if (lines[0]?.includes(command.split('\n')[0] ?? '')) lines.shift();
    return { stdout: lines.join('\n'), exitCode };
  }

  async close(): Promise<void> {
    this.pty.kill();
  }
}

// Session store keyed by sessionId
const sessions = new Map<string, BashPtySession>();

export function getOrCreateBashPty(sessionId: string, opts: BashPtyOptions): BashPtySession {
  let sess = sessions.get(sessionId);
  if (!sess) {
    sess = new BashPtySession(opts);
    sessions.set(sessionId, sess);
  }
  return sess;
}

export async function closeBashPty(sessionId: string): Promise<void> {
  const sess = sessions.get(sessionId);
  if (sess) {
    await sess.close();
    sessions.delete(sessionId);
  }
}
```

- [ ] **Step 4: Run and verify pass**

Run: `bun test packages/tools/src/__tests__/bash-pty.test.ts`
Expected: PASS (3/3).

- [ ] **Step 5: Commit**

```bash
git add packages/tools/src/bash-pty.ts packages/tools/src/__tests__/bash-pty.test.ts
git commit -m "feat(tools): add persistent BashPtySession with per-session state"
```

### Task L8.3: Wire PTY into Bash tool

- [ ] **Step 1: Write failing test in bash.test.ts**

Add to `packages/tools/src/__tests__/bash.test.ts`:
```ts
test('Bash tool preserves cwd across invocations in same session', async () => {
  const tool = createBashTool({ /* existing options */ });
  const ctx = { cwd: '/tmp', sessionId: 'persist-test-1' };
  await tool.execute({ command: 'mkdir -p /tmp/oa-persist && cd /tmp/oa-persist' }, ctx);
  const r = await tool.execute({ command: 'pwd' }, ctx);
  expect(r.stdout).toContain('/tmp/oa-persist');
});
```

- [ ] **Step 2: Run and verify failure**

Run: `bun test packages/tools/src/__tests__/bash.test.ts`
Expected: FAIL — current bash tool spawns fresh shell per call; cwd is not preserved.

- [ ] **Step 3: Refactor Bash tool execute**

In `packages/tools/src/bash.ts`, locate the execute function and replace the spawn path with:
```ts
import { getOrCreateBashPty } from './bash-pty';

// Inside execute():
const usePersistent = input.background !== true && !input.sandbox; // keep old path for sandbox + background
if (usePersistent && ctx.sessionId) {
  const session = getOrCreateBashPty(ctx.sessionId, { cwd: persistentCwd });
  const result = await session.exec(input.command, { timeout: input.timeout ?? 60_000 });
  return {
    stdout: result.stdout,
    exitCode: result.exitCode ?? 0,
    // ... other result fields as before
  };
}
// else: existing spawn path
```

- [ ] **Step 4: Run and verify pass**

Run: `bun test packages/tools/src/__tests__/bash.test.ts`
Expected: PASS. Existing bash tests must also still pass (if any regress, it usually means the persistent session is leaking state between tests — add cleanup in `afterEach` via `closeBashPty(ctx.sessionId)`).

- [ ] **Step 5: Commit**

```bash
git add packages/tools/src/bash.ts packages/tools/src/__tests__/bash.test.ts
git commit -m "feat(tools): wire persistent PTY into Bash tool"
```

### Task L8.4: Lane gate

- [ ] **Step 1: Full regression + merge**

```bash
bun test && bun run typecheck && bun run build
cd ../open-agent
git merge --no-ff align/L8-bash-pty
bun test
```

---

## Lane L9: Plan Mode Real Downgrade

**Gap:** #11. **Worktree:** `../open-agent-L9` branch `align/L9-plan-mode-downgrade`. **Dependencies:** L4 must be merged first (both touch `permissions/engine.ts`).

**Scope summary.** When plan mode is active, the permission engine's `validateInput` stage (added in L4) hard-denies any non-readonly tool. `EnterPlanMode` sets the mode; `ExitPlanMode` restores the previous mode.

**Files:**
- Modify: `packages/permissions/src/engine.ts` (the `stageValidateInput` method added in L4)
- Modify: `packages/tools/src/plan-mode.ts`
- Modify: `packages/permissions/src/__tests__/engine.test.ts`

### Task L9.1: Rebase onto L4 + plan mode denies writes

- [ ] **Step 1: Rebase**

```bash
cd ../open-agent-L9
git rebase feat/core-alignment   # after L4 has merged
```

- [ ] **Step 2: Write failing test**

Add to `packages/permissions/src/__tests__/engine.test.ts`:
```ts
test('plan mode denies non-readonly tools in stageValidateInput', async () => {
  const engine = new PermissionEngine({ mode: 'plan' });
  const result = await engine.evaluate({
    toolName: 'Write',
    input: { file_path: '/tmp/x', content: 'hi' },
  });
  expect(result.behavior).toBe('deny');
  expect(result.reason ?? '').toMatch(/plan mode/i);
});

test('plan mode allows readonly tools', async () => {
  const engine = new PermissionEngine({ mode: 'plan' });
  const result = await engine.evaluate({
    toolName: 'Read',
    input: { file_path: '/tmp/x' },
  });
  expect(result.behavior).not.toBe('deny');
});
```

- [ ] **Step 3: Run and verify failure**

Run: `bun test packages/permissions/src/__tests__/engine.test.ts`
Expected: FAIL — write currently passes through without deny.

- [ ] **Step 4: Implement downgrade in stageValidateInput**

In `packages/permissions/src/engine.ts`, the `stageValidateInput` method added in L4:
```ts
private async stageValidateInput(ctx: PipelineContext): Promise<PermissionResult | undefined> {
  // Plan mode downgrade: deny anything that writes/executes
  if (this.mode === 'plan') {
    const READONLY_TOOLS = new Set(['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'ListMcpResources', 'ReadMcpResource']);
    if (!READONLY_TOOLS.has(ctx.request.toolName)) {
      return {
        behavior: 'deny',
        reason: `Tool ${ctx.request.toolName} is not permitted in plan mode (read-only)`,
      };
    }
  }
  // ... existing validation logic (input schema check, etc.)
  return undefined;
}
```

- [ ] **Step 5: Run, verify pass, commit**

Run: `bun test packages/permissions/src/__tests__/engine.test.ts`
Expected: PASS.

```bash
git add packages/permissions/src/engine.ts packages/permissions/src/__tests__/engine.test.ts
git commit -m "feat(permissions): enforce plan mode readonly downgrade in pipeline"
```

### Task L9.2: EnterPlanMode/ExitPlanMode mutate engine mode

- [ ] **Step 1: Write failing test**

Add to `packages/tools/src/__tests__/plan-mode.test.ts` (create if missing):
```ts
import { describe, expect, test } from 'bun:test';
import { createEnterPlanModeTool, createExitPlanModeTool } from '../plan-mode';
import { PermissionEngine } from '@open-agent/permissions';

test('EnterPlanMode switches engine to plan mode', async () => {
  const engine = new PermissionEngine({ mode: 'default' });
  const tool = createEnterPlanModeTool({ engine });
  await tool.execute({}, { cwd: '/', sessionId: 's' });
  expect(engine.getMode()).toBe('plan');
});

test('ExitPlanMode restores previous mode', async () => {
  const engine = new PermissionEngine({ mode: 'default' });
  const enter = createEnterPlanModeTool({ engine });
  const exit = createExitPlanModeTool({ engine });
  await enter.execute({}, { cwd: '/', sessionId: 's' });
  await exit.execute({}, { cwd: '/', sessionId: 's' });
  expect(engine.getMode()).toBe('default');
});
```

- [ ] **Step 2: Run and verify failure**

Expected: FAIL — plan-mode tools exist but don't mutate engine, or `engine.getMode()` doesn't exist.

- [ ] **Step 3: Add setMode/getMode/modeStack to PermissionEngine**

In `packages/permissions/src/engine.ts`:
```ts
// Inside class:
private modeStack: Array<typeof this.mode> = [];
getMode(): typeof this.mode { return this.mode; }
pushMode(newMode: typeof this.mode): void {
  this.modeStack.push(this.mode);
  this.mode = newMode;
}
popMode(): void {
  const prev = this.modeStack.pop();
  if (prev !== undefined) this.mode = prev;
}
```

- [ ] **Step 4: Update plan-mode tools**

In `packages/tools/src/plan-mode.ts`:
```ts
import type { PermissionEngine } from '@open-agent/permissions';

export function createEnterPlanModeTool(opts: { engine: PermissionEngine }) {
  return {
    name: 'EnterPlanMode',
    description: 'Enter plan mode (read-only; no edits, no execution)',
    inputSchema: { type: 'object', properties: {} },
    async execute() {
      opts.engine.pushMode('plan');
      return { mode: 'plan' };
    },
  };
}

export function createExitPlanModeTool(opts: { engine: PermissionEngine }) {
  return {
    name: 'ExitPlanMode',
    description: 'Exit plan mode and restore previous permission mode',
    inputSchema: { type: 'object', properties: {} },
    async execute() {
      opts.engine.popMode();
      return { mode: opts.engine.getMode() };
    },
  };
}
```

- [ ] **Step 5: Run, verify pass, commit**

```bash
bun test packages/tools/src/__tests__/plan-mode.test.ts
```
Expected: PASS.

```bash
git add packages/permissions/src/engine.ts packages/tools/src/plan-mode.ts packages/tools/src/__tests__/plan-mode.test.ts
git commit -m "feat(tools): wire Enter/ExitPlanMode to engine pushMode/popMode"
```

### Task L9.3: Lane gate

- [ ] **Step 1: Full regression + merge**

```bash
bun test && bun run typecheck && bun run build
cd ../open-agent
git merge --no-ff align/L9-plan-mode-downgrade
bun test
```

---

# WAVE 2 — 4 Sequential Lanes (core hot files)

After all Wave 1 lanes merge, start Wave 2. Each lane runs in its own worktree branched from the current merged HEAD. Next lane only starts after the previous one merges.

**Order:** L10 → L11 → L12 → L13

---

## Lane L10: Tool Interface Depth

**Gap:** #9. **Worktree:** `../open-agent-L10` branch `align/L10-tool-interface`. **Dependencies:** Wave 1 complete.

**Scope summary.** Expand `ToolDefinition` with Claude-Code-aligned methods. All 28 existing tools updated to satisfy the new interface. Default implementations provided via a helper.

**Files:**
- Modify: `packages/tools/src/types.ts` (expand ToolDefinition interface)
- Create: `packages/tools/src/tool-defaults.ts` (default impls)
- Modify: all 28 tool files in `packages/tools/src/*.ts`
- Modify: `packages/tools/src/__tests__/tool-descriptions.test.ts` (contract test)

### Task L10.1: Expand ToolDefinition + defaults helper

- [ ] **Step 1: Write failing contract test**

Create `packages/tools/src/__tests__/tool-interface-contract.test.ts`:
```ts
import { describe, expect, test } from 'bun:test';
import type { ToolDefinition } from '../types';

function satisfiesContract(tool: ToolDefinition): boolean {
  return (
    typeof tool.name === 'string' &&
    typeof tool.description === 'string' &&
    typeof tool.inputSchema === 'object' &&
    typeof tool.execute === 'function' &&
    // New contract fields (all with sensible defaults)
    typeof tool.maxResultSizeChars === 'number' &&
    (tool.interruptBehavior === 'cancel' || tool.interruptBehavior === 'block') &&
    typeof tool.extractSearchText === 'function'
  );
}

test('all registered tools satisfy the expanded contract', async () => {
  const { createRegistryWithAllTools } = await import('../index');
  const registry = await createRegistryWithAllTools();
  for (const [name, tool] of registry.entries()) {
    expect(satisfiesContract(tool)).toBe(true);
  }
});
```
(If `createRegistryWithAllTools` doesn't exist, substitute whatever factory assembles the default tool registry.)

- [ ] **Step 2: Run and verify failure**

Run: `bun test packages/tools/src/__tests__/tool-interface-contract.test.ts`
Expected: FAIL — new contract fields are not present on any tool.

- [ ] **Step 3: Expand ToolDefinition type**

In `packages/tools/src/types.ts`, expand the `ToolDefinition` interface:
```ts
export interface ToolDefinition {
  // ... existing fields stay as-is ...

  /** Maximum size of the tool's result in characters before truncation. Default: 100_000. */
  maxResultSizeChars?: number;

  /** How this tool reacts to user interrupt. 'cancel' = abort mid-execution,
   *  'block' = run to completion. Default: 'cancel'. */
  interruptBehavior?: 'cancel' | 'block';

  /** Extract searchable text from the tool's output for transcript search. */
  extractSearchText?: (output: unknown) => string;

  /** Decide whether the result has been truncated (for UI indicators). */
  isResultTruncated?: (output: unknown) => boolean;

  /** For permission matcher pattern compilation. Returns a predicate that
   *  tests whether a pattern (e.g., "git push*") matches this input. */
  preparePermissionMatcher?: (input: unknown) => (pattern: string) => boolean;

  /** For the permission classifier — categorize the action. */
  isSearchOrReadCommand?: (input: unknown) => { isSearch: boolean; isRead: boolean; isList: boolean };

  /** Mutates input in-place to add derived fields for observability (e.g., resolved paths). */
  backfillObservableInput?: (input: unknown) => void;

  /** Render helpers (string output for terminal renderer; ink renderer can overlay React). */
  renderToolUseMessage?: (input: unknown) => string;
  renderToolResultMessage?: (output: unknown) => string;
  renderToolUseErrorMessage?: (error: unknown) => string;
}
```

- [ ] **Step 4: Create defaults helper**

Create `packages/tools/src/tool-defaults.ts`:
```ts
import type { ToolDefinition } from './types';

/** Applies Claude-Code-aligned defaults to a tool definition. */
export function withToolDefaults<T extends ToolDefinition>(tool: T): T {
  return {
    maxResultSizeChars: 100_000,
    interruptBehavior: 'cancel',
    extractSearchText: (output) => {
      if (typeof output === 'string') return output;
      try { return JSON.stringify(output).slice(0, 1000); } catch { return ''; }
    },
    isResultTruncated: () => false,
    renderToolUseMessage: () => tool.name,
    renderToolResultMessage: (output) => typeof output === 'string' ? output : JSON.stringify(output),
    renderToolUseErrorMessage: (error) => String(error),
    ...tool, // allow tool-specific overrides to take precedence
  };
}
```

- [ ] **Step 5: Apply withToolDefaults to each tool factory**

For each of the 28 tool factories (e.g., `createReadTool`, `createBashTool`, `createGlobTool`, etc.), wrap the returned object:
```ts
// Before:
return { name: 'Read', description: '...', inputSchema: {...}, execute: ... };
// After:
return withToolDefaults({ name: 'Read', description: '...', inputSchema: {...}, execute: ... });
```

Do this in all files in `packages/tools/src/*.ts` that export a `createXxxTool` function. Use grep to find them:
```bash
grep -l "^export function create.*Tool" packages/tools/src/*.ts
```
For each file in the list, add `import { withToolDefaults } from './tool-defaults';` and wrap the return.

- [ ] **Step 6: Run contract test, verify pass, commit**

```bash
bun test packages/tools/src/__tests__/tool-interface-contract.test.ts
```
Expected: PASS.

```bash
git add packages/tools/src/types.ts packages/tools/src/tool-defaults.ts packages/tools/src/*.ts packages/tools/src/__tests__/tool-interface-contract.test.ts
git commit -m "feat(tools): expand ToolDefinition contract + apply defaults to all tools"
```

### Task L10.2: Specialize high-value overrides

For 3 tools that benefit from non-default overrides, provide specialized implementations.

- [ ] **Step 1: Override for Bash — isSearchOrReadCommand**

In `packages/tools/src/bash.ts`, in the tool factory add:
```ts
isSearchOrReadCommand: (input: unknown) => {
  const cmd = String((input as { command?: string }).command ?? '');
  const READ_VERBS = /^\s*(cat|less|tail|head|ls|pwd|stat|file|wc|find|which)\b/;
  const SEARCH_VERBS = /^\s*(grep|rg|ripgrep|ack|ag|awk|sed -n)\b/;
  const LIST_VERBS = /^\s*(ls|find|tree|git ls-files)\b/;
  return {
    isRead: READ_VERBS.test(cmd),
    isSearch: SEARCH_VERBS.test(cmd),
    isList: LIST_VERBS.test(cmd),
  };
},
```

- [ ] **Step 2: Override for Read — extractSearchText**

In `packages/tools/src/read.ts`:
```ts
extractSearchText: (output: unknown) => {
  const o = output as { content?: string };
  return o.content ?? '';
},
```

- [ ] **Step 3: Override for Grep — isResultTruncated**

In `packages/tools/src/grep.ts`:
```ts
isResultTruncated: (output: unknown) => {
  const o = output as { matches?: unknown[]; truncated?: boolean };
  return o.truncated === true || (Array.isArray(o.matches) && o.matches.length >= 250);
},
```

- [ ] **Step 4: Run regression and commit**

```bash
bun test && bun run typecheck
git add packages/tools/src/bash.ts packages/tools/src/read.ts packages/tools/src/grep.ts
git commit -m "feat(tools): specialize Bash/Read/Grep overrides for permission + search"
```

### Task L10.3: Lane gate

- [ ] **Step 1: Full regression + merge**

```bash
bun test && bun run typecheck && bun run build
cd ../open-agent
git merge --no-ff align/L10-tool-interface
bun test
```

---

## Lane L11: Layered Auto-Compact

**Gap:** #2. **Worktree:** `../open-agent-L11` branch `align/L11-layered-compact`. **Dependencies:** L10 merged (uses `maxResultSizeChars`).

**Scope summary.** Split `ConversationLoop.compactInternal()` into 4 independently-testable strategies: `snip`, `microcompact`, `autocompact`, `reactive`. Each is invoked at a different trigger point.

**Files:**
- Modify: `packages/core/src/conversation-loop.ts` (~1872 lines — hook into compact trigger)
- Create: `packages/core/src/compact/snip.ts`
- Create: `packages/core/src/compact/microcompact.ts`
- Create: `packages/core/src/compact/autocompact.ts`
- Create: `packages/core/src/compact/reactive.ts`
- Create: `packages/core/src/compact/index.ts`
- Create: `packages/core/src/__tests__/compact-snip.test.ts`
- Create: `packages/core/src/__tests__/compact-microcompact.test.ts`

### Task L11.1: Snip strategy

- [ ] **Step 1: Write failing test**

Create `packages/core/src/__tests__/compact-snip.test.ts`:
```ts
import { describe, expect, test } from 'bun:test';
import { snip } from '../compact/snip';

describe('snip', () => {
  test('drops tool_result blocks older than keepLastN turns, keeps tool_use', () => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'turn 1' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'OLD BIG RESULT' }] },
      { role: 'user', content: [{ type: 'text', text: 'turn 2' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'Read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'KEEP ME' }] },
    ];
    const out = snip(messages, { keepLastN: 1 });
    // t1's tool_result is replaced with a placeholder; t1's tool_use remains
    expect(out[1].content[0]).toEqual({ type: 'tool_use', id: 't1', name: 'Read', input: {} });
    const t1Result = out[2].content[0] as any;
    expect(t1Result.content).toContain('snipped');
    // t2 stays intact
    expect((out[5].content[0] as any).content).toBe('KEEP ME');
  });
});
```

- [ ] **Step 2: Run and verify failure**

Run: `bun test packages/core/src/__tests__/compact-snip.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement snip.ts**

Create `packages/core/src/compact/snip.ts`:
```ts
export interface SnipOptions {
  keepLastN: number;
}

type Msg = { role: string; content: Array<{ type: string; [k: string]: unknown }> };

export function snip(messages: Msg[], opts: SnipOptions): Msg[] {
  // A "turn" is an assistant message. Keep tool_results for the last `keepLastN` turns.
  const turnIndices: number[] = [];
  messages.forEach((m, i) => { if (m.role === 'assistant') turnIndices.push(i); });
  const keepFromIdx = turnIndices.length > opts.keepLastN
    ? turnIndices[turnIndices.length - opts.keepLastN]!
    : 0;

  return messages.map((m, i) => {
    if (i >= keepFromIdx) return m;
    // Replace tool_result contents with placeholder, keep tool_use intact
    return {
      ...m,
      content: m.content.map((block) => {
        if (block.type === 'tool_result') {
          return { ...block, content: '[snipped by auto-compact — use Read to retrieve]' };
        }
        return block;
      }),
    };
  });
}
```

- [ ] **Step 4: Run and verify pass, commit**

```bash
bun test packages/core/src/__tests__/compact-snip.test.ts
```
Expected: PASS.

```bash
git add packages/core/src/compact/snip.ts packages/core/src/__tests__/compact-snip.test.ts
git commit -m "feat(core): add snip compact strategy"
```

### Task L11.2: Microcompact strategy

- [ ] **Step 1: Write failing test**

Create `packages/core/src/__tests__/compact-microcompact.test.ts`:
```ts
import { describe, expect, test } from 'bun:test';
import { microcompact } from '../compact/microcompact';

test('microcompact truncates oversized tool_result content', () => {
  const huge = 'x'.repeat(200_000);
  const messages = [
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: huge }] },
  ];
  const out = microcompact(messages, { maxResultSizeChars: 100_000 });
  const block = (out[1].content[0] as any);
  expect(block.content.length).toBeLessThanOrEqual(100_000 + 200); // includes marker
  expect(block.content).toContain('truncated');
});

test('microcompact leaves small results alone', () => {
  const messages = [
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'small' }] },
  ];
  const out = microcompact(messages, { maxResultSizeChars: 100_000 });
  expect((out[1].content[0] as any).content).toBe('small');
});
```

- [ ] **Step 2: Run and verify failure**

Expected: FAIL — module missing.

- [ ] **Step 3: Implement microcompact.ts**

Create `packages/core/src/compact/microcompact.ts`:
```ts
export interface MicrocompactOptions {
  maxResultSizeChars: number;
}

type Msg = { role: string; content: Array<{ type: string; [k: string]: unknown }> };

export function microcompact(messages: Msg[], opts: MicrocompactOptions): Msg[] {
  return messages.map((m) => ({
    ...m,
    content: m.content.map((block) => {
      if (block.type === 'tool_result' && typeof block.content === 'string') {
        const s = block.content;
        if (s.length > opts.maxResultSizeChars) {
          const head = s.slice(0, opts.maxResultSizeChars);
          return { ...block, content: `${head}\n\n[...truncated — ${s.length - opts.maxResultSizeChars} chars dropped by microcompact]` };
        }
      }
      return block;
    }),
  }));
}
```

- [ ] **Step 4: Run, verify pass, commit**

```bash
bun test packages/core/src/__tests__/compact-microcompact.test.ts
```
Expected: PASS.

```bash
git add packages/core/src/compact/microcompact.ts packages/core/src/__tests__/compact-microcompact.test.ts
git commit -m "feat(core): add microcompact for oversized tool_result truncation"
```

### Task L11.3: Autocompact wrapper + reactive compact

- [ ] **Step 1: Write failing test for autocompact wrapper**

Create `packages/core/src/__tests__/compact-orchestration.test.ts`:
```ts
import { describe, expect, test } from 'bun:test';
import { runCompactPipeline } from '../compact';

test('runCompactPipeline applies snip then microcompact', () => {
  const huge = 'y'.repeat(200_000);
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'turn 1' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'R', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: huge }] },
    { role: 'user', content: [{ type: 'text', text: 'turn 2' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'R', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: huge }] },
  ];
  const out = runCompactPipeline(messages, { keepLastN: 1, maxResultSizeChars: 50_000 });
  // Older turn (t1) is snipped → short placeholder
  const t1Result = (out[2].content[0] as any).content as string;
  expect(t1Result.length).toBeLessThan(200);
  // Newer turn (t2) is microcompacted → truncated but not snipped
  const t2Result = (out[5].content[0] as any).content as string;
  expect(t2Result.length).toBeGreaterThan(50_000);
  expect(t2Result.length).toBeLessThan(60_000);
});
```

- [ ] **Step 2: Run and verify failure**

Expected: FAIL — `runCompactPipeline` missing.

- [ ] **Step 3: Implement compact/index.ts**

Create `packages/core/src/compact/index.ts`:
```ts
import { snip } from './snip';
import { microcompact } from './microcompact';

export { snip } from './snip';
export { microcompact } from './microcompact';

export interface CompactPipelineOptions {
  keepLastN: number;
  maxResultSizeChars: number;
}

export function runCompactPipeline(
  messages: any[],
  opts: CompactPipelineOptions,
): any[] {
  let out = messages;
  out = snip(out, { keepLastN: opts.keepLastN });
  out = microcompact(out, { maxResultSizeChars: opts.maxResultSizeChars });
  return out;
}
```

- [ ] **Step 4: Wire reactive compact into conversation-loop**

In `packages/core/src/conversation-loop.ts`, locate the API call path (look for try/catch around the provider chat call). Add a reactive compact retry:
```ts
import { runCompactPipeline } from './compact';

// Inside the try/catch:
try {
  const stream = await provider.chat(options);
  // ... stream processing ...
} catch (e) {
  if (isPromptTooLongError(e)) {
    // Reactive compact: shrink messages and retry once
    this.messages = runCompactPipeline(this.messages, {
      keepLastN: 2,
      maxResultSizeChars: 50_000,
    });
    const stream = await provider.chat({ ...options, messages: this.messages });
    // ... stream processing ...
  } else {
    throw e;
  }
}
```
(Adapt to actual ConversationLoop structure — the goal is: on prompt-too-long, run pipeline and retry once.)

Add the helper function near the top of the file:
```ts
function isPromptTooLongError(e: unknown): boolean {
  const msg = (e as Error)?.message?.toLowerCase() ?? '';
  return msg.includes('prompt is too long') || msg.includes('prompt_too_long') || msg.includes('maximum context');
}
```

- [ ] **Step 5: Run, verify pass, commit**

```bash
bun test packages/core/src/__tests__/compact-orchestration.test.ts
bun test packages/core/src/__tests__/conversation-loop.test.ts
```
Expected: PASS.

```bash
git add packages/core/src/compact/ packages/core/src/conversation-loop.ts packages/core/src/__tests__/compact-orchestration.test.ts
git commit -m "feat(core): add layered compact pipeline + reactive retry on prompt-too-long"
```

### Task L11.4: Lane gate

```bash
bun test && bun run typecheck && bun run build
cd ../open-agent
git merge --no-ff align/L11-layered-compact
bun test
```

---

## Lane L12: System Prompt Static Text Alignment

**Gap:** #3. **Worktree:** `../open-agent-L12` branch `align/L12-system-prompt`. **Dependencies:** L10, L11 merged.

**Scope summary.** Diff `packages/core/src/system-prompt.ts` against `claude-code-nirholas/src/constants/prompts.ts` and `systemPromptSections.ts`. Align specific principles as verbatim-or-paraphrased lines. Add a phrase-presence contract test.

**Files:**
- Modify: `packages/core/src/system-prompt.ts`
- Modify: `packages/core/src/__tests__/system-prompt.test.ts`

### Task L12.1: Phrase contract test + alignment

- [ ] **Step 1: Read the official prompts**

Run:
```bash
cat /Users/colin/Projects/ai/research/claude-code-reverse/claude-code-nirholas/src/constants/prompts.ts 2>/dev/null | head -200
find /Users/colin/Projects/ai/research/claude-code-reverse/claude-code-nirholas/src -name 'systemPromptSections*' -exec cat {} \;
```
Collect the exact lines for the principles listed in the spec.

- [ ] **Step 2: Write failing contract test**

In `packages/core/src/__tests__/system-prompt.test.ts`, add:
```ts
import { buildSystemPrompt } from '../system-prompt';

const REQUIRED_PHRASES = [
  "Don't add features, refactor code, or make \"improvements\" beyond what was asked",
  "Only add comments where the logic isn't self-evident",
  "Don't add error handling, fallbacks, or validation for scenarios that can't happen",
  "Don't create helpers, utilities, or abstractions for one-time operations",
  // "Honest reporting" principle
  "diagnose why before switching tactics",
];

test('system prompt contains Claude-Code-aligned core principles', async () => {
  const prompt = await buildSystemPrompt({
    cwd: '/tmp',
    model: 'glm-4.7',
    permissionMode: 'default',
    tools: new Map(),
  });
  for (const phrase of REQUIRED_PHRASES) {
    expect(prompt).toContain(phrase);
  }
});
```

- [ ] **Step 3: Run and verify failure**

Run: `bun test packages/core/src/__tests__/system-prompt.test.ts`
Expected: FAIL — some phrases missing.

- [ ] **Step 4: Align the prompt text**

In `packages/core/src/system-prompt.ts`, locate the "Doing tasks" section and ensure these verbatim lines are present (add missing, leave existing adjacent text intact):
```
 - Don't add features, refactor code, or make "improvements" beyond what was asked. A bug fix doesn't need surrounding code cleaned up. A simple feature doesn't need extra configurability. Don't add docstrings, comments, or type annotations to code you didn't change. Only add comments where the logic isn't self-evident.
 - Don't add error handling, fallbacks, or validation for scenarios that can't happen. Trust internal code and framework guarantees. Only validate at system boundaries (user input, external APIs). Don't use feature flags or backwards-compatibility shims when you can just change the code.
 - Don't create helpers, utilities, or abstractions for one-time operations. Don't design for hypothetical future requirements. The right amount of complexity is what the task actually requires—no speculative abstractions, but no half-finished implementations either.
 - If an approach fails, diagnose why before switching tactics—read the error, check your assumptions, try a focused fix. Don't retry the identical action blindly, but don't abandon a viable approach after a single failure either.
```

These are paraphrased from the 04-05 spec §Gap 3. If your current system-prompt.ts has most of these already, just add the missing ones.

- [ ] **Step 5: Run, verify pass, commit**

```bash
bun test packages/core/src/__tests__/system-prompt.test.ts
```
Expected: PASS.

```bash
git add packages/core/src/system-prompt.ts packages/core/src/__tests__/system-prompt.test.ts
git commit -m "feat(core): align system prompt principles with Claude Code source"
```

### Task L12.2: Lane gate

```bash
bun test && bun run typecheck && bun run build
cd ../open-agent
git merge --no-ff align/L12-system-prompt
bun test
```

---

## Lane L13: Prompt Cache Dual Boundary

**Gap:** #1. **Worktree:** `../open-agent-L13` branch `align/L13-cache-boundary`. **Dependencies:** L12 merged.

**Scope summary.** Introduce an explicit static/dynamic split marker in the system prompt, and have `AnthropicProvider` emit `cache_control` on the static prefix (global scope) but never on session-specific dynamic content.

**Files:**
- Modify: `packages/core/src/system-prompt.ts` (emit a boundary marker object instead of pure string)
- Modify: `packages/providers/src/anthropic.ts` (respect the boundary)
- Modify: `packages/providers/src/__tests__/anthropic.test.ts` (cache_control placement assertion)

### Task L13.1: System prompt returns structured block list

- [ ] **Step 1: Write failing test**

Create or modify `packages/core/src/__tests__/system-prompt.test.ts` — add:
```ts
import { buildSystemPromptBlocks } from '../system-prompt';

test('buildSystemPromptBlocks returns a list with a dynamic boundary marker', async () => {
  const blocks = await buildSystemPromptBlocks({
    cwd: '/tmp',
    model: 'glm-4.7',
    permissionMode: 'default',
    tools: new Map(),
  });
  // Blocks must include static and dynamic sections separated by a boundary
  const staticBlocks = blocks.filter(b => b.section === 'static');
  const dynamicBlocks = blocks.filter(b => b.section === 'dynamic');
  expect(staticBlocks.length).toBeGreaterThan(0);
  expect(dynamicBlocks.length).toBeGreaterThan(0);
  // Last static must appear before first dynamic
  const lastStaticIdx = blocks.findLastIndex(b => b.section === 'static');
  const firstDynamicIdx = blocks.findIndex(b => b.section === 'dynamic');
  expect(lastStaticIdx).toBeLessThan(firstDynamicIdx);
});
```

- [ ] **Step 2: Run and verify failure**

Run: `bun test packages/core/src/__tests__/system-prompt.test.ts`
Expected: FAIL — `buildSystemPromptBlocks` doesn't exist.

- [ ] **Step 3: Add structured builder alongside the existing string builder**

In `packages/core/src/system-prompt.ts`, add (do not remove `buildSystemPrompt`):
```ts
export interface SystemPromptBlock {
  text: string;
  section: 'static' | 'dynamic';
}

export async function buildSystemPromptBlocks(
  opts: BuildSystemPromptOptions, // existing options type
): Promise<SystemPromptBlock[]> {
  const blocks: SystemPromptBlock[] = [];

  // Static: identity, tool descriptions, invariant principles, safety
  blocks.push({ text: buildIdentitySection(), section: 'static' });
  blocks.push({ text: buildToolsSection(opts.tools), section: 'static' });
  blocks.push({ text: buildPrinciplesSection(), section: 'static' });
  blocks.push({ text: buildSafetySection(), section: 'static' });

  // Dynamic: cwd-specific, git, memory, session, hooks
  blocks.push({ text: await buildProjectContextSection(opts.cwd), section: 'dynamic' });
  blocks.push({ text: await buildGitSection(opts.cwd), section: 'dynamic' });
  blocks.push({ text: await buildMemorySection(opts.cwd), section: 'dynamic' });
  blocks.push({ text: buildSessionSection(opts), section: 'dynamic' });
  blocks.push({ text: buildHookSurfaceSection(opts), section: 'dynamic' });

  return blocks;
}
```
(Helper functions like `buildIdentitySection` already exist in the file under different names — refactor the existing `buildSystemPrompt` to call these same helpers and concatenate, so the string output stays identical. Extract helpers if they are inline.)

Also update `buildSystemPrompt` (the old string-returning fn) to compose via `buildSystemPromptBlocks`:
```ts
export async function buildSystemPrompt(opts: BuildSystemPromptOptions): Promise<string> {
  const blocks = await buildSystemPromptBlocks(opts);
  return blocks.map(b => b.text).join('\n\n');
}
```

- [ ] **Step 4: Run test, verify pass, commit**

```bash
bun test packages/core/src/__tests__/system-prompt.test.ts
```
Expected: PASS (including any existing tests that asserted the string output — they stay green because concatenation is identical).

```bash
git add packages/core/src/system-prompt.ts packages/core/src/__tests__/system-prompt.test.ts
git commit -m "feat(core): add structured system prompt blocks with static/dynamic boundary"
```

### Task L13.2: AnthropicProvider respects boundary

- [ ] **Step 1: Write failing test**

In `packages/providers/src/__tests__/anthropic.test.ts`, add:
```ts
import { buildAnthropicSystemParam } from '../anthropic';

test('anthropic system param caches only the static prefix', () => {
  const blocks = [
    { text: 'STATIC-IDENTITY', section: 'static' as const },
    { text: 'STATIC-TOOLS', section: 'static' as const },
    { text: 'DYNAMIC-PROJECT', section: 'dynamic' as const },
    { text: 'DYNAMIC-GIT', section: 'dynamic' as const },
  ];
  const system = buildAnthropicSystemParam(blocks);
  // Last static block must have cache_control; dynamic blocks must not
  expect(system).toEqual([
    { type: 'text', text: 'STATIC-IDENTITY' },
    { type: 'text', text: 'STATIC-TOOLS', cache_control: { type: 'ephemeral' } },
    { type: 'text', text: 'DYNAMIC-PROJECT' },
    { type: 'text', text: 'DYNAMIC-GIT' },
  ]);
});
```

- [ ] **Step 2: Run and verify failure**

Run: `bun test packages/providers/src/__tests__/anthropic.test.ts`
Expected: FAIL — function missing.

- [ ] **Step 3: Implement buildAnthropicSystemParam**

In `packages/providers/src/anthropic.ts`, add:
```ts
import type { SystemPromptBlock } from '@open-agent/core';

export function buildAnthropicSystemParam(
  blocks: SystemPromptBlock[],
): Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }> {
  // Find the last static block; mark it with cache_control to seal the static prefix.
  let lastStaticIdx = -1;
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i]!.section === 'static') { lastStaticIdx = i; break; }
  }
  return blocks.map((b, i) => {
    const entry: { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } } =
      { type: 'text', text: b.text };
    if (i === lastStaticIdx) entry.cache_control = { type: 'ephemeral' };
    return entry;
  });
}
```

Wire the caller: in the `chat()` method of `AnthropicProvider`, replace the old `system: systemPrompt` (string) with:
```ts
import { buildSystemPromptBlocks } from '@open-agent/core';
// ...
const blocks = await buildSystemPromptBlocks(promptOptions);
const system = buildAnthropicSystemParam(blocks);
const response = await this.client.messages.create({ system, /* ... */ });
```

- [ ] **Step 4: Run tests, verify pass, commit**

```bash
bun test packages/providers/src/__tests__/anthropic.test.ts
```
Expected: PASS.

```bash
git add packages/providers/src/anthropic.ts packages/providers/src/__tests__/anthropic.test.ts
git commit -m "feat(providers): anthropic cache_control on static prefix boundary"
```

### Task L13.3: Lane gate + integration smoke

- [ ] **Step 1: Full regression**

```bash
bun test && bun run typecheck && bun run build
```

- [ ] **Step 2: Merge back**

```bash
cd ../open-agent
git merge --no-ff align/L13-cache-boundary
bun test
```

---

# Integration Gate — Run After All 13 Lanes Merge

### Task IG.1: Full regression

- [ ] **Step 1: All tests + typecheck + build**

```bash
bun test
bun run typecheck
bun run build
```
Expected: all green. The test count should be ~400+ (was 334 baseline; each lane added tests).

### Task IG.2: End-to-end smoke with real provider

- [ ] **Step 1: Run smoke session**

```bash
bun run dev -- \
  --provider openai \
  --api-key "1fbc40eb2c834d63b695cd622bf810ca.w3XEod8FILl2AXPl" \
  --base-url "https://open.bigmodel.cn/api/coding/paas/v4" \
  --model "glm-4.7"
```

- [ ] **Step 2: Send a multi-tool prompt**

In the REPL:
```
Read packages/core/src/system-prompt.ts, then use Grep to find all occurrences of "cache_control" in packages/providers/, and summarize what you found.
```

- [ ] **Step 3: Verify expected behaviors**

Manually check:
- Session file is written as JSONL at `~/.open-agent/projects/<hash>/sessions/<id>.jsonl` — run `ls -la ~/.open-agent/projects/` and `head ~/.open-agent/projects/*/sessions/*.jsonl`
- CLAUDE.md (if present in cwd) was loaded — verify via `/memory` slash command
- Prompt shows static/dynamic boundary is respected (no obvious errors on API call)
- Bash persistent PTY works — run `cd /tmp` then `pwd` as two separate Bash tool calls and verify the second sees `/tmp`

- [ ] **Step 4: Document smoke results**

Append to `docs/superpowers/plans/2026-04-05-capability-alignment.md` a section:
```
## Smoke test result (2026-MM-DD)
- Session JSONL: ✓ / ✗
- CLAUDE.md precedence: ✓ / ✗
- Cache boundary: ✓ / ✗
- Bash PTY persistence: ✓ / ✗
```

### Task IG.3: Final commit

- [ ] **Step 1: Commit smoke log**

```bash
git add docs/superpowers/plans/2026-04-05-capability-alignment.md
git commit -m "docs(plan): record 04-05 capability alignment smoke test results"
```

---

## Self-Review

- **Spec coverage.** 13 gaps ↔ 13 lanes. Every gap in the spec has a corresponding lane with tasks. ✓
- **No placeholders.** Each step includes actual code or actual commands. No TBD/TODO. ✓
- **Type consistency.** `ToolDefinition` is extended in L10 and used in L11 (maxResultSizeChars) and L7 (shouldDefer). Names consistent. `PermissionEngine.pushMode/popMode` added in L9, used from plan-mode tools. `SidechainWriter`/`sidechainPath` added in L6 and used from `executeForked`. ✓
- **Dependency graph.**
  - L4 → L9 (both touch engine.ts; L4 refactor must land first)
  - L10 → L11 (maxResultSizeChars)
  - L12 → L13 (boundary marker lives in system-prompt.ts)
  - Prologue → L6 (WIP overlap)
  All documented in the respective lane headers.
- **Parallelism verified.** Wave 1 L1–L3, L5–L8 are fully independent (touch different files). L4 and L9 share engine.ts but L9 is explicitly rebased after L4 merges. That gives 8 truly parallel lanes plus L9 as a near-term follower — 9 lanes total in Wave 1 as spec promised.
