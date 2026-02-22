#!/usr/bin/env bun
import { parseArgs, TerminalRenderer, REPL, emitStreamJson, TerminalPermissionPrompter, handleSlashCommand } from '@open-agent/cli';
import { ConversationLoop, SessionManager, ConfigLoader, AutoMemory, buildSystemPrompt, isGitRepository } from '@open-agent/core';
import { createProvider, autoDetectProvider, calculateCost } from '@open-agent/providers';
import {
  createDefaultToolRegistry,
  createTaskTool,
  createEnterPlanModeTool,
  createExitPlanModeTool,
  createListMcpResourcesTool,
  createReadMcpResourceTool,
  createTaskCreateTool,
  createTaskUpdateTool,
  createTaskGetTool,
  createTaskListTool,
  createTeamCreateTool,
  createTeamDeleteTool,
  createSendMessageTool,
  createToolSearchTool,
  createSkillTool,
} from '@open-agent/tools';
import { AgentLoader, AgentRunner, TaskManager, TeamManager } from '@open-agent/agents';
import { McpManager } from '@open-agent/mcp';
import { PermissionEngine } from '@open-agent/permissions';
import { HookExecutor } from '@open-agent/hooks';
import type { SDKMessage } from '@open-agent/core';
import type { PermissionMode } from '@open-agent/core';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const VERSION = '0.1.0';

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  if (args.version) {
    console.log(`open-agent v${VERSION}`);
    process.exit(0);
  }

  // ------------------------------------------------------------------
  // Provider setup
  // ------------------------------------------------------------------
  const provider = args.provider
    ? createProvider({
        provider: args.provider as 'anthropic' | 'openai' | 'ollama',
        apiKey: args.apiKey,
        baseURL: args.baseURL,
      })
    : autoDetectProvider();

  // ------------------------------------------------------------------
  // Model selection
  // ------------------------------------------------------------------
  const model = args.model ?? getDefaultModel(provider.name);

  // ------------------------------------------------------------------
  // Tool registry
  // ------------------------------------------------------------------
  const cwd = process.cwd();
  const toolRegistry = createDefaultToolRegistry(cwd);

  // ------------------------------------------------------------------
  // Task tool (subagent spawning)
  // ------------------------------------------------------------------
  const agentLoader = new AgentLoader();
  agentLoader.loadDefaults(cwd);

  const taskTool = createTaskTool({
    runSubagent: async ({ prompt, subagentType, name: _name, model: _model, cwd: agentCwd }) => {
      const agentDef = agentLoader.get(subagentType);
      if (!agentDef) {
        throw new Error(`Unknown agent type: ${subagentType}`);
      }

      const runner = new AgentRunner({
        definition: agentDef,
        provider,
        tools: new Map(toolRegistry.list().map((t) => [t.name, t])),
        cwd: agentCwd,
      });

      return runner.run(prompt);
    },
  });

  toolRegistry.register(taskTool);

  // ------------------------------------------------------------------
  // Plan mode tools
  // ------------------------------------------------------------------
  let _planMode = false;
  const planModeDeps = {
    enterPlanMode: () => { _planMode = true; },
    exitPlanMode: (_allowedPrompts?: { tool: string; prompt: string }[]) => { _planMode = false; },
    isPlanMode: () => _planMode,
  };
  toolRegistry.register(createEnterPlanModeTool(planModeDeps));
  toolRegistry.register(createExitPlanModeTool(planModeDeps));

  // ------------------------------------------------------------------
  // MCP tools
  // ------------------------------------------------------------------
  const configLoader = new ConfigLoader();
  const settings = configLoader.loadSettings(cwd);
  const mcpManager = new McpManager();

  // Load MCP server configs from settings (key: mcpServers)
  const mcpServers = (settings.mcpServers ?? {}) as Record<string, any>;
  if (Object.keys(mcpServers).length > 0) {
    // Fire-and-forget: connection errors are recorded on the manager but
    // should not prevent the CLI from starting.
    mcpManager.setServers(mcpServers).catch(() => {});
  }

  toolRegistry.register(createListMcpResourcesTool({
    listResources: async (server?: string) => {
      const all = await mcpManager.getAllResources();
      return server ? all.filter(r => r.server === server) : all;
    },
    readResource: async (server: string, uri: string) => {
      const result = await mcpManager.readResource(server, uri);
      return typeof result === 'string' ? result : JSON.stringify(result);
    },
  }));

  toolRegistry.register(createReadMcpResourceTool({
    listResources: async (server?: string) => {
      const all = await mcpManager.getAllResources();
      return server ? all.filter(r => r.server === server) : all;
    },
    readResource: async (server: string, uri: string) => {
      const result = await mcpManager.readResource(server, uri);
      return typeof result === 'string' ? result : JSON.stringify(result);
    },
  }));

  // ------------------------------------------------------------------
  // Task management tools (TaskCreate / TaskUpdate / TaskGet / TaskList)
  // ------------------------------------------------------------------
  // Use a stable default team name scoped to this session's cwd so tasks
  // persist across --continue invocations.
  const defaultTeamName = 'default';
  const taskManager = new TaskManager(defaultTeamName);

  const taskToolsDeps = {
    createTask: async (params: { subject: string; description: string; activeForm?: string; metadata?: Record<string, unknown> }) => {
      const item = taskManager.create(params.subject, params.description, params.activeForm, params.metadata);
      return { id: item.id, subject: item.subject };
    },
    updateTask: async (params: { taskId: string; [key: string]: unknown }) => {
      taskManager.update(params.taskId, params as any);
      return { success: true };
    },
    getTask: async (taskId: string) => taskManager.get(taskId),
    listTasks: async () => taskManager.listAll(),
  };

  toolRegistry.register(createTaskCreateTool(taskToolsDeps));
  toolRegistry.register(createTaskUpdateTool(taskToolsDeps));
  toolRegistry.register(createTaskGetTool(taskToolsDeps));
  toolRegistry.register(createTaskListTool(taskToolsDeps));

  // ------------------------------------------------------------------
  // Team tools (TeamCreate / TeamDelete / SendMessage)
  // ------------------------------------------------------------------
  const teamManager = new TeamManager();
  const teamToolsDeps = {
    createTeam: async (name: string, description?: string) => {
      teamManager.createTeam(name, description);
      const configPath = join(homedir(), '.open-agent', 'teams', name, 'config.json');
      return { teamName: name, configPath };
    },
    deleteTeam: async (name: string) => {
      teamManager.deleteTeam(name);
      return { success: true };
    },
    sendMessage: async (params: {
      type: 'message' | 'broadcast' | 'shutdown_request' | 'shutdown_response' | 'plan_approval_response';
      recipient?: string;
      content?: string;
      summary?: string;
      approve?: boolean;
      request_id?: string;
    }) => {
      // In standalone CLI mode there is no active team context, so we write
      // to a default team inbox so that actual teammate processes can pick it up.
      const activeTeam = (settings.activeTeam as string) ?? defaultTeamName;
      teamManager.sendMessage(activeTeam, {
        type: params.type,
        from: 'cli',
        to: params.recipient,
        content: params.content ?? '',
        summary: params.summary,
        timestamp: new Date().toISOString(),
        requestId: params.request_id,
        approve: params.approve,
      });
      return { success: true, message: 'Message sent' };
    },
  };

  toolRegistry.register(createTeamCreateTool(teamToolsDeps));
  toolRegistry.register(createTeamDeleteTool(teamToolsDeps));
  toolRegistry.register(createSendMessageTool(teamToolsDeps));

  // ------------------------------------------------------------------
  // ToolSearch tool — enables deferred/lazy tool loading
  // ------------------------------------------------------------------
  toolRegistry.register(createToolSearchTool({
    searchTools: async (query: string) => {
      const q = query.toLowerCase();
      return toolRegistry.list()
        .filter(t => t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q))
        .map(t => ({ name: t.name, description: t.description }));
    },
    selectTool: async (name: string) => {
      return toolRegistry.get(name) ?? null;
    },
  }));

  // ------------------------------------------------------------------
  // Skill tool — execute named slash-command skills
  // ------------------------------------------------------------------
  toolRegistry.register(createSkillTool({
    executeSkill: async (name: string, skillArgs?: string) => {
      // Skills are stored as markdown files under ~/.open-agent/skills/ or
      // <cwd>/.open-agent/skills/.  For now we return a stub so the tool is
      // registered and the LLM can call it; a full executor can be wired later.
      const skillDirs = [
        join(homedir(), '.open-agent', 'skills'),
        join(cwd, '.open-agent', 'skills'),
      ];
      for (const dir of skillDirs) {
        const skillPath = join(dir, `${name}.md`);
        if (existsSync(skillPath)) {
          const content = readFileSync(skillPath, 'utf-8');
          return `Skill "${name}" loaded. Content:\n\n${content}\nArgs: ${skillArgs ?? '(none)'}`;
        }
      }
      return `Skill "${name}" not found. Searched: ${skillDirs.join(', ')}`;
    },
    listSkills: () => {
      const skills: { name: string; description: string }[] = [];
      const skillDirs = [
        join(homedir(), '.open-agent', 'skills'),
        join(cwd, '.open-agent', 'skills'),
      ];
      for (const dir of skillDirs) {
        if (existsSync(dir)) {
          try {
            const { readdirSync: readDir } = require('fs') as typeof import('fs');
            const files = readDir(dir).filter((f: string) => f.endsWith('.md'));
            for (const f of files) {
              skills.push({ name: f.replace(/\.md$/, ''), description: `Skill from ${dir}` });
            }
          } catch {
            // Directory unreadable — skip
          }
        }
      }
      return skills;
    },
  }));

  // ------------------------------------------------------------------
  // Session management
  // ------------------------------------------------------------------
  const sessionMgr = new SessionManager();
  let sessionId: string;
  let initialMessages: import('@open-agent/providers').Message[] = [];

  if (args.resume) {
    // Resume an explicit session by ID — restore its conversation history.
    sessionId = args.resume;
    initialMessages = sessionMgr.loadTranscript(cwd, sessionId);
  } else if (args.continue) {
    // Continue from the most recent session for this CWD, or create one.
    const latest = sessionMgr.getLatestSession(cwd);
    if (latest) {
      sessionId = latest.id;
      initialMessages = sessionMgr.loadTranscript(cwd, sessionId);
    } else {
      sessionId = sessionMgr.createSession(cwd, model).id;
    }
  } else {
    sessionId = sessionMgr.createSession(cwd, model).id;
  }

  // ------------------------------------------------------------------
  // Abort handling (Ctrl+C)
  // ------------------------------------------------------------------
  const abortController = new AbortController();
  process.on('SIGINT', () => {
    abortController.abort();
  });

  // ------------------------------------------------------------------
  // Permission system
  // ------------------------------------------------------------------
  const permissionEngine = new PermissionEngine({
    mode: (args.permissionMode as PermissionMode) ?? 'default',
  });
  const permissionPrompter = new TerminalPermissionPrompter();

  // ------------------------------------------------------------------
  // AGENT.md config and Auto-Memory
  // ------------------------------------------------------------------
  // Note: configLoader was already instantiated above for MCP settings.
  const agentInstructions = configLoader.loadAgentMd(cwd);
  const autoMemory = new AutoMemory(cwd);
  const memoryContent = autoMemory.readMemory();

  // ------------------------------------------------------------------
  // Hook system — load global then project-level hooks.json
  // ------------------------------------------------------------------
  const _hookExecutor = new HookExecutor();

  const globalHooksPath = join(homedir(), '.open-agent', 'hooks.json');
  if (existsSync(globalHooksPath)) {
    try {
      const config = JSON.parse(readFileSync(globalHooksPath, 'utf-8'));
      _hookExecutor.loadFromConfig(config);
    } catch {
      // Malformed global hooks.json — skip silently.
    }
  }

  const projectHooksPath = join(cwd, '.open-agent', 'hooks.json');
  if (existsSync(projectHooksPath)) {
    try {
      const config = JSON.parse(readFileSync(projectHooksPath, 'utf-8'));
      _hookExecutor.loadFromConfig(config);
    } catch {
      // Malformed project hooks.json — skip silently.
    }
  }

  // Adapter: bridge HookExecutor's strict HookInput signature to the loose
  // Record<string, unknown> interface expected by ConversationLoop.
  const hookExecutor = {
    execute(event: string, input: Record<string, unknown>, toolUseId?: string) {
      return _hookExecutor.execute(event as any, input as any, toolUseId);
    },
  };

  // ------------------------------------------------------------------
  // Conversation loop
  // ------------------------------------------------------------------
  const loop = new ConversationLoop({
    provider,
    // Pass the full tool map; ConversationLoop expects Map<name, ToolDefinition>.
    tools: new Map(toolRegistry.list().map((t) => [t.name, t])),
    model,
    systemPrompt: buildSystemPrompt({
      cwd,
      model,
      tools: toolRegistry.list().map(t => t.name),
      permissionMode: (args.permissionMode as string) ?? 'default',
      agentInstructions,
      memoryContent,
      memoryDir: autoMemory.getDir(),
      isGitRepo: isGitRepository(cwd),
    }),
    maxTurns: args.maxTurns,
    thinking: { type: 'adaptive' },
    effort: 'high',
    cwd,
    sessionId,
    abortSignal: abortController.signal,
    permissionEngine,
    permissionPrompter,
    hookExecutor,
    costCalculator: calculateCost,
    initialMessages: initialMessages.length > 0 ? initialMessages : undefined,
  });

  const renderer = new TerminalRenderer();
  const isStreamJson = args.outputFormat === 'stream-json';

  // ------------------------------------------------------------------
  // Single-prompt mode  (open-agent -p "…" or open-agent "…")
  // ------------------------------------------------------------------
  if (args.prompt) {
    await executePrompt(loop, args.prompt, renderer, isStreamJson, sessionMgr, cwd, sessionId);
    process.exit(0);
  }

  // ------------------------------------------------------------------
  // Interactive REPL mode
  // ------------------------------------------------------------------
  renderer.renderWelcome(model);
  const repl = new REPL(model);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const input = await repl.getInput();

    if (input === null) {
      // EOF — user pressed Ctrl+D
      console.log('\nGoodbye!');
      break;
    }

    if (input === '') continue;

    if (input.startsWith('/')) {
      const result = await handleSlashCommand(input, {
        loop,
        cwd,
        model,
        sessionId,
      });
      if (result) {
        if (result.shouldExit) break;
        if (result.shouldClear) { console.clear(); continue; }
        if (result.output) console.log(result.output);
        continue;
      }
    }

    await executePrompt(loop, input, renderer, isStreamJson, sessionMgr, cwd, sessionId);
    repl.renderTurnSeparator();
  }

  repl.close();
}

// ---------------------------------------------------------------------------
// Helper: run one prompt through the conversation loop and render output
// ---------------------------------------------------------------------------
async function executePrompt(
  loop: ConversationLoop,
  prompt: string,
  renderer: TerminalRenderer,
  isStreamJson: boolean,
  sessionMgr: SessionManager,
  cwd: string,
  sessionId: string,
): Promise<void> {
  renderer.startSpinner('Thinking');
  for await (const message of loop.run(prompt)) {
    if (isStreamJson) {
      emitStreamJson(message);
    } else {
      renderMessage(renderer, message);
    }
    // Persist every message to the on-disk transcript.
    sessionMgr.appendToTranscript(cwd, sessionId, message);
  }
  renderer.stopSpinner();
}

function renderMessage(renderer: TerminalRenderer, message: SDKMessage): void {
  switch (message.type) {
    case 'stream_event':
      renderer.renderStreamEvent(message.event);
      break;
    case 'tool_result':
      renderer.renderToolResult(
        (message as any).tool_name,
        (message as any).result,
        (message as any).is_error,
      );
      break;
    case 'result':
      renderer.renderResult(message as Record<string, any>);
      break;
    // 'user', 'assistant', 'system' messages are informational only; no
    // terminal output is needed for them in the default renderer.
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function getDefaultModel(providerName: string): string {
  switch (providerName) {
    case 'anthropic':
      return 'claude-sonnet-4-6';
    case 'openai':
      return 'gpt-4o';
    case 'ollama':
      return 'llama3';
    default:
      return 'claude-sonnet-4-6';
  }
}


function printHelp(): void {
  console.log(`
OpenAgent - AI Coding Assistant

Usage: open-agent [options] [prompt]

Options:
  -m, --model <model>         Model to use (default: auto-detect per provider)
  -p, --prompt <text>         Run a single prompt and exit
  -r, --resume <id>           Resume a previous session by ID
  -c, --continue              Continue the most recent session in this directory
      --provider <name>       LLM provider: anthropic | openai | ollama
      --api-key <key>         API key for the chosen provider
      --base-url <url>        Base URL for the provider API
      --permission-mode <m>   Permission mode: default | acceptEdits | bypassPermissions
      --output-format <fmt>   Output format: text | stream-json
      --max-turns <n>         Maximum conversation turns
      --print                 Print-only mode (no tool calls)
      --verbose, --debug      Enable verbose output
  -h, --help                  Show this help message
  -v, --version               Show version number

Slash commands (REPL mode):
  /exit, /quit                Exit the REPL
  /clear                      Clear the terminal screen
  /help                       Show available commands
  /model [name]               Show or change model
  /compact                    Compact conversation history
  /status                     Show session status
  /memory                     Show auto-memory status
  `);
}

main().catch((err: unknown) => {
  console.error('Fatal error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
