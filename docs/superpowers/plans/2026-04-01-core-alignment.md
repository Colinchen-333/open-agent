# Core Capability Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align open-agent core infrastructure with Claude Code — reactive state store, enriched message types, streaming parallel tool executor, React+Ink terminal UI.

**Architecture:** Bottom-up in 4 phases: (C) new `@open-agent/state` package with Zustand-like store → (B) enrich `SDKMessage` discriminated union with subtypes/progress/tombstone → (A) extract `StreamingToolExecutor` from ConversationLoop → (D) new `@open-agent/ink` package replacing imperative renderer with React+Ink components driven by the store.

**Tech Stack:** Bun, TypeScript, React 18, Ink 5, bun:test

**Spec:** `docs/superpowers/specs/2026-04-01-core-alignment-design.md`

---

## Phase C: Reactive State Management

### Task 1: Create `@open-agent/state` package scaffold

**Files:**
- Create: `packages/state/package.json`
- Create: `packages/state/tsconfig.json`
- Create: `packages/state/src/index.ts`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "@open-agent/state",
  "version": "0.1.0",
  "type": "module",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "scripts": {
    "test": "bun test",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "typescript": "^5.7.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: Create empty `src/index.ts`**

```typescript
// @open-agent/state — reactive store
```

- [ ] **Step 4: Add workspace to root package.json**

The root `package.json` already has `"workspaces": ["packages/*", "apps/*"]`, so `packages/state/` is auto-discovered. Verify:

Run: `cd /Users/colin/Projects/open-agent && bun install`
Expected: No errors, `@open-agent/state` appears in workspace list.

- [ ] **Step 5: Commit**

```bash
git add packages/state/
git commit -m "feat(state): scaffold @open-agent/state package"
```

---

### Task 2: Implement `createStore` with tests

**Files:**
- Create: `packages/state/src/__tests__/store.test.ts`
- Modify: `packages/state/src/index.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// packages/state/src/__tests__/store.test.ts
import { describe, it, expect, mock } from 'bun:test';
import { createStore } from '../index.js';

describe('createStore', () => {
  it('returns initial state via getState()', () => {
    const store = createStore({ count: 0 });
    expect(store.getState()).toEqual({ count: 0 });
  });

  it('updates state via setState()', () => {
    const store = createStore({ count: 0 });
    store.setState(prev => ({ ...prev, count: prev.count + 1 }));
    expect(store.getState()).toEqual({ count: 1 });
  });

  it('skips update when state identity unchanged (Object.is)', () => {
    const listener = mock(() => {});
    const initial = { count: 0 };
    const store = createStore(initial);
    store.subscribe(listener);

    store.setState(prev => prev); // identity — no change
    expect(listener).not.toHaveBeenCalled();
  });

  it('notifies subscribers on state change', () => {
    const listener = mock(() => {});
    const store = createStore({ count: 0 });
    store.subscribe(listener);

    store.setState(prev => ({ ...prev, count: 1 }));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('unsubscribe stops notifications', () => {
    const listener = mock(() => {});
    const store = createStore({ count: 0 });
    const unsub = store.subscribe(listener);

    unsub();
    store.setState(prev => ({ ...prev, count: 1 }));
    expect(listener).not.toHaveBeenCalled();
  });

  it('calls onChange callback with prev and next', () => {
    const onChange = mock(() => {});
    const store = createStore({ count: 0 }, onChange);

    store.setState(prev => ({ ...prev, count: 5 }));
    expect(onChange).toHaveBeenCalledWith({ count: 0 }, { count: 5 });
  });

  it('supports multiple subscribers', () => {
    const a = mock(() => {});
    const b = mock(() => {});
    const store = createStore({ x: 1 });
    store.subscribe(a);
    store.subscribe(b);

    store.setState(prev => ({ ...prev, x: 2 }));
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/colin/Projects/open-agent && bun test packages/state/`
Expected: FAIL — `createStore` not exported.

- [ ] **Step 3: Implement createStore**

```typescript
// packages/state/src/index.ts
export type Store<T> = {
  getState(): T;
  setState(updater: (prev: T) => T): void;
  subscribe(listener: () => void): () => void;
};

export function createStore<T>(
  initialState: T,
  onChange?: (prev: T, next: T) => void,
): Store<T> {
  let state = initialState;
  const listeners = new Set<() => void>();

  return {
    getState() {
      return state;
    },

    setState(updater) {
      const prev = state;
      const next = updater(prev);
      if (Object.is(prev, next)) return;
      state = next;
      onChange?.(prev, next);
      for (const listener of listeners) {
        listener();
      }
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/colin/Projects/open-agent && bun test packages/state/`
Expected: 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/state/src/
git commit -m "feat(state): implement createStore with Zustand-like API"
```

---

### Task 3: Define AppState type

**Files:**
- Create: `packages/state/src/app-state.ts`
- Modify: `packages/state/src/index.ts`

- [ ] **Step 1: Create AppState type definition**

```typescript
// packages/state/src/app-state.ts
import type { ToolDefinition } from '@open-agent/tools';
import type {
  PermissionMode,
  ThinkingConfig,
  AgentDefinition,
} from '@open-agent/core';

export interface FileReadTracker {
  markRead(filePath: string): void;
  hasBeenRead(filePath: string): boolean;
}

export interface TaskItem {
  id: string;
  subject: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'deleted';
  owner?: string;
  activeForm?: string;
  blocks?: string[];
  blockedBy?: string[];
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

export interface AgentInstance {
  id: string;
  name: string;
  type: string;
  definition: AgentDefinition;
  status: 'running' | 'idle' | 'completed' | 'failed';
  parentAgentId?: string;
  teamName?: string;
  createdAt: string;
}

export interface McpServerStatus {
  name: string;
  status: 'connected' | 'connecting' | 'disconnected' | 'error';
  toolCount: number;
  error?: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface AppState {
  // Session
  sessionId: string;
  cwd: string;
  model: string;
  permissionMode: PermissionMode;

  // Conversation
  // Note: `messages` lives in ConversationLoop, not in AppState.
  // The store tracks aggregate state; message history is the loop's responsibility.
  totalUsage: TokenUsage;

  // Tools
  tools: Map<string, ToolDefinition>;
  fileReadTracker: FileReadTracker;

  // MCP
  mcpServers: McpServerStatus[];

  // Agents & Tasks
  tasks: Record<string, TaskItem>;
  teammates: Map<string, AgentInstance>;
  agentNameRegistry: Map<string, string>;

  // Settings
  thinkingConfig: ThinkingConfig;
  verbose: boolean;
}

export function createDefaultAppState(overrides: Partial<AppState> = {}): AppState {
  const readFiles = new Set<string>();
  return {
    sessionId: '',
    cwd: process.cwd(),
    model: '',
    permissionMode: 'default',
    totalUsage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    tools: new Map(),
    fileReadTracker: {
      markRead: (p: string) => readFiles.add(p),
      hasBeenRead: (p: string) => readFiles.has(p),
    },
    mcpServers: [],
    tasks: {},
    teammates: new Map(),
    agentNameRegistry: new Map(),
    thinkingConfig: { type: 'adaptive' },
    verbose: false,
    ...overrides,
  };
}
```

- [ ] **Step 2: Add dependency on @open-agent/core and @open-agent/tools**

In `packages/state/package.json`, add:
```json
{
  "dependencies": {
    "@open-agent/core": "workspace:*",
    "@open-agent/tools": "workspace:*"
  }
}
```

Run: `cd /Users/colin/Projects/open-agent && bun install`

- [ ] **Step 3: Re-export from index.ts**

```typescript
// packages/state/src/index.ts
export type Store<T> = {
  getState(): T;
  setState(updater: (prev: T) => T): void;
  subscribe(listener: () => void): () => void;
};

export function createStore<T>(
  initialState: T,
  onChange?: (prev: T, next: T) => void,
): Store<T> {
  let state = initialState;
  const listeners = new Set<() => void>();

  return {
    getState() {
      return state;
    },

    setState(updater) {
      const prev = state;
      const next = updater(prev);
      if (Object.is(prev, next)) return;
      state = next;
      onChange?.(prev, next);
      for (const listener of listeners) {
        listener();
      }
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export {
  type AppState,
  type TaskItem,
  type AgentInstance,
  type McpServerStatus,
  type TokenUsage,
  type FileReadTracker,
  createDefaultAppState,
} from './app-state.js';
```

- [ ] **Step 4: Typecheck**

Run: `cd /Users/colin/Projects/open-agent && bun run typecheck`
Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add packages/state/
git commit -m "feat(state): define AppState type with 17 core properties"
```

---

### Task 4: Wire store into ConversationLoop

**Files:**
- Modify: `packages/core/src/conversation-loop.ts` (lines 46-63: ConversationLoopOptions, line 261: constructor)
- Modify: `packages/core/package.json` (add @open-agent/state dep)

- [ ] **Step 1: Add @open-agent/state dependency to core**

In `packages/core/package.json`, add `"@open-agent/state": "workspace:*"` to dependencies.

Run: `cd /Users/colin/Projects/open-agent && bun install`

- [ ] **Step 2: Add store accessors to ConversationLoopOptions**

In `packages/core/src/conversation-loop.ts`, add to the `ConversationLoopOptions` interface (after line 63):

```typescript
  getAppState?: () => AppState;
  setAppState?: (updater: (prev: AppState) => AppState) => void;
```

Add import at top:
```typescript
import type { AppState } from '@open-agent/state';
```

These are optional to maintain backward compatibility during migration. Existing callers that don't pass them continue to work.

- [ ] **Step 3: Store accessors in constructor, update totalUsage via store**

In the constructor (line 261), after storing options, add state synchronization:

```typescript
// In the run() method, after each turn's cost calculation, update store if available:
if (this.options.setAppState) {
  this.options.setAppState(prev => ({
    ...prev,
    totalUsage: {
      inputTokens: prev.totalUsage.inputTokens + turnInputTokens,
      outputTokens: prev.totalUsage.outputTokens + turnOutputTokens,
      costUsd: prev.totalUsage.costUsd + turnCost,
    },
  }));
}
```

Find the existing `this._totalInputTokens += ...` lines and add store updates alongside them.

- [ ] **Step 4: Pass store accessors through ToolContext**

In the tool execution section, when building `ToolContext`, pass through the store accessors:

```typescript
const toolCtx: ToolContext = {
  cwd: this.options.cwd,
  abortSignal: this.options.abortSignal,
  sessionId: this.options.sessionId,
  toolUseId: toolUse.id,
  fileReadTracker: this.fileReadTracker,
  getAppState: this.options.getAppState,
  setAppState: this.options.setAppState,
};
```

- [ ] **Step 5: Update ToolContext type in @open-agent/tools**

In `packages/tools/src/types.ts`, add to `ToolContext` interface (line 98-109):

```typescript
  getAppState?: () => any;
  setAppState?: (updater: (prev: any) => any) => void;
```

Using `any` here avoids circular dependency (`tools` shouldn't depend on `state`). Callers in `core` pass the typed version.

- [ ] **Step 6: Run existing tests**

Run: `cd /Users/colin/Projects/open-agent && bun test`
Expected: All existing tests pass (no behavior change — store accessors are optional).

- [ ] **Step 7: Commit**

```bash
git add packages/core/ packages/tools/src/types.ts
git commit -m "feat(core): wire AppState store accessors into ConversationLoop and ToolContext"
```

---

### Task 5: Wire store into SDK query() and CLI main()

**Files:**
- Modify: `packages/sdk/src/query.ts` (~line 1120: ConversationLoop instantiation)
- Modify: `apps/cli/src/index.ts` (~line 200: ConversationLoop instantiation)
- Modify: `packages/agents/src/agent-runner.ts` (line 200-212: ConversationLoop instantiation)

- [ ] **Step 1: Add @open-agent/state dependency to sdk, cli app, and agents**

In each `package.json`, add `"@open-agent/state": "workspace:*"`.

Run: `cd /Users/colin/Projects/open-agent && bun install`

- [ ] **Step 2: Create and pass store in SDK query()**

In `packages/sdk/src/query.ts`, near the top of `query()` implementation (before ConversationLoop creation):

```typescript
import { createStore, createDefaultAppState } from '@open-agent/state';
import type { AppState } from '@open-agent/state';

// Inside query() function, before ConversationLoop instantiation:
const store = createStore<AppState>(createDefaultAppState({
  sessionId,
  cwd,
  model: activeModel,
  permissionMode: resolvedPermissionMode,
  tools: toolRegistry.getAll(),
  thinkingConfig: resolvedThinking,
  verbose: options?.verbose ?? false,
}));
```

Then pass to ConversationLoop:

```typescript
new ConversationLoop({
  // ... existing options ...
  getAppState: () => store.getState(),
  setAppState: (updater) => store.setState(updater),
})
```

- [ ] **Step 3: Create and pass store in CLI main()**

In `apps/cli/src/index.ts`, same pattern — create store before ConversationLoop, pass accessors.

- [ ] **Step 4: Create and pass store in AgentRunner**

In `packages/agents/src/agent-runner.ts`, create a child store for each subagent in `run()` (line 200):

```typescript
import { createStore, createDefaultAppState } from '@open-agent/state';

// Inside run(), before new ConversationLoop:
const agentStore = createStore(createDefaultAppState({
  sessionId: `subagent-${this.agentId}`,
  cwd: effectiveCwd,
  model: this.resolveModel(this.options.model),
  tools: filteredTools,
}));
```

Pass to ConversationLoop as `getAppState` / `setAppState`.

- [ ] **Step 5: Run all tests**

Run: `cd /Users/colin/Projects/open-agent && bun test`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/sdk/ apps/cli/ packages/agents/
git commit -m "feat: wire AppState store into SDK, CLI, and AgentRunner"
```

---

## Phase B: Message Type System

### Task 6: Add SystemMessage subtypes and new message types

**Files:**
- Modify: `packages/core/src/types.ts` (lines 224-251: SDKSystemMessage/SDKStatusMessage, lines 445-466: SDKMessage union)
- Create: `packages/core/src/__tests__/message-types.test.ts`

- [ ] **Step 1: Write type exhaustiveness test**

```typescript
// packages/core/src/__tests__/message-types.test.ts
import { describe, it, expect } from 'bun:test';
import type { SDKMessage } from '../types.js';

// Compile-time exhaustiveness check
function assertNever(x: never): never {
  throw new Error(`Unexpected message type: ${(x as any).type}`);
}

function handleMessage(msg: SDKMessage): string {
  switch (msg.type) {
    case 'assistant': return 'assistant';
    case 'user': return 'user';
    case 'user_replay': return 'user_replay';
    case 'result': return 'result';
    case 'system': {
      // Subtype exhaustiveness
      switch (msg.subtype) {
        case 'init': return 'system:init';
        case 'status': return 'system:status';
        case 'informational': return 'system:informational';
        case 'api_error': return 'system:api_error';
        case 'thinking': return 'system:thinking';
        case 'compact_boundary': return 'system:compact_boundary';
        case 'turn_duration': return 'system:turn_duration';
        default: return assertNever(msg.subtype as never);
      }
    }
    case 'compact_boundary': return 'compact_boundary';
    case 'partial_assistant': return 'partial_assistant';
    case 'tool_result': return 'tool_result';
    case 'task_started': return 'task_started';
    case 'task_progress': return 'task_progress';
    case 'task_notification': return 'task_notification';
    case 'tool_progress': return 'tool_progress';
    case 'hook_started': return 'hook_started';
    case 'hook_progress': return 'hook_progress';
    case 'hook_response': return 'hook_response';
    case 'auth_status': return 'auth_status';
    case 'files_persisted': return 'files_persisted';
    case 'tool_use_summary': return 'tool_use_summary';
    case 'rate_limit': return 'rate_limit';
    case 'prompt_suggestion': return 'prompt_suggestion';
    case 'stream_event': return 'stream_event';
    // New types
    case 'progress': return 'progress';
    case 'tombstone': return 'tombstone';
    default: return assertNever(msg);
  }
}

describe('SDKMessage types', () => {
  it('handles progress message', () => {
    const msg: SDKMessage = {
      type: 'progress',
      toolUseId: 'tu_123',
      toolName: 'bash',
      data: { stdout: 'hello' },
    };
    expect(handleMessage(msg)).toBe('progress');
  });

  it('handles tombstone message', () => {
    const msg: SDKMessage = {
      type: 'tombstone',
      originalMessageId: 'msg_abc',
      reason: 'compacted',
    };
    expect(handleMessage(msg)).toBe('tombstone');
  });

  it('handles system subtype informational', () => {
    const msg: SDKMessage = {
      type: 'system',
      subtype: 'informational',
      message: 'test',
    };
    expect(handleMessage(msg)).toBe('system:informational');
  });

  it('handles system subtype api_error', () => {
    const msg: SDKMessage = {
      type: 'system',
      subtype: 'api_error',
      message: 'rate limited',
      error: { status: 429, message: 'too many requests' },
    };
    expect(handleMessage(msg)).toBe('system:api_error');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/colin/Projects/open-agent && bun test packages/core/src/__tests__/message-types.test.ts`
Expected: FAIL — new types `progress`, `tombstone`, system subtypes not defined.

- [ ] **Step 3: Add new types to types.ts**

In `packages/core/src/types.ts`, add before the `SDKMessage` union (before line 445):

```typescript
// Streaming tool progress (Bash stdout chunks, MCP call progress, etc.)
export interface SDKProgressMessage {
  type: 'progress';
  toolUseId: string;
  toolName: string;
  data: unknown;
}

// Placeholder for deleted/redacted/compacted messages
export interface SDKTombstoneMessage {
  type: 'tombstone';
  originalMessageId: string;
  reason: 'deleted' | 'redacted' | 'compacted';
}
```

Refactor `SDKSystemMessage` and `SDKStatusMessage` into a single unified type with subtype discriminator:

```typescript
// Replace existing SDKSystemMessage (init) and SDKStatusMessage with:
export type SDKSystemMessage =
  | {
      type: 'system';
      subtype: 'init';
      sessionId: string;
      model: string;
      cwd: string;
      tools: string[];
      mcpServers: { name: string; status: string }[];
      message?: string;
    }
  | {
      type: 'system';
      subtype: 'status';
      message: string;
      inputTokens?: number;
      outputTokens?: number;
      cumulativeCostUsd?: number;
    }
  | {
      type: 'system';
      subtype: 'informational';
      message: string;
    }
  | {
      type: 'system';
      subtype: 'api_error';
      message: string;
      error: { status: number; message: string };
    }
  | {
      type: 'system';
      subtype: 'thinking';
      message: string;
    }
  | {
      type: 'system';
      subtype: 'compact_boundary';
      message: string;
      preTokens?: number;
      trigger?: 'manual' | 'auto';
    }
  | {
      type: 'system';
      subtype: 'turn_duration';
      message: string;
      durationMs: number;
    };
```

Add to `SDKMessage` union:

```typescript
export type SDKMessage =
  | SDKAssistantMessage
  | SDKUserMessage
  | SDKUserMessageReplay
  | SDKResultMessage
  | SDKSystemMessage        // now unified with subtypes
  | SDKCompactBoundaryMessage
  | SDKPartialAssistantMessage
  | SDKToolResultMessage
  | SDKTaskStartedMessage
  | SDKTaskProgressMessage
  | SDKTaskNotificationMessage
  | SDKToolProgressMessage
  | SDKHookStartedMessage
  | SDKHookProgressMessage
  | SDKHookResponseMessage
  | SDKAuthStatusMessage
  | SDKFilesPersistedEvent
  | SDKToolUseSummaryMessage
  | SDKRateLimitEvent
  | SDKPromptSuggestionMessage
  | SDKProgressMessage       // NEW
  | SDKTombstoneMessage      // NEW
  | { type: 'stream_event'; event: any };
```

Remove the old separate `SDKStatusMessage` type (it's now `SDKSystemMessage` with `subtype: 'status'`).

- [ ] **Step 4: Fix all existing references to old SDKStatusMessage**

Search for `SDKStatusMessage` in the codebase and update to `SDKSystemMessage` with `subtype: 'status'`. Key files:
- `packages/core/src/conversation-loop.ts` — where status messages are emitted
- `packages/sdk/src/query.ts` — where status messages are processed
- `packages/cli/src/renderer.ts` — where status messages are rendered

For each location, change:
```typescript
// Before:
{ type: 'system', subtype: 'status', message: '...' } as SDKStatusMessage
// After:
{ type: 'system', subtype: 'status', message: '...' } satisfies SDKSystemMessage
```

- [ ] **Step 5: Run tests**

Run: `cd /Users/colin/Projects/open-agent && bun test`
Expected: All tests pass, including the new message-types.test.ts.

- [ ] **Step 6: Commit**

```bash
git add packages/core/
git commit -m "feat(core): enrich SDKMessage with progress, tombstone, and system subtypes"
```

---

### Task 7: Update ConversationLoop to emit new message types

**Files:**
- Modify: `packages/core/src/conversation-loop.ts`

- [ ] **Step 1: Emit SDKProgressMessage during tool execution**

In the tool execution section of `conversation-loop.ts`, when a tool emits progress (e.g., Bash stdout streaming), wrap it as `SDKProgressMessage` and yield:

```typescript
// Inside the tool execution callback, when tool yields incremental output:
yield {
  type: 'progress',
  toolUseId: toolUse.id,
  toolName: toolUse.name,
  data: progressData,
} satisfies SDKProgressMessage;
```

This requires modifying the tool execution to support a progress callback. Add an `onProgress` parameter to `tool.execute()` calls:

```typescript
const result = await tool.execute(toolUse.input, {
  ...toolCtx,
  onProgress: (data: unknown) => {
    progressEvents.push({
      type: 'progress',
      toolUseId: toolUse.id,
      toolName: toolUse.name,
      data,
    });
  },
});
```

Since `run()` is an async generator that can't yield from within a callback, collect progress events into an array and yield them after each tool completes (before yielding the tool_result).

- [ ] **Step 2: Emit SDKTombstoneMessage during compaction**

In the compaction section of `conversation-loop.ts`, when messages are removed during auto-compact, emit tombstones:

```typescript
// After compacting messages, for each removed message that had an id:
for (const removed of removedMessages) {
  if (removed.id) {
    yield {
      type: 'tombstone',
      originalMessageId: removed.id,
      reason: 'compacted',
    } satisfies SDKTombstoneMessage;
  }
}
```

- [ ] **Step 3: Run tests**

Run: `cd /Users/colin/Projects/open-agent && bun test`
Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/conversation-loop.ts
git commit -m "feat(core): emit progress and tombstone messages from ConversationLoop"
```

---

## Phase A: Streaming Tool Executor

### Task 8: Create StreamingToolExecutor with tests

**Files:**
- Create: `packages/core/src/tool-executor.ts`
- Create: `packages/core/src/__tests__/tool-executor.test.ts`
- Modify: `packages/core/src/index.ts` (re-export)

- [ ] **Step 1: Write failing tests**

```typescript
// packages/core/src/__tests__/tool-executor.test.ts
import { describe, it, expect, mock } from 'bun:test';
import { StreamingToolExecutor } from '../tool-executor.js';
import type { ToolDefinition, ToolContext } from '@open-agent/tools';

function makeTool(name: string, opts: {
  concurrent?: boolean;
  result?: any;
  delay?: number;
  onExecute?: () => void;
} = {}): ToolDefinition {
  return {
    name,
    description: `test tool ${name}`,
    inputSchema: { type: 'object', properties: {} },
    isConcurrencySafe: opts.concurrent ?? true,
    async execute(input: any, ctx: ToolContext) {
      opts.onExecute?.();
      if (opts.delay) await new Promise(r => setTimeout(r, opts.delay));
      return opts.result ?? { ok: true };
    },
  };
}

function makeToolContext(): ToolContext {
  return { cwd: '/tmp', sessionId: 'test-session' };
}

describe('StreamingToolExecutor', () => {
  it('executes a single tool and yields result', async () => {
    const tools = new Map([['read', makeTool('read', { result: 'file content' })]]);
    const executor = new StreamingToolExecutor(tools, makeToolContext());

    executor.addTool({ id: 'tu_1', name: 'read', input: {} });

    const results: any[] = [];
    for await (const event of executor.getResults()) {
      results.push(event);
    }

    expect(results).toHaveLength(1);
    expect(results[0].type).toBe('tool_result');
    expect(results[0].toolName).toBe('read');
    expect(results[0].result).toBe('file content');
  });

  it('runs concurrent-safe tools in parallel', async () => {
    const order: string[] = [];
    const tools = new Map([
      ['a', makeTool('a', { concurrent: true, delay: 50, onExecute: () => order.push('a-start') })],
      ['b', makeTool('b', { concurrent: true, delay: 10, onExecute: () => order.push('b-start') })],
    ]);
    const executor = new StreamingToolExecutor(tools, makeToolContext());

    executor.addTool({ id: 'tu_1', name: 'a', input: {} });
    executor.addTool({ id: 'tu_2', name: 'b', input: {} });

    const results: any[] = [];
    for await (const event of executor.getResults()) {
      results.push(event);
    }

    // Both should have started before either finished
    expect(order).toEqual(['a-start', 'b-start']);
    // Results come back in add order, not completion order
    expect(results[0].toolName).toBe('a');
    expect(results[1].toolName).toBe('b');
  });

  it('runs non-concurrent tools sequentially', async () => {
    const order: string[] = [];
    const tools = new Map([
      ['a', makeTool('a', { concurrent: false, delay: 30, onExecute: () => order.push(`a-${Date.now()}`) })],
      ['b', makeTool('b', { concurrent: false, delay: 10, onExecute: () => order.push(`b-${Date.now()}`) })],
    ]);
    const executor = new StreamingToolExecutor(tools, makeToolContext());

    executor.addTool({ id: 'tu_1', name: 'a', input: {} });
    executor.addTool({ id: 'tu_2', name: 'b', input: {} });

    const results: any[] = [];
    for await (const event of executor.getResults()) {
      results.push(event);
    }

    // a must complete before b starts
    expect(results[0].toolName).toBe('a');
    expect(results[1].toolName).toBe('b');
  });

  it('yields results in add order even when fast tool finishes first', async () => {
    const tools = new Map([
      ['slow', makeTool('slow', { concurrent: true, delay: 80, result: 'slow-done' })],
      ['fast', makeTool('fast', { concurrent: true, delay: 10, result: 'fast-done' })],
    ]);
    const executor = new StreamingToolExecutor(tools, makeToolContext());

    executor.addTool({ id: 'tu_1', name: 'slow', input: {} });
    executor.addTool({ id: 'tu_2', name: 'fast', input: {} });

    const results: any[] = [];
    for await (const event of executor.getResults()) {
      results.push(event);
    }

    expect(results[0].result).toBe('slow-done');
    expect(results[1].result).toBe('fast-done');
  });

  it('handles tool execution errors gracefully', async () => {
    const tools = new Map([
      ['fail', {
        name: 'fail',
        description: 'fails',
        inputSchema: { type: 'object', properties: {} },
        isConcurrencySafe: true,
        async execute() { throw new Error('boom'); },
      } as ToolDefinition],
    ]);
    const executor = new StreamingToolExecutor(tools, makeToolContext());

    executor.addTool({ id: 'tu_1', name: 'fail', input: {} });

    const results: any[] = [];
    for await (const event of executor.getResults()) {
      results.push(event);
    }

    expect(results[0].type).toBe('tool_result');
    expect(results[0].isError).toBe(true);
    expect(results[0].error).toContain('boom');
  });

  it('abort() cancels pending tools', async () => {
    const tools = new Map([
      ['slow', makeTool('slow', { concurrent: true, delay: 5000, result: 'done' })],
    ]);
    const executor = new StreamingToolExecutor(tools, makeToolContext());

    executor.addTool({ id: 'tu_1', name: 'slow', input: {} });

    // Abort after a short delay
    setTimeout(() => executor.abort(), 20);

    const results: any[] = [];
    for await (const event of executor.getResults()) {
      results.push(event);
    }

    expect(results[0].type).toBe('tool_result');
    expect(results[0].isError).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/colin/Projects/open-agent && bun test packages/core/src/__tests__/tool-executor.test.ts`
Expected: FAIL — `StreamingToolExecutor` not found.

- [ ] **Step 3: Implement StreamingToolExecutor**

```typescript
// packages/core/src/tool-executor.ts
import type { ToolDefinition, ToolContext } from '@open-agent/tools';
import type { SDKToolResultMessage, SDKProgressMessage } from './types.js';

export interface ToolUseBlock {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

type TrackedToolStatus = 'queued' | 'executing' | 'completed';

interface TrackedTool {
  block: ToolUseBlock;
  status: TrackedToolStatus;
  result?: SDKToolResultMessage;
  resolve?: () => void;
}

export class StreamingToolExecutor {
  private queue: TrackedTool[] = [];
  private tools: Map<string, ToolDefinition>;
  private context: ToolContext;
  private abortController = new AbortController();
  private progressBuffer: SDKProgressMessage[] = [];

  constructor(tools: Map<string, ToolDefinition>, context: ToolContext) {
    this.tools = tools;
    this.context = context;
  }

  addTool(block: ToolUseBlock): void {
    this.queue.push({ block, status: 'queued' });
  }

  async *getResults(): AsyncGenerator<SDKToolResultMessage | SDKProgressMessage> {
    if (this.queue.length === 0) return;

    // Group by concurrency safety
    const concurrentBatch: TrackedTool[] = [];
    const sequentialQueue: TrackedTool[] = [];

    for (const tracked of this.queue) {
      const tool = this.tools.get(tracked.block.name);
      const isSafe = typeof tool?.isConcurrencySafe === 'function'
        ? tool.isConcurrencySafe(tracked.block.input)
        : (tool?.isConcurrencySafe ?? true);

      if (isSafe) {
        concurrentBatch.push(tracked);
      } else {
        sequentialQueue.push(tracked);
      }
    }

    // Execute concurrent batch in parallel
    if (concurrentBatch.length > 0) {
      const promises = concurrentBatch.map(tracked => this.executeTool(tracked));
      await Promise.all(promises);
    }

    // Execute sequential tools one by one
    for (const tracked of sequentialQueue) {
      if (this.abortController.signal.aborted) {
        tracked.status = 'completed';
        tracked.result = {
          type: 'tool_result',
          toolName: tracked.block.name,
          toolUseId: tracked.block.id,
          result: null,
          isError: true,
          error: 'Aborted',
        };
        continue;
      }
      await this.executeTool(tracked);
    }

    // Yield all results in original add order
    for (const tracked of this.queue) {
      // Yield any buffered progress events for this tool first
      for (const progress of this.progressBuffer) {
        if (progress.toolUseId === tracked.block.id) {
          yield progress;
        }
      }
      if (tracked.result) {
        yield tracked.result;
      }
    }
  }

  abort(): void {
    this.abortController.abort();
  }

  private async executeTool(tracked: TrackedTool): Promise<void> {
    tracked.status = 'executing';
    const tool = this.tools.get(tracked.block.name);

    if (!tool) {
      tracked.status = 'completed';
      tracked.result = {
        type: 'tool_result',
        toolName: tracked.block.name,
        toolUseId: tracked.block.id,
        result: null,
        isError: true,
        error: `Unknown tool: ${tracked.block.name}`,
      };
      return;
    }

    try {
      const toolCtx: ToolContext = {
        ...this.context,
        toolUseId: tracked.block.id,
        abortSignal: this.abortController.signal,
      };

      const result = await Promise.race([
        tool.execute(tracked.block.input, toolCtx),
        this.waitForAbort(),
      ]);

      tracked.status = 'completed';
      tracked.result = {
        type: 'tool_result',
        toolName: tracked.block.name,
        toolUseId: tracked.block.id,
        result: this.abortController.signal.aborted ? null : result,
        isError: this.abortController.signal.aborted,
        error: this.abortController.signal.aborted ? 'Aborted' : undefined,
      };
    } catch (err) {
      tracked.status = 'completed';
      tracked.result = {
        type: 'tool_result',
        toolName: tracked.block.name,
        toolUseId: tracked.block.id,
        result: null,
        isError: true,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private waitForAbort(): Promise<never> {
    return new Promise((_, reject) => {
      if (this.abortController.signal.aborted) {
        reject(new Error('Aborted'));
        return;
      }
      this.abortController.signal.addEventListener('abort', () => {
        reject(new Error('Aborted'));
      }, { once: true });
    });
  }
}
```

- [ ] **Step 4: Export from index.ts**

In `packages/core/src/index.ts`, add:
```typescript
export { StreamingToolExecutor, type ToolUseBlock } from './tool-executor.js';
```

- [ ] **Step 5: Run tests**

Run: `cd /Users/colin/Projects/open-agent && bun test packages/core/src/__tests__/tool-executor.test.ts`
Expected: All 6 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/tool-executor.ts packages/core/src/__tests__/tool-executor.test.ts packages/core/src/index.ts
git commit -m "feat(core): implement StreamingToolExecutor with parallel execution and abort"
```

---

### Task 9: Integrate StreamingToolExecutor into ConversationLoop

**Files:**
- Modify: `packages/core/src/conversation-loop.ts` (lines 900-1300: tool execution section)
- Modify: `packages/core/src/__tests__/conversation-loop.test.ts`

- [ ] **Step 1: Write integration test**

```typescript
// Add to packages/core/src/__tests__/conversation-loop.test.ts
import { StreamingToolExecutor } from '../tool-executor.js';

describe('ConversationLoop with StreamingToolExecutor', () => {
  it('uses executor for tool dispatch', async () => {
    // Create a ConversationLoop with a mock provider that returns one tool_use
    // Verify that tool results come back via the executor path
    // (This test validates the wiring, not the executor itself)
    const toolExecuted = { called: false };
    const mockTool: ToolDefinition = {
      name: 'test_tool',
      description: 'test',
      inputSchema: { type: 'object', properties: {} },
      isConcurrencySafe: true,
      async execute() {
        toolExecuted.called = true;
        return 'executed';
      },
    };

    // ... setup mock provider that returns a tool_use block ...
    // ... create ConversationLoop with the tool ...
    // ... run and collect messages ...
    // ... assert toolExecuted.called === true ...
    // ... assert a tool_result message was emitted ...
  });
});
```

(The exact mock provider setup depends on the existing test patterns in conversation-loop.test.ts. Match the existing `createMockProvider` pattern.)

- [ ] **Step 2: Replace inline tool execution with StreamingToolExecutor**

In `conversation-loop.ts`, locate the tool execution section (approximately lines 900-1300). Replace the 3-phase inline logic with:

```typescript
import { StreamingToolExecutor, type ToolUseBlock } from './tool-executor.js';

// ... inside the main loop, after collecting toolUses from assistant response:

// Phase 1: Permission checks (keep serial — unchanged)
const approvedBlocks: ToolUseBlock[] = [];
for (const toolUse of toolUses) {
  // ... existing permission check logic ...
  // If approved:
  approvedBlocks.push({
    id: toolUse.id,
    name: toolUse.name,
    input: toolUse.input as Record<string, unknown>,
  });
}

// Phase 2+3: Execute via StreamingToolExecutor (replaces ~200 lines)
const executor = new StreamingToolExecutor(this.options.tools, {
  cwd: this.options.cwd,
  abortSignal: this.options.abortSignal,
  sessionId: this.options.sessionId,
  fileReadTracker: this.fileReadTracker,
  getAppState: this.options.getAppState,
  setAppState: this.options.setAppState,
});

for (const block of approvedBlocks) {
  executor.addTool(block);
}

const toolResults: any[] = [];
for await (const event of executor.getResults()) {
  if (event.type === 'progress') {
    yield event;
  } else {
    yield event;
    toolResults.push(event);
  }
}

// Add tool results to messages for next LLM turn
// ... existing message assembly logic ...
```

Remove the old Phase 2 (`Promise.all` inline execution) and Phase 3 (manual ordering) code.

- [ ] **Step 3: Preserve hook execution**

The existing code calls PreToolUse/PostToolUse hooks around tool execution. Move these into `StreamingToolExecutor.executeTool()` or keep them in ConversationLoop by wrapping the executor. Recommended: keep hooks in ConversationLoop by iterating the executor results and calling hooks inline:

```typescript
for await (const event of executor.getResults()) {
  if (event.type === 'tool_result' && !event.isError && this.options.hookExecutor) {
    await this.options.hookExecutor.execute('PostToolUse', {
      toolName: event.toolName,
      toolUseId: event.toolUseId,
      result: event.result,
    });
  }
  yield event;
}
```

- [ ] **Step 4: Run all tests**

Run: `cd /Users/colin/Projects/open-agent && bun test`
Expected: All tests pass. No behavior change to callers — same SDKMessage events emitted.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/conversation-loop.ts packages/core/src/__tests__/
git commit -m "refactor(core): replace inline tool execution with StreamingToolExecutor"
```

---

## Phase D: React + Ink Terminal UI

### Task 10: Create `@open-agent/ink` package scaffold

**Files:**
- Create: `packages/ink/package.json`
- Create: `packages/ink/tsconfig.json`
- Create: `packages/ink/src/index.tsx`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "@open-agent/ink",
  "version": "0.1.0",
  "type": "module",
  "main": "src/index.tsx",
  "types": "src/index.tsx",
  "scripts": {
    "test": "bun test",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@open-agent/state": "workspace:*",
    "@open-agent/core": "workspace:*",
    "ink": "^5.1.0",
    "ink-spinner": "^5.0.0",
    "react": "^18.3.1"
  },
  "devDependencies": {
    "@types/react": "^18.3.0",
    "ink-testing-library": "^4.0.0",
    "typescript": "^5.7.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "jsx": "react-jsx"
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: Create placeholder index.tsx**

```tsx
// @open-agent/ink — React + Ink terminal UI
export { App } from './App.js';
export { renderApp } from './render.js';
```

- [ ] **Step 4: Install dependencies**

Run: `cd /Users/colin/Projects/open-agent && bun install`
Expected: ink, react, ink-spinner installed.

- [ ] **Step 5: Commit**

```bash
git add packages/ink/
git commit -m "feat(ink): scaffold @open-agent/ink package with React + Ink deps"
```

---

### Task 11: Implement useStore hook and Spinner component

**Files:**
- Create: `packages/ink/src/hooks/useStore.ts`
- Create: `packages/ink/src/components/Spinner.tsx`
- Create: `packages/ink/src/__tests__/useStore.test.tsx`

- [ ] **Step 1: Write failing test for useStore**

```tsx
// packages/ink/src/__tests__/useStore.test.tsx
import { describe, it, expect } from 'bun:test';
import React from 'react';
import { render } from 'ink-testing-library';
import { Text } from 'ink';
import { createStore } from '@open-agent/state';
import { StoreProvider, useStore } from '../hooks/useStore.js';

function Counter() {
  const count = useStore(s => s.count);
  return <Text>Count: {count}</Text>;
}

describe('useStore', () => {
  it('reads initial state', () => {
    const store = createStore({ count: 0 });
    const { lastFrame } = render(
      <StoreProvider store={store}>
        <Counter />
      </StoreProvider>
    );
    expect(lastFrame()).toContain('Count: 0');
  });

  it('re-renders on state change', async () => {
    const store = createStore({ count: 0 });
    const { lastFrame } = render(
      <StoreProvider store={store}>
        <Counter />
      </StoreProvider>
    );

    store.setState(prev => ({ ...prev, count: 42 }));
    // Ink re-renders synchronously in test mode
    expect(lastFrame()).toContain('Count: 42');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/colin/Projects/open-agent && bun test packages/ink/`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement useStore with React Context**

```tsx
// packages/ink/src/hooks/useStore.ts
import { createContext, useContext, useEffect, useState } from 'react';
import type { Store } from '@open-agent/state';

const StoreContext = createContext<Store<any> | null>(null);

export function StoreProvider({ store, children }: { store: Store<any>; children: React.ReactNode }) {
  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}

export function useStore<T, R>(selector: (state: T) => R): R {
  const store = useContext(StoreContext);
  if (!store) throw new Error('useStore must be used within StoreProvider');

  const [value, setValue] = useState(() => selector(store.getState()));

  useEffect(() => {
    // Initial sync in case state changed between render and effect
    setValue(selector(store.getState()));

    return store.subscribe(() => {
      const next = selector(store.getState());
      setValue(next);
    });
  }, [store, selector]);

  return value;
}
```

- [ ] **Step 4: Implement Spinner component**

```tsx
// packages/ink/src/components/Spinner.tsx
import React from 'react';
import { Text } from 'ink';
import InkSpinner from 'ink-spinner';

interface SpinnerProps {
  label?: string;
}

export function Spinner({ label = 'Thinking' }: SpinnerProps) {
  return (
    <Text>
      <Text color="cyan"><InkSpinner type="dots" /></Text>
      {' '}{label}
    </Text>
  );
}
```

- [ ] **Step 5: Run tests**

Run: `cd /Users/colin/Projects/open-agent && bun test packages/ink/`
Expected: 2 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/ink/src/
git commit -m "feat(ink): implement useStore hook and Spinner component"
```

---

### Task 12: Implement CostBar and MessageList components

**Files:**
- Create: `packages/ink/src/components/CostBar.tsx`
- Create: `packages/ink/src/components/MessageList.tsx`
- Create: `packages/ink/src/__tests__/components.test.tsx`

- [ ] **Step 1: Write tests**

```tsx
// packages/ink/src/__tests__/components.test.tsx
import { describe, it, expect } from 'bun:test';
import React from 'react';
import { render } from 'ink-testing-library';
import { CostBar } from '../components/CostBar.js';
import { MessageList } from '../components/MessageList.js';
import type { SDKMessage } from '@open-agent/core';

describe('CostBar', () => {
  it('renders token usage and cost', () => {
    const { lastFrame } = render(
      <CostBar inputTokens={1000} outputTokens={500} costUsd={0.0234} />
    );
    expect(lastFrame()).toContain('1000');
    expect(lastFrame()).toContain('500');
    expect(lastFrame()).toContain('0.0234');
  });
});

describe('MessageList', () => {
  it('renders assistant text message', () => {
    const messages: SDKMessage[] = [
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Hello world' }] },
      } as any,
    ];
    const { lastFrame } = render(<MessageList messages={messages} />);
    expect(lastFrame()).toContain('Hello world');
  });

  it('renders tool result', () => {
    const messages: SDKMessage[] = [
      {
        type: 'tool_result',
        toolName: 'bash',
        toolUseId: 'tu_1',
        result: 'command output',
        isError: false,
      } as any,
    ];
    const { lastFrame } = render(<MessageList messages={messages} />);
    expect(lastFrame()).toContain('bash');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/colin/Projects/open-agent && bun test packages/ink/src/__tests__/components.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement CostBar**

```tsx
// packages/ink/src/components/CostBar.tsx
import React from 'react';
import { Text, Box } from 'ink';

interface CostBarProps {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export function CostBar({ inputTokens, outputTokens, costUsd }: CostBarProps) {
  return (
    <Box>
      <Text dimColor>
        Tokens: <Text color="green">{inputTokens}</Text>
        {' '}in / <Text color="yellow">{outputTokens}</Text>
        {' '}out · ${costUsd.toFixed(4)}
      </Text>
    </Box>
  );
}
```

- [ ] **Step 4: Implement MessageList**

```tsx
// packages/ink/src/components/MessageList.tsx
import React from 'react';
import { Text, Box } from 'ink';
import type { SDKMessage } from '@open-agent/core';

interface MessageListProps {
  messages: SDKMessage[];
}

export function MessageList({ messages }: MessageListProps) {
  return (
    <Box flexDirection="column">
      {messages.map((msg, i) => (
        <MessageItem key={i} message={msg} />
      ))}
    </Box>
  );
}

function MessageItem({ message }: { message: SDKMessage }) {
  switch (message.type) {
    case 'assistant': {
      const text = (message as any).message?.content
        ?.filter((b: any) => b.type === 'text')
        .map((b: any) => b.text)
        .join('') ?? '';
      return (
        <Box>
          <Text color="blue" bold>Assistant: </Text>
          <Text>{text}</Text>
        </Box>
      );
    }
    case 'tool_result': {
      const tr = message as any;
      const icon = tr.isError ? '✗' : '✓';
      const color = tr.isError ? 'red' : 'green';
      return (
        <Box>
          <Text color={color}>{icon} </Text>
          <Text bold>{tr.toolName}</Text>
          <Text dimColor> {typeof tr.result === 'string' ? tr.result.slice(0, 200) : JSON.stringify(tr.result).slice(0, 200)}</Text>
        </Box>
      );
    }
    case 'user':
      return (
        <Box>
          <Text color="green" bold>You: </Text>
          <Text>{String((message as any).message ?? '')}</Text>
        </Box>
      );
    default:
      return null;
  }
}
```

- [ ] **Step 5: Run tests**

Run: `cd /Users/colin/Projects/open-agent && bun test packages/ink/src/__tests__/components.test.tsx`
Expected: 3 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/ink/src/components/ packages/ink/src/__tests__/
git commit -m "feat(ink): implement CostBar and MessageList components"
```

---

### Task 13: Implement ToolProgress and PermissionPrompt components

**Files:**
- Create: `packages/ink/src/components/ToolProgress.tsx`
- Create: `packages/ink/src/components/PermissionPrompt.tsx`

- [ ] **Step 1: Implement ToolProgress**

```tsx
// packages/ink/src/components/ToolProgress.tsx
import React from 'react';
import { Text, Box } from 'ink';
import { Spinner } from './Spinner.js';

const TOOL_ICONS: Record<string, string> = {
  read: '📄', write: '✏️', edit: '✏️', bash: '⚡',
  glob: '🔍', grep: '🔍', web_search: '🌐', web_fetch: '🌐',
};

interface ToolProgressProps {
  toolName: string;
  toolInput?: Record<string, unknown>;
  isExecuting: boolean;
}

export function ToolProgress({ toolName, toolInput, isExecuting }: ToolProgressProps) {
  const icon = TOOL_ICONS[toolName] ?? '🔧';
  const label = getSpinnerLabel(toolName, toolInput);

  if (isExecuting) {
    return (
      <Box>
        <Text>{icon} </Text>
        <Spinner label={label} />
      </Box>
    );
  }

  return (
    <Box>
      <Text>{icon} </Text>
      <Text bold>{toolName}</Text>
      {toolInput && <Text dimColor> {summarizeInput(toolName, toolInput)}</Text>}
    </Box>
  );
}

function getSpinnerLabel(toolName: string, input?: Record<string, unknown>): string {
  if (!input) return toolName;
  switch (toolName) {
    case 'read': return `Reading ${input.file_path ?? ''}`;
    case 'write': return `Writing ${input.file_path ?? ''}`;
    case 'edit': return `Editing ${input.file_path ?? ''}`;
    case 'bash': return `Running ${String(input.command ?? '').slice(0, 60)}`;
    case 'glob': return `Searching ${input.pattern ?? ''}`;
    case 'grep': return `Grepping ${input.pattern ?? ''}`;
    default: return toolName;
  }
}

function summarizeInput(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case 'read': return String(input.file_path ?? '');
    case 'bash': return String(input.command ?? '').slice(0, 80);
    case 'glob': return String(input.pattern ?? '');
    case 'grep': return String(input.pattern ?? '');
    default: return '';
  }
}
```

- [ ] **Step 2: Implement PermissionPrompt**

```tsx
// packages/ink/src/components/PermissionPrompt.tsx
import React, { useState } from 'react';
import { Text, Box, useInput } from 'ink';

interface PermissionPromptProps {
  toolName: string;
  toolInput: Record<string, unknown>;
  onDecision: (decision: 'allow' | 'deny' | 'always') => void;
}

export function PermissionPrompt({ toolName, toolInput, onDecision }: PermissionPromptProps) {
  const [selected, setSelected] = useState(0);
  const options = [
    { key: 'y', label: 'Allow once', value: 'allow' as const },
    { key: 'n', label: 'Deny', value: 'deny' as const },
    { key: 'a', label: 'Always allow', value: 'always' as const },
  ];

  useInput((input, key) => {
    if (key.upArrow) setSelected(s => Math.max(0, s - 1));
    if (key.downArrow) setSelected(s => Math.min(options.length - 1, s + 1));
    if (key.return) onDecision(options[selected].value);
    if (input === 'y') onDecision('allow');
    if (input === 'n') onDecision('deny');
    if (input === 'a') onDecision('always');
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text bold color="yellow">Permission Required</Text>
      <Text>Tool: <Text bold>{toolName}</Text></Text>
      <Text dimColor>{JSON.stringify(toolInput).slice(0, 200)}</Text>
      <Box flexDirection="column" marginTop={1}>
        {options.map((opt, i) => (
          <Text key={opt.key}>
            {i === selected ? <Text color="cyan">{'> '}</Text> : '  '}
            <Text bold={i === selected}>[{opt.key}] {opt.label}</Text>
          </Text>
        ))}
      </Box>
    </Box>
  );
}
```

- [ ] **Step 3: Run typecheck**

Run: `cd /Users/colin/Projects/open-agent && bun run typecheck`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add packages/ink/src/components/
git commit -m "feat(ink): implement ToolProgress and PermissionPrompt components"
```

---

### Task 14: Implement App root, REPL component, and renderApp entry

**Files:**
- Create: `packages/ink/src/App.tsx`
- Create: `packages/ink/src/components/REPL.tsx`
- Create: `packages/ink/src/components/PromptInput.tsx`
- Create: `packages/ink/src/hooks/useStreamEvents.ts`
- Create: `packages/ink/src/render.tsx`
- Modify: `packages/ink/src/index.tsx`

- [ ] **Step 1: Implement useStreamEvents hook**

```tsx
// packages/ink/src/hooks/useStreamEvents.ts
import { useState, useCallback } from 'react';
import type { SDKMessage } from '@open-agent/core';

export function useStreamEvents() {
  const [messages, setMessages] = useState<SDKMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);

  const consumeStream = useCallback(async (stream: AsyncGenerator<SDKMessage>) => {
    setIsStreaming(true);
    try {
      for await (const msg of stream) {
        setMessages(prev => [...prev, msg]);
      }
    } finally {
      setIsStreaming(false);
    }
  }, []);

  const clearMessages = useCallback(() => setMessages([]), []);

  return { messages, isStreaming, consumeStream, clearMessages };
}
```

- [ ] **Step 2: Implement PromptInput**

```tsx
// packages/ink/src/components/PromptInput.tsx
import React, { useState } from 'react';
import { Text, Box, useInput } from 'ink';

interface PromptInputProps {
  onSubmit: (text: string) => void;
  isDisabled?: boolean;
}

export function PromptInput({ onSubmit, isDisabled }: PromptInputProps) {
  const [input, setInput] = useState('');

  useInput((char, key) => {
    if (isDisabled) return;
    if (key.return) {
      if (input.trim()) {
        onSubmit(input.trim());
        setInput('');
      }
      return;
    }
    if (key.backspace || key.delete) {
      setInput(prev => prev.slice(0, -1));
      return;
    }
    if (char && !key.ctrl && !key.meta) {
      setInput(prev => prev + char);
    }
  });

  return (
    <Box>
      <Text color="green" bold>{'> '}</Text>
      <Text>{input}</Text>
      {!isDisabled && <Text color="gray">{'█'}</Text>}
    </Box>
  );
}
```

- [ ] **Step 3: Implement REPL component**

```tsx
// packages/ink/src/components/REPL.tsx
import React, { useCallback } from 'react';
import { Box } from 'ink';
import { MessageList } from './MessageList.js';
import { CostBar } from './CostBar.js';
import { Spinner } from './Spinner.js';
import { PromptInput } from './PromptInput.js';
import { useStore } from '../hooks/useStore.js';
import { useStreamEvents } from '../hooks/useStreamEvents.js';
import type { ConversationLoop } from '@open-agent/core';
import type { AppState } from '@open-agent/state';

interface REPLProps {
  loop: ConversationLoop;
}

export function REPL({ loop }: REPLProps) {
  const usage = useStore<AppState, AppState['totalUsage']>(s => s.totalUsage);
  const { messages, isStreaming, consumeStream } = useStreamEvents();

  const handleSubmit = useCallback(async (text: string) => {
    const stream = loop.run(text);
    await consumeStream(stream);
  }, [loop, consumeStream]);

  return (
    <Box flexDirection="column">
      <MessageList messages={messages} />
      {isStreaming && <Spinner label="Thinking" />}
      <CostBar
        inputTokens={usage.inputTokens}
        outputTokens={usage.outputTokens}
        costUsd={usage.costUsd}
      />
      <PromptInput onSubmit={handleSubmit} isDisabled={isStreaming} />
    </Box>
  );
}
```

- [ ] **Step 4: Implement App root**

```tsx
// packages/ink/src/App.tsx
import React from 'react';
import { Box, Text } from 'ink';
import { StoreProvider } from './hooks/useStore.js';
import { REPL } from './components/REPL.js';
import type { Store, AppState } from '@open-agent/state';
import type { ConversationLoop } from '@open-agent/core';

interface AppProps {
  store: Store<AppState>;
  loop: ConversationLoop;
  model: string;
  cwd: string;
}

export function App({ store, loop, model, cwd }: AppProps) {
  return (
    <StoreProvider store={store}>
      <Box flexDirection="column">
        <Box borderStyle="single" borderColor="blue" paddingX={1}>
          <Text bold>Open Agent</Text>
          <Text dimColor> · {model} · {cwd}</Text>
        </Box>
        <REPL loop={loop} />
      </Box>
    </StoreProvider>
  );
}
```

- [ ] **Step 5: Implement renderApp entry**

```tsx
// packages/ink/src/render.tsx
import React from 'react';
import { render } from 'ink';
import { App } from './App.js';
import type { Store, AppState } from '@open-agent/state';
import type { ConversationLoop } from '@open-agent/core';

export interface RenderOptions {
  store: Store<AppState>;
  loop: ConversationLoop;
  model: string;
  cwd: string;
}

export function renderApp(options: RenderOptions) {
  const { waitUntilExit } = render(
    <App
      store={options.store}
      loop={options.loop}
      model={options.model}
      cwd={options.cwd}
    />
  );
  return waitUntilExit;
}
```

- [ ] **Step 6: Update index.tsx exports**

```tsx
// packages/ink/src/index.tsx
export { App } from './App.js';
export { renderApp, type RenderOptions } from './render.js';
export { StoreProvider, useStore } from './hooks/useStore.js';
export { useStreamEvents } from './hooks/useStreamEvents.js';
export { MessageList } from './components/MessageList.js';
export { CostBar } from './components/CostBar.js';
export { Spinner } from './components/Spinner.js';
export { ToolProgress } from './components/ToolProgress.js';
export { PermissionPrompt } from './components/PermissionPrompt.js';
export { PromptInput } from './components/PromptInput.js';
export { REPL } from './components/REPL.js';
```

- [ ] **Step 7: Run typecheck**

Run: `cd /Users/colin/Projects/open-agent && bun run typecheck`
Expected: No errors.

- [ ] **Step 8: Commit**

```bash
git add packages/ink/
git commit -m "feat(ink): implement App, REPL, PromptInput, and renderApp entry"
```

---

### Task 15: Wire Ink into CLI, replace TerminalRenderer

**Files:**
- Modify: `apps/cli/src/index.ts` (replace TerminalRenderer with renderApp)
- Modify: `apps/cli/package.json` (add @open-agent/ink dep)

- [ ] **Step 1: Add @open-agent/ink dependency**

In `apps/cli/package.json`, add `"@open-agent/ink": "workspace:*"`.

Run: `cd /Users/colin/Projects/open-agent && bun install`

- [ ] **Step 2: Replace TerminalRenderer with renderApp in CLI**

In `apps/cli/src/index.ts`, replace the existing REPL setup:

```typescript
// Before:
import { TerminalRenderer, REPL } from '@open-agent/cli';
// ...
const renderer = new TerminalRenderer();
const repl = new REPL(loop, renderer);
// ...

// After:
import { renderApp } from '@open-agent/ink';
// ...
const waitUntilExit = renderApp({
  store,
  loop,
  model: activeModel,
  cwd,
});
await waitUntilExit();
```

Remove all `renderer.render*()` calls that were previously inline in the REPL loop — the Ink components now handle rendering via store subscriptions and stream events.

- [ ] **Step 3: Keep TerminalRenderer for SDK JSON stream mode**

The `--json` / stream output mode should continue using `TerminalRenderer` or `emitStreamJson()` for headless use. Gate the Ink rendering:

```typescript
if (args.json || args.streamJson) {
  // Headless: use existing stream-json output
  // ...existing code...
} else {
  // Interactive: use Ink
  const waitUntilExit = renderApp({ store, loop, model: activeModel, cwd });
  await waitUntilExit();
}
```

- [ ] **Step 4: Run the CLI manually to verify**

Run: `cd /Users/colin/Projects/open-agent && bun run dev -- --help`
Expected: CLI starts without errors. The Ink-rendered welcome banner appears.

- [ ] **Step 5: Run all tests**

Run: `cd /Users/colin/Projects/open-agent && bun test`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add apps/cli/ packages/ink/
git commit -m "feat(cli): replace TerminalRenderer with React+Ink renderApp"
```

---

## Final Verification

### Task 16: Full integration test and typecheck

- [ ] **Step 1: Run full typecheck**

Run: `cd /Users/colin/Projects/open-agent && bun run typecheck`
Expected: No errors across all packages.

- [ ] **Step 2: Run full test suite**

Run: `cd /Users/colin/Projects/open-agent && bun test`
Expected: All tests pass (existing + new).

- [ ] **Step 3: Run CLI with a real provider**

Run: `cd /Users/colin/Projects/open-agent && bun run dev -- --provider openai --api-key "1fbc40eb2c834d63b695cd622bf810ca.w3XEod8FILl2AXPl" --base-url "https://open.bigmodel.cn/api/coding/paas/v4" --model "glm-4.7"`

Expected: Interactive session starts with Ink-rendered UI. Type a message, see streaming response with tool execution progress via React components.

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "feat: complete core alignment — state store, message types, tool executor, Ink UI"
```
