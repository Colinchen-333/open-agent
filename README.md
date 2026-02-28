<p align="center">
  <img src="https://img.shields.io/badge/runtime-Bun-f472b6?style=for-the-badge&logo=bun&logoColor=white" alt="Bun" />
  <img src="https://img.shields.io/badge/lang-TypeScript-3178c6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/license-MIT-22c55e?style=for-the-badge" alt="MIT License" />
  <img src="https://img.shields.io/badge/tests-286%20passing-22c55e?style=for-the-badge" alt="Tests" />
</p>

<h1 align="center">Open Agent</h1>

<p align="center">
  <strong>An open-source AI coding agent framework with CLI and SDK</strong><br/>
  Multi-provider LLM support · 27 built-in tools · Multi-agent teams · MCP integration
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> ·
  <a href="#sdk-usage">SDK Usage</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="#tools">Tools</a> ·
  <a href="#configuration">Configuration</a>
</p>

---

## Overview

Open Agent is a fully-featured AI coding agent framework built with Bun and TypeScript. It provides both an interactive CLI and a programmatic SDK for embedding AI-powered coding capabilities into any application.

**Key capabilities:**

- **Multi-provider** — Anthropic (with extended thinking & prompt caching), OpenAI-compatible APIs, Ollama
- **27 built-in tools** — File I/O, shell execution, code search, web fetch, notebook editing, and more
- **Multi-agent teams** — Spawn parallel agents with task management and inter-agent messaging
- **MCP integration** — First-class Model Context Protocol support (stdio / HTTP / SSE)
- **Permission system** — 5 permission modes from interactive approval to full bypass
- **Session persistence** — Resume conversations across restarts with JSONL transcripts
- **Hook system** — Lifecycle hooks for `PreToolUse`, `PostToolUse`, `SessionStart`, and 15+ events
- **Extended thinking** — Adaptive and explicit thinking modes with configurable token budgets

## Quick Start

### Prerequisites

- [Bun](https://bun.sh/) v1.1+
- An API key from Anthropic, OpenAI, or any compatible provider

### Install & Run

```bash
# Clone the repository
git clone https://github.com/Colinchen-333/open-agent.git
cd open-agent

# Install dependencies
bun install

# Set your API key
export ANTHROPIC_API_KEY="sk-ant-..."
# Or for OpenAI-compatible providers:
export OPENAI_API_KEY="your-key"
export OPENAI_BASE_URL="https://api.example.com/v1"

# Start the interactive CLI
bun run start

# Or build a standalone binary
bun run build
./apps/cli/open-agent
```

### CLI Usage

```bash
# Interactive mode
open-agent

# Single prompt
open-agent "explain this codebase"
open-agent -p "fix the bug in auth.ts"

# With specific model
open-agent -m claude-opus-4-6 "review this PR"

# Resume previous session
open-agent --continue
open-agent --resume <session-id>
```

### Slash Commands

| Command | Description |
|---------|-------------|
| `/help` | Show available commands |
| `/model [name]` | Show or change the current model |
| `/compact` | Compact conversation history to save context |
| `/cost` | Display session token usage and cost |
| `/tools` | List all registered tools |
| `/status` | Show session status |
| `/memory` | Memory status |
| `/clear` | Clear the screen |
| `/exit` | Exit the session |

## SDK Usage

### Streaming Query (V1 API)

```typescript
import { query } from '@open-agent/sdk';

const stream = query('Find and fix all TypeScript errors in src/', {
  model: 'claude-sonnet-4-6',
  cwd: '/path/to/project',
  permissionMode: 'acceptEdits',
  maxTurns: 10,
});

for await (const event of stream) {
  switch (event.type) {
    case 'assistant':
      console.log('Assistant:', event.message);
      break;
    case 'tool_result':
      console.log(`[${event.tool_name}]`, event.result);
      break;
    case 'result':
      console.log(`Done in ${event.num_turns} turns, cost: $${event.total_cost_usd}`);
      break;
  }
}
```

### Stateful Sessions (V2 API)

```typescript
import { createSession, resumeSession } from '@open-agent/sdk';

// Create a multi-turn session
const session = createSession({
  model: 'claude-opus-4-6',
  thinking: { type: 'enabled', budgetTokens: 16000 },
  persistSession: true,
});

// First turn
for await (const msg of session.send('Analyze the database schema')) {
  // process messages...
}

// Second turn — full context preserved
for await (const msg of session.send('Add an index on users.email')) {
  // process messages...
}

const id = session.sessionId;
session.close();

// Resume later — even from a different process
const restored = resumeSession(id, { model: 'claude-sonnet-4-6' });
for await (const msg of restored.send('What did we change last time?')) {
  // full history available
}
```

### Custom MCP Tools

```typescript
import { query, createSdkMcpServer, tool } from '@open-agent/sdk';

const server = createSdkMcpServer({
  name: 'deploy-tools',
  tools: [
    tool('deploy', 'Deploy to production', {
      type: 'object',
      properties: {
        branch: { type: 'string', description: 'Git branch to deploy' },
        env: { type: 'string', enum: ['staging', 'production'] },
      },
      required: ['branch', 'env'],
    }, async (input) => {
      // your deployment logic
      return `Deployed ${input.branch} to ${input.env}`;
    }),
  ],
});

const stream = query('Deploy the main branch to staging', {
  mcpServers: { deploy: server },
});
```

### QueryOptions Reference

```typescript
interface QueryOptions {
  // Model
  model?: string;                    // LLM model identifier
  effort?: 'low' | 'medium' | 'high' | 'max';
  thinking?: ThinkingConfig;         // { type: 'adaptive' | 'enabled' | 'disabled' }
  maxThinkingTokens?: number;

  // Execution
  cwd?: string;                      // Working directory
  maxTurns?: number;                 // Max conversation turns
  maxBudgetUsd?: number;             // Cost limit
  abortController?: AbortController; // Cancellation support

  // Tools & Permissions
  tools?: string[];                  // Tool whitelist
  allowedTools?: string[];
  disallowedTools?: string[];
  permissionMode?: PermissionMode;   // 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk'

  // Session
  sessionId?: string;
  resume?: string;                   // Resume from session ID
  persistSession?: boolean;

  // Extensions
  systemPrompt?: string;
  hooks?: Partial<Record<HookEvent, any[]>>;
  mcpServers?: Record<string, McpServerConfig>;
  agents?: Record<string, AgentDefinition>;
}
```

## Architecture

```
open-agent/
├── apps/
│   └── cli/                # Interactive terminal application
├── packages/
│   ├── sdk/                # Public SDK — query(), createSession(), MCP helpers
│   ├── core/               # ConversationLoop, SessionManager, SystemPrompt
│   ├── providers/          # LLM providers (Anthropic, OpenAI, Ollama)
│   ├── tools/              # 27 built-in tool implementations
│   ├── agents/             # AgentRunner, TeamManager, TaskManager
│   ├── permissions/        # PermissionEngine with 5 modes
│   ├── hooks/              # Lifecycle hook executor
│   ├── mcp/               # MCP client (stdio, HTTP, SSE transports)
│   ├── cli/                # Terminal renderer, input handling, themes
│   └── plugins/            # Plugin system
```

### Data Flow

```
User Input
    │
    ▼
┌──────────┐    ┌──────────────┐    ┌──────────────┐
│  CLI /   │───▶│ Conversation │───▶│ LLM Provider │──▶ Anthropic / OpenAI / Ollama
│   SDK    │    │    Loop      │    │  (streaming)  │
└──────────┘    └──────┬───────┘    └──────────────┘
                       │
                       ▼
                ┌──────────────┐
                │  Permission  │──▶ allow / deny / ask
                │   Engine     │
                └──────┬───────┘
                       │
                       ▼
                ┌──────────────┐
                │  Tool Exec   │──▶ Read, Write, Edit, Bash, Glob, Grep ...
                │   + Hooks    │
                └──────┬───────┘
                       │
                       ▼
                ┌──────────────┐
                │   Session    │──▶ JSONL transcript persistence
                │   Manager    │
                └──────────────┘
```

### Package Dependencies

```
@open-agent/sdk
    ├── @open-agent/core
    │     ├── @open-agent/providers    (Anthropic, OpenAI, Ollama)
    │     └── @open-agent/tools        (27 built-in tools)
    ├── @open-agent/agents             (multi-agent teams)
    ├── @open-agent/permissions        (5-mode permission engine)
    ├── @open-agent/hooks              (lifecycle events)
    └── @open-agent/mcp               (MCP stdio / HTTP / SSE)
```

## Tools

### File Operations

| Tool | Description |
|------|-------------|
| `Read` | Read files with line numbers, binary detection, PDF / image / notebook support |
| `Write` | Create or overwrite files |
| `Edit` | Precise string replacement with diff generation |
| `NotebookEdit` | Edit Jupyter notebook cells (replace, insert, delete) |

### Shell & Search

| Tool | Description |
|------|-------------|
| `Bash` | Shell commands with timeout, background tasks, abort signal propagation |
| `Glob` | Fast file pattern matching (`**/*.ts`, `src/**/*.test.*`) |
| `Grep` | Ripgrep-powered content search with regex, context lines, multiline mode |

### Web

| Tool | Description |
|------|-------------|
| `WebFetch` | Fetch & process URLs with 15-min LRU cache, redirect loop protection |
| `WebSearch` | Web search with domain filtering |

### Agent Teams

| Tool | Description |
|------|-------------|
| `Task` | Spawn specialized sub-agents (Explore, Plan, code-writer, etc.) |
| `TeamCreate` / `TeamDelete` | Create and manage multi-agent teams |
| `SendMessage` | Inter-agent messaging — DM, broadcast, shutdown requests |
| `TaskCreate` / `TaskUpdate` / `TaskGet` / `TaskList` | Shared task list for team coordination |
| `TaskOutput` / `TaskStop` | Monitor and control background tasks |

### Planning & Workflow

| Tool | Description |
|------|-------------|
| `EnterPlanMode` / `ExitPlanMode` | Plan-then-execute workflow with user approval |
| `EnterWorktree` | Isolated git worktree for safe, reversible changes |
| `AskUserQuestion` | Structured multi-choice questions with optional previews |
| `ToolSearch` | Discover and load deferred MCP tools on demand |
| `Skill` | Invoke registered slash command workflows |
| `Config` | Read and write agent configuration |
| `ListMcpResources` / `ReadMcpResource` | Browse and read MCP server resources |

## Providers

### Anthropic

```typescript
import { AnthropicProvider } from '@open-agent/providers';

const provider = new AnthropicProvider({
  apiKey: 'sk-ant-...',
});
```

**Features:** streaming, extended thinking (adaptive / enabled), prompt caching (system + tools), vision, interleaved thinking blocks, `redacted_thinking` passthrough.

### OpenAI-Compatible

```typescript
import { OpenAIProvider } from '@open-agent/providers';

const provider = new OpenAIProvider({
  apiKey: 'your-key',
  baseURL: 'https://api.openai.com/v1',
});
```

**Works with:** OpenAI, Azure OpenAI, DeepSeek, Qwen, GLM (智谱), vLLM, LiteLLM, and any OpenAI-compatible endpoint.

### Ollama

```typescript
import { OllamaProvider } from '@open-agent/providers';

const provider = new OllamaProvider({
  baseURL: 'http://localhost:11434',
});
```

**Run models locally** with zero API costs.

## Configuration

### Environment Variables

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `OPENAI_API_KEY` | OpenAI (or compatible) API key |
| `OPENAI_BASE_URL` | Custom endpoint for OpenAI-compatible providers |
| `BRAVE_SEARCH_API_KEY` | Brave Search API key (for `WebSearch` tool) |

### Config Files

| Path | Purpose |
|------|---------|
| `~/.open-agent/settings.json` | Global user settings |
| `<project>/.open-agent/settings.json` | Project-level settings |
| `AGENT.md` | Custom instructions per project |
| `~/.open-agent/hooks.json` | Global hook definitions |

### Permission Modes

| Mode | Behavior |
|------|----------|
| `default` | Ask user for dangerous operations (shell, file write, network) |
| `acceptEdits` | Auto-allow file edits, ask for shell commands |
| `bypassPermissions` | Allow everything without prompting |
| `plan` | Read-only exploration, require approval before any changes |
| `dontAsk` | Deny anything that would require user approval |

### Thinking Configuration

```typescript
// Adaptive — model decides when to think deeply
{ thinking: { type: 'adaptive' } }

// Explicit — fixed thinking budget
{ thinking: { type: 'enabled', budgetTokens: 16000 } }

// Effort presets — maps to thinking budgets automatically
{ effort: 'low' }    // 2,000 tokens
{ effort: 'medium' } // 8,000 tokens
{ effort: 'high' }   // 16,000 tokens
{ effort: 'max' }    // 32,000 tokens
```

### Hooks

Create `.open-agent/hooks.json` to run commands on lifecycle events:

```json
{
  "PreToolUse": [
    {
      "matcher": "Bash",
      "hooks": [{ "command": "echo 'About to run shell command'" }]
    }
  ],
  "PostToolUse": [
    {
      "matcher": "*",
      "hooks": [{ "command": "logger -t open-agent 'Tool executed'" }]
    }
  ]
}
```

**Supported events:** `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `SessionStart`, `SessionEnd`, `Stop`, `SubagentStart`, `SubagentStop`, `PreCompact`, `PermissionRequest`, `Setup`, `UserPromptSubmit`, `Notification`, `TeammateIdle`, `TaskCompleted`, `ConfigChange`, `WorktreeCreate`, `WorktreeRemove`

### MCP Servers

Add MCP servers via `.open-agent/settings.json`:

```json
{
  "mcpServers": {
    "filesystem": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"]
    },
    "remote-api": {
      "type": "http",
      "url": "https://mcp.example.com/api",
      "headers": { "Authorization": "Bearer token" }
    }
  }
}
```

## Development

```bash
# Install dependencies
bun install

# Run the CLI in dev mode
bun run dev

# Run all tests
bun test

# Type checking
bun run typecheck

# Build all packages
bun run build
```

### Project Stats

| Metric | Value |
|--------|-------|
| TypeScript | ~17,600 lines |
| Packages | 10 |
| Built-in tools | 27 |
| LLM providers | 3 |
| Test files | 15 |
| Tests | 286 passing |

## License

[MIT](LICENSE) © Colin Chen
