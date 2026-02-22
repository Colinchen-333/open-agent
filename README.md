# OpenAgent

An open-source AI coding assistant for the terminal, built with TypeScript and Bun.

## Features

- Interactive REPL with Markdown rendering
- Multiple LLM providers (Anthropic, OpenAI, Ollama)
- 27 built-in tools (file ops, search, web, git, notebooks, MCP, agent teams, etc.)
- Permission system with 5 modes (`default`, `acceptEdits`, `bypassPermissions`, `plan`, `dontAsk`)
- Session management with resume/continue
- Agent spawning and team collaboration
- MCP (Model Context Protocol) integration
- Hook system for custom automation
- Auto-memory for cross-session persistence
- AGENT.md custom instruction support
- Skill system for reusable slash command workflows
- Plan mode for review-before-execute workflows
- Git worktree isolation support

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) v1.0+
- An API key for your preferred LLM provider

### Install

```bash
git clone <repo-url>
cd open-agent
bun install
bun link
```

### Usage

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

### Environment Variables

- `ANTHROPIC_API_KEY` - Anthropic API key
- `OPENAI_API_KEY` - OpenAI API key
- `BRAVE_SEARCH_API_KEY` - Brave Search API key (for web search)

### Configuration

- `~/.open-agent/settings.json` - Global settings
- `<project>/.open-agent/settings.json` - Project settings
- `AGENT.md` - Custom instructions per project
- `~/.open-agent/hooks.json` - Hook definitions

### Slash Commands

- `/help` - Show available commands
- `/model [name]` - Show/change model
- `/compact` - Compact conversation history
- `/cost` - Show session cost
- `/tools` - List registered tools
- `/status` - Session status
- `/memory` - Memory status
- `/clear` - Clear screen
- `/exit` - Exit

## Architecture

Monorepo with workspace packages:

| Package | Description |
|---------|-------------|
| `@open-agent/core` | Conversation loop, session management, memory |
| `@open-agent/providers` | LLM provider abstraction (Anthropic, OpenAI, Ollama) |
| `@open-agent/tools` | 27 built-in tools |
| `@open-agent/permissions` | Permission engine with 5 modes |
| `@open-agent/hooks` | Event hook system |
| `@open-agent/agents` | Agent/team management |
| `@open-agent/mcp` | MCP client integration |
| `@open-agent/sdk` | Public SDK API |
| `@open-agent/plugins` | Plugin system |
| `@open-agent/cli` | Terminal UI (renderer, REPL, args) |

## Built-in Tools

| Tool | Description |
|------|-------------|
| `Read` | Read files with line numbers; PDF/image info and extraction hints |
| `Write` | Write or overwrite files |
| `Edit` | Exact-string replace within files |
| `Bash` | Run shell commands with timeout and background support |
| `Glob` | Fast file pattern matching |
| `Grep` | Ripgrep-powered content search |
| `WebFetch` | Fetch and process web page content |
| `WebSearch` | Live web search |
| `NotebookEdit` | Edit Jupyter notebook cells |
| `AskUser` | Prompt the user for input mid-task |
| `Config` | Read/write agent configuration |
| `ToolSearch` | Discover and load deferred tools |
| `EnterPlanMode` | Switch to plan-only (no-execute) mode |
| `ExitPlanMode` | Exit plan mode and resume execution |
| `EnterWorktree` | Create an isolated git worktree |
| `TaskCreate` | Create a task in the shared task list |
| `TaskUpdate` | Update a task (status, owner, dependencies) |
| `TaskGet` | Retrieve full task details |
| `TaskList` | List all tasks |
| `TaskOutput` | Read output from a background task |
| `TaskStop` | Stop a background task |
| `TeamCreate` | Create a multi-agent team |
| `TeamDelete` | Remove a team and its task directory |
| `SendMessage` | Send messages between agents |
| `ListMcpResources` | List resources from MCP servers |
| `ReadMcpResource` | Read a specific MCP resource |
| `Skill` | Execute a named skill (slash command workflow) |

## License

MIT
