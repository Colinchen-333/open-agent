# Core Capability Alignment with Claude Code

Date: 2026-04-01
Status: Approved
Order: C (State) → B (Messages) → A (Tool Executor) → D (Ink UI)

---

## Context

Open-agent is a reverse-engineered Claude Code CLI built with Bun + TypeScript monorepo. After comparing both codebases, four core infrastructure gaps were identified. This spec covers aligning them in dependency order.

---

## Phase C: Reactive State Management

### Problem

State is scattered across class instances (ConversationLoop, AgentExecutor, TerminalRenderer). No centralized reactive store means components can't subscribe to state changes, and state is threaded through constructor params manually.

### Design

**New package: `packages/state/`**

Core abstraction — a minimal Zustand-like store:

```typescript
type Store<T> = {
  getState(): T
  setState(updater: (prev: T) => T): void
  subscribe(listener: () => void): () => void
}

function createStore<T>(initialState: T, onChange?: (prev: T, next: T) => void): Store<T>
```

- `Object.is()` identity check to skip no-op updates
- Synchronous `subscribe()` with cleanup return
- Optional `onChange` callback for side effects (logging, persistence)

**AppState type (~17 properties):**

```typescript
type AppState = {
  // Session
  sessionId: string
  cwd: string
  model: string
  permissionMode: PermissionMode

  // Conversation
  messages: Message[]
  totalUsage: { inputTokens: number; outputTokens: number; costUsd: number }

  // Tools
  tools: Map<string, ToolDefinition>
  fileReadTracker: FileReadTracker

  // MCP
  mcpServers: McpServerStatus[]

  // Agents & Tasks
  tasks: Record<string, TaskItem>
  teammates: Map<string, AgentInstance>
  agentNameRegistry: Map<string, string>

  // Settings
  settings: SettingsJson
  thinkingConfig: ThinkingConfig
  verbose: boolean
}
```

**Integration points:**

- `ConversationLoop` constructor takes `getAppState()` / `setAppState()` instead of individual state params
- `ToolContext` carries store accessors (aligns with Claude Code's `ToolUseContext`)
- Renderer subscribes to store for reactive updates
- SDK `query()` creates store instance and injects it

---

## Phase B: Message Type System

### Problem

Current `SDKMessage` has 14 types but lacks granularity for progress streaming, system event subtypes, message tombstones, and tool use summaries.

### Design

Extend `SDKMessage` union in `packages/core/src/types.ts`. No backward compatibility — clean replacement.

**SystemMessage gains `subtype` discriminator:**

```typescript
type SDKSystemMessage = {
  type: 'system'
  subtype:
    | 'informational'
    | 'api_error'
    | 'thinking'
    | 'compact_boundary'
    | 'turn_duration'
  message: string
  // subtype-specific fields via union refinement
}
```

**New message types:**

```typescript
// Streaming tool progress (Bash stdout, MCP calls, etc.)
type SDKProgressMessage = {
  type: 'progress'
  toolUseId: string
  toolName: string
  data: unknown
}

// Placeholder for deleted/redacted/compacted messages
type SDKTombstoneMessage = {
  type: 'tombstone'
  originalMessageId: string
  reason: 'deleted' | 'redacted' | 'compacted'
}

// Compressed tool use history marker
type SDKToolUseSummaryMessage = {
  type: 'tool_use_summary'
  toolNames: string[]
  count: number
  summary: string
}
```

All consumers (ConversationLoop, Renderer, SDK query) updated to handle new types.

---

## Phase A: Streaming Tool Executor

### Problem

Tool execution logic is embedded in the 1700-line `ConversationLoop`. It already supports parallel execution via `Promise.all` on `isConcurrencySafe`, but lacks:
- Queue-based streaming (tools execute as they stream in from API, not after full response)
- Independent progress streaming (progress events yield immediately)
- Sibling abort (one Bash error cancels peer Bash tools)

### Design

**New file: `packages/core/src/tool-executor.ts`**

```typescript
class StreamingToolExecutor {
  private queue: TrackedTool[]
  private siblingAbortController: AbortController

  constructor(
    tools: Map<string, ToolDefinition>,
    canUseTool: CanUseToolFn,
    context: ToolContext
  )

  // Add tool as it streams in from API
  addTool(block: ToolUseBlock): void

  // Async generator: yields progress immediately, results in add-order
  async *getResults(): AsyncGenerator<SDKProgressMessage | SDKToolResultMessage>

  // Cancel all executing tools
  abort(): void
}

type TrackedTool = {
  block: ToolUseBlock
  status: 'queued' | 'executing' | 'completed' | 'yielded'
  result?: ToolResult
  progressEvents: SDKProgressMessage[]
}
```

**Concurrency rules:**
- `isConcurrencySafe` is evaluated per-invocation with parsed input (same tool may be safe or unsafe depending on args, matching Claude Code's pattern)
- `isConcurrencySafe === true` → parallel with other safe tools
- `isConcurrencySafe === false` → exclusive execution (waits for all prior to complete)
- Progress events yield immediately, never buffered
- Results yield in **add order** (not completion order) for determinism
- Bash error → `siblingAbortController.abort()` cancels peer Bash tools in same batch

**ConversationLoop integration:**

```typescript
const executor = new StreamingToolExecutor(tools, canUseTool, toolContext)
for (const block of toolUseBlocks) {
  executor.addTool(block)
}
for await (const event of executor.getResults()) {
  yield event
}
```

Tool execution code in ConversationLoop shrinks from ~200 lines to ~10 lines.

---

## Phase D: React + Ink Terminal UI

### Problem

Current `TerminalRenderer` is imperative (direct ANSI writes). Complex interactive UI (permission prompts, multi-agent panels, progress trees) is hard to build and maintain.

### Design

**New package: `packages/ink/`**

```
packages/ink/src/
├── index.tsx                # renderApp() entry
├── App.tsx                  # Root component, store subscription
├── components/
│   ├── REPL.tsx             # Main interactive loop
│   ├── MessageList.tsx      # Conversation message rendering
│   ├── ToolProgress.tsx     # Tool execution progress (spinner + streaming output)
│   ├── PermissionPrompt.tsx # Permission confirmation dialog
│   ├── PromptInput.tsx      # User input box
│   ├── CostBar.tsx          # Token/cost status bar
│   └── Spinner.tsx          # Animated spinner
└── hooks/
    ├── useStore.ts          # Connect to Phase C Store
    └── useStreamEvents.ts   # Consume ConversationLoop async generator
```

**Store-driven rendering:**

```typescript
function useStore<T>(selector: (state: AppState) => T): T {
  const [value, setValue] = useState(() => selector(store.getState()))
  useEffect(() => store.subscribe(() => {
    const next = selector(store.getState())
    setValue(next)
  }), [])
  return value
}
```

**Migration:**
- `packages/cli/renderer.ts` replaced by `packages/ink/` `renderApp()` call
- `apps/cli/src/index.ts` REPL loop moves into `REPL.tsx` component
- SDK headless mode does not load Ink — zero React dependency for programmatic usage

**Dependencies:**
- `ink` (React terminal renderer)
- `react` (peer dep of ink)
- Community components (`ink-spinner`, `ink-text-input`) as needed

---

## Cross-Cutting Concerns

### Package Dependencies (after changes)

```
@open-agent/state (NEW)
  └── no deps (standalone store)

@open-agent/core
  ├── @open-agent/state
  ├── @open-agent/providers
  └── @open-agent/tools

@open-agent/ink (NEW)
  ├── @open-agent/state
  ├── @open-agent/core (types)
  ├── ink, react
  └── @open-agent/tools (type-only for tool names/icons)

@open-agent/cli
  ├── @open-agent/ink (replaces renderer.ts)
  └── (everything else stays)

@open-agent/sdk
  ├── @open-agent/state
  └── (no ink dependency — headless)
```

### Testing Strategy

- **Phase C**: Unit test store (subscribe, setState, identity skip)
- **Phase B**: Type-level tests (exhaustive switch on message types)
- **Phase A**: Unit test executor concurrency (parallel safe, sequential unsafe, abort propagation, order preservation)
- **Phase D**: Snapshot tests for key components via `ink-testing-library`
