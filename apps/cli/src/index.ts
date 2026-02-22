#!/usr/bin/env bun
import { parseArgs, TerminalRenderer, REPL, emitStreamJson, TerminalPermissionPrompter, handleSlashCommand } from '@open-agent/cli';
import { ConversationLoop, SessionManager, ConfigLoader, AutoMemory, buildSystemPrompt, isGitRepository, FileCheckpoint } from '@open-agent/core';
import { createProvider, autoDetectProvider, calculateCost } from '@open-agent/providers';
import {
  createDefaultToolRegistry,
  createTaskTool,
  createTaskOutputTool,
  createTaskStopTool,
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
  getToolPromptDescriptions,
  createWorktree,
  cleanupWorktree,
  hasWorktreeChanges,
} from '@open-agent/tools';
import { AgentLoader, AgentExecutor, TaskManager, TeamManager } from '@open-agent/agents';
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
  // Working directory + settings
  // (settings must be loaded before model selection so defaults apply)
  // ------------------------------------------------------------------
  const cwd = process.cwd();
  const configLoader = new ConfigLoader();
  const settings = configLoader.loadSettings(cwd);

  // ------------------------------------------------------------------
  // Model selection — CLI flag > settings.json > provider default
  // ------------------------------------------------------------------
  const model = args.model ?? (settings.defaultModel as string | undefined) ?? getDefaultModel(provider.name);

  // ------------------------------------------------------------------
  // Tool registry
  // ------------------------------------------------------------------
  const toolRegistry = createDefaultToolRegistry(cwd);

  // ------------------------------------------------------------------
  // Task tool (subagent spawning)
  // ------------------------------------------------------------------
  const agentLoader = new AgentLoader();
  agentLoader.loadDefaults(cwd);

  // agentExecutor is initialized after hookExecutor is built (below) so it
  // can receive the hook executor for SubagentStart/Stop events.
  let agentExecutor: AgentExecutor;

  const taskTool = createTaskTool({
    runSubagent: async ({ prompt, subagentType, name, model: agentModel, cwd: agentCwd, maxTurns, mode, isolation, runInBackground, resume, teamName }) => {
      const agentDef = agentLoader.get(subagentType);
      if (!agentDef) {
        const available = agentLoader.list().map(([n]: [string, unknown]) => n).join(', ');
        throw new Error(`Unknown agent type: ${subagentType}. Available: ${available}`);
      }

      const effectiveCwd = agentCwd ?? cwd;

      // --- Worktree setup ---
      let worktreePath: string | undefined;
      let worktreeBranch: string | undefined;

      if (isolation === 'worktree') {
        const worktreeName = name ?? `agent-${resume ?? Date.now()}`;
        try {
          const wt = await createWorktree(effectiveCwd, worktreeName);
          worktreePath = wt.path;
          worktreeBranch = wt.branch;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(`Failed to create worktree: ${msg}`);
        }
      }

      const executeOptions = {
        definition: agentDef,
        provider,
        tools: new Map(toolRegistry.list().map((t) => [t.name, t])),
        prompt,
        cwd: effectiveCwd,
        name,
        model: agentModel,
        maxTurns,
        mode: mode ?? agentDef.mode,
        teamName,
        isolation,
        runInBackground,
        resume,
        worktreePath,
      };

      if (runInBackground) {
        const { agentId, outputFile } = await agentExecutor.executeInBackground(executeOptions);
        return JSON.stringify({
          agentId,
          output_file: outputFile,
          status: 'running',
          message: 'Agent is running in the background. Use Read tool or Bash tail to check output.',
          ...(worktreePath ? { worktree_path: worktreePath, worktree_branch: worktreeBranch } : {}),
        });
      }

      const { agentId, result, session } = await agentExecutor.execute(executeOptions);

      // --- Idle notification: inform team lead that this subagent is done ---
      if (teamName && name) {
        try {
          teamManager.notifyIdle(teamName, name);
        } catch {
          // Non-fatal — never let idle notification break the result.
        }
      }

      // --- Worktree post-processing (foreground) ---
      if (worktreePath) {
        const changed = await hasWorktreeChanges(worktreePath);
        if (!changed) {
          // Auto-cleanup: no changes made
          await cleanupWorktree(worktreePath);
          return JSON.stringify({
            agentId,
            result,
            numTurns: session.numTurns,
            durationMs: session.durationMs,
            worktree_cleaned_up: true,
            message: 'Agent completed with no file changes. Worktree was cleaned up automatically.',
          });
        }
        // Keep worktree for user to review/merge
        return JSON.stringify({
          agentId,
          result,
          numTurns: session.numTurns,
          durationMs: session.durationMs,
          worktree_path: worktreePath,
          worktree_branch: worktreeBranch,
          message: `Agent completed with file changes. Worktree kept at ${worktreePath} on branch ${worktreeBranch}. Review changes and merge when ready.`,
        });
      }

      return JSON.stringify({
        agentId,
        result,
        numTurns: session.numTurns,
        durationMs: session.durationMs,
      });
    },
    getBackgroundAgent: (agentId: string) => {
      const session = agentExecutor.getAgent(agentId);
      if (!session) return null;
      return {
        status: session.state === 'running' ? 'running' : session.state === 'completed' ? 'completed' : 'failed',
        output_file: session.outputFile ?? '',
        result: session.result,
      };
    },
  });

  toolRegistry.register(taskTool);

  // Re-register TaskOutput/TaskStop with agent executor support.
  // This overwrites the versions registered by createDefaultToolRegistry()
  // that only support Bash background tasks.
  const agentManagementDeps = {
    getBackgroundAgent: (agentId: string) => {
      const session = agentExecutor.getAgent(agentId);
      if (!session) return null;
      return {
        status: (session.state === 'running' ? 'running' : session.state === 'completed' ? 'completed' : 'failed') as 'running' | 'completed' | 'failed',
        output_file: session.outputFile ?? '',
        result: session.result,
      };
    },
    stopBackgroundAgent: (agentId: string) => agentExecutor.stopAgent(agentId),
  };
  toolRegistry.register(createTaskOutputTool(agentManagementDeps));
  toolRegistry.register(createTaskStopTool(agentManagementDeps));

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
  const mcpManager = new McpManager();

  // Load MCP server configs from settings (key: mcpServers)
  const mcpServers = (settings.mcpServers ?? {}) as Record<string, any>;
  if (Object.keys(mcpServers).length > 0) {
    // Connect MCP servers and register their tools into the tool registry.
    // We use .then() so CLI startup is not blocked — MCP tools become
    // available shortly after the REPL is ready.
    mcpManager.setServers(mcpServers).then(async () => {
      try {
        const mcpTools = mcpManager.getAllTools();
        for (const mcpTool of mcpTools) {
          // Avoid overwriting built-in tools with same name.
          if (toolRegistry.get(mcpTool.name)) continue;
          toolRegistry.register({
            name: mcpTool.name,
            description: mcpTool.description ?? '',
            inputSchema: mcpTool.inputSchema ?? { type: 'object', properties: {} },
            execute: async (input: any) => {
              const result = await mcpManager.callTool(mcpTool.serverName, mcpTool.name, input);
              return typeof result === 'string' ? result : JSON.stringify(result);
            },
          });
        }
      } catch {
        // MCP tool registration failed — not fatal, continue without them.
      }
    }).catch(() => {});
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
      type: 'message' | 'broadcast' | 'shutdown_request' | 'shutdown_response' | 'plan_approval_response' | 'plan_approval_request';
      recipient?: string;
      content?: string;
      summary?: string;
      approve?: boolean;
      request_id?: string;
    }) => {
      // In standalone CLI mode there is no active team context, so we write
      // to the default team inbox so that actual teammate processes can pick it up.
      const activeTeam = (settings.activeTeam as string) ?? defaultTeamName;

      const msg = {
        type: params.type,
        from: 'cli',
        to: params.recipient,
        content: params.content ?? '',
        summary: params.summary,
        timestamp: new Date().toISOString(),
        requestId: params.request_id,
        approve: params.approve,
      };

      // broadcast is handled by TeamManager (writes to all member inboxes).
      teamManager.sendMessage(activeTeam, msg);

      const routing: Record<string, unknown> = {
        sender: 'cli',
        target: params.type === 'broadcast' ? '@all' : (params.recipient ?? 'unknown'),
        summary: params.summary ?? params.content?.slice(0, 60),
        content: params.content,
      };

      return { success: true, message: 'Message sent', routing };
    },
  };

  toolRegistry.register(createTeamCreateTool(teamToolsDeps));
  toolRegistry.register(createTeamDeleteTool(teamToolsDeps));
  toolRegistry.register(createSendMessageTool(teamToolsDeps));

  // ------------------------------------------------------------------
  // ToolSearch tool — enables deferred/lazy tool loading
  // Searches both registered tools AND MCP tools (even if not yet registered).
  // ------------------------------------------------------------------
  toolRegistry.register(createToolSearchTool({
    searchTools: async (query: string) => {
      const q = query.toLowerCase();

      // Search registered tools first
      const registered = toolRegistry.list()
        .filter(t => t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q))
        .map(t => ({ name: t.name, description: t.description }));

      // Also search MCP tools that may not yet be in the registry
      const mcpTools = mcpManager.getAllTools()
        .filter(t =>
          t.name.toLowerCase().includes(q) ||
          (t.description ?? '').toLowerCase().includes(q)
        )
        .filter(t => !toolRegistry.get(t.name)) // exclude already-registered ones
        .map(t => ({ name: t.name, description: t.description ?? `MCP tool from ${t.serverName}` }));

      return [...registered, ...mcpTools];
    },
    selectTool: async (name: string) => {
      // First try the registry
      const existing = toolRegistry.get(name);
      if (existing) return existing;

      // Fall back: find in MCP tools and dynamically create a ToolDefinition
      const mcpTool = mcpManager.getAllTools().find(t => t.name === name);
      if (mcpTool) {
        const tool = {
          name: mcpTool.name,
          description: mcpTool.description ?? '',
          inputSchema: mcpTool.inputSchema ?? { type: 'object', properties: {} },
          execute: async (input: any) => {
            const result = await mcpManager.callTool(mcpTool.serverName, mcpTool.name, input);
            return typeof result === 'string' ? result : JSON.stringify(result);
          },
        };
        // Register so it's available for subsequent calls
        toolRegistry.register(tool);
        return tool;
      }

      return null;
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
  // Abort handling (Ctrl+C) — two-level:
  //   First Ctrl+C  → abort the current LLM/tool operation gracefully.
  //   Second Ctrl+C within 2 s → force-exit immediately.
  // ------------------------------------------------------------------
  let abortController = new AbortController();
  let lastSigint = 0;
  process.on('SIGINT', () => {
    const now = Date.now();
    if (now - lastSigint < 2000) {
      // Double Ctrl+C — force exit.
      console.log('\nForce exit.');
      process.exit(1);
    }
    lastSigint = now;
    if (!abortController.signal.aborted) {
      abortController.abort();
      console.log('\n\x1b[33mInterrupting... (press Ctrl+C again to force exit)\x1b[0m');
    }
  });

  // ------------------------------------------------------------------
  // Permission system
  // ------------------------------------------------------------------
  // CLI flag > settings.json > 'default'
  const effectivePermissionMode: PermissionMode =
    (args.permissionMode as PermissionMode | undefined) ??
    (settings.permissionMode as PermissionMode | undefined) ??
    'default';

  const permissionEngine = new PermissionEngine({
    mode: effectivePermissionMode,
  });
  // Wire settings-based rules (allow/deny/ask arrays from settings.json permissions key)
  permissionEngine.loadFromSettings(settings);
  // Wire path restrictions from settings.json permissions.allowedPaths / deniedPaths
  if (settings.permissions?.allowedPaths) {
    permissionEngine.setAllowedPaths(settings.permissions.allowedPaths as string[]);
  }
  if (settings.permissions?.deniedPaths) {
    permissionEngine.setDeniedPaths(settings.permissions.deniedPaths as string[]);
  }
  const permissionPrompter = new TerminalPermissionPrompter();

  // ------------------------------------------------------------------
  // AGENT.md config and Auto-Memory
  // ------------------------------------------------------------------
  const agentInstructions = configLoader.loadAgentMd(cwd);
  const autoMemory = new AutoMemory(cwd);
  const memoryContent = autoMemory.readMemory();

  // ------------------------------------------------------------------
  // File checkpoint — records file states before Write/Edit operations
  // so the user can /rewind to any prior state.
  // ------------------------------------------------------------------
  const checkpoint = new FileCheckpoint(sessionMgr.getSessionDir(cwd, sessionId));

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

  // Also load hooks from settings.json (merged across user → project → local layers).
  // settings.hooks shape: { [HookEvent]: HookDefinition[] } — same as loadFromConfig expects.
  if (settings.hooks && typeof settings.hooks === 'object') {
    try {
      _hookExecutor.loadFromConfig(settings.hooks as any);
    } catch {
      // Malformed hooks in settings — skip silently.
    }
  }

  // Adapter: bridge HookExecutor's strict HookInput signature to the loose
  // Record<string, unknown> interface expected by ConversationLoop.
  // Also intercepts PreToolUse events for file-modifying tools to save
  // checkpoints before any changes are applied.
  const hookExecutor = {
    async execute(event: string, input: Record<string, unknown>, toolUseId?: string) {
      // Auto-checkpoint before file-modifying tools so /rewind can restore.
      if (event === 'PreToolUse' && toolUseId) {
        const toolName = input.tool_name as string;
        if (toolName === 'Write' || toolName === 'Edit') {
          const filePath = (input.tool_input as any)?.file_path;
          if (filePath) {
            try { checkpoint.save(toolUseId, filePath); } catch { /* ignore checkpoint errors */ }
          }
        }
      }
      return _hookExecutor.execute(event as any, input as any, toolUseId);
    },
  };

  // Now that hookExecutor is ready, initialise AgentExecutor so subagent
  // lifecycle hooks (SubagentStart / SubagentStop) are wired in.
  agentExecutor = new AgentExecutor(hookExecutor);

  // Fire SessionStart hook — all setup is complete.
  const sessionSource: 'startup' | 'resume' = args.resume || args.continue ? 'resume' : 'startup';
  try {
    await hookExecutor.execute('SessionStart', {
      hook_event_name: 'SessionStart',
      session_id: sessionId,
      transcript_path: join(sessionMgr.getSessionDir(cwd, sessionId), `${sessionId}.jsonl`),
      cwd,
      permission_mode: effectivePermissionMode,
      source: sessionSource,
      model,
    });
  } catch {
    // SessionStart hooks are non-fatal.
  }

  // ------------------------------------------------------------------
  // Resolve settings-derived loop options
  //   CLI flags always take precedence; settings.json provides fallbacks.
  // ------------------------------------------------------------------
  const effectiveMaxTurns: number | undefined =
    args.maxTurns ?? (settings.maxTurns as number | undefined);

  // thinking: CLI has no direct flag; settings.json can specify the mode.
  const settingsThinking = settings.thinking as string | undefined;
  const effectiveThinking: import('@open-agent/core').ThinkingConfig =
    settingsThinking === 'enabled'  ? { type: 'enabled' } :
    settingsThinking === 'disabled' ? { type: 'disabled' } :
    { type: 'adaptive' }; // default / 'adaptive'

  // effort: CLI has no direct flag; settings.json can specify the level.
  const effectiveEffort =
    (settings.effort as 'low' | 'medium' | 'high' | 'max' | undefined) ?? 'high';

  // customInstructions: appended to the system prompt as extra guidance.
  const customInstructions = settings.customInstructions as string | undefined;
  const customInstructionsList: string[] =
    customInstructions ? [customInstructions] : [];

  const toolNames = toolRegistry.list().map(t => t.name);

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
      tools: toolNames,
      permissionMode: effectivePermissionMode,
      agentInstructions: [...agentInstructions, ...customInstructionsList],
      memoryContent,
      memoryDir: autoMemory.getDir(),
      isGitRepo: isGitRepository(cwd),
      toolDescriptions: getToolPromptDescriptions(),
      knowledgeCutoff: 'May 2025',
    }),
    maxTurns: effectiveMaxTurns,
    thinking: effectiveThinking,
    effort: effectiveEffort,
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
  // Print mode  (open-agent --print "…")
  // Sends the prompt to the LLM with NO tools and prints the raw text
  // output.  Useful for scripting and piping.
  // ------------------------------------------------------------------
  if (args.print && args.prompt) {
    const printLoop = new ConversationLoop({
      provider,
      tools: new Map(), // No tools in print mode
      model,
      systemPrompt: loop['options'].systemPrompt, // reuse same system prompt
      maxTurns: 1,
      thinking: effectiveThinking,
      effort: effectiveEffort,
      cwd,
      sessionId,
      abortSignal: abortController.signal,
      costCalculator: calculateCost,
    });
    for await (const message of printLoop.run(args.prompt)) {
      if (message.type === 'result' && (message as any).result) {
        process.stdout.write((message as any).result);
      } else if (message.type === 'stream_event') {
        const evt = (message as any).event;
        if (evt?.type === 'text_delta') {
          process.stdout.write(evt.text);
        }
      }
    }
    process.stdout.write('\n');
    process.exit(0);
  }

  // ------------------------------------------------------------------
  // Single-prompt mode  (open-agent -p "…" or open-agent "…")
  // ------------------------------------------------------------------
  if (args.prompt) {
    await executePrompt(loop, args.prompt, renderer, isStreamJson, sessionMgr, cwd, sessionId);
    // Fire SessionEnd before exiting single-prompt mode.
    try {
      await hookExecutor.execute('SessionEnd', {
        hook_event_name: 'SessionEnd',
        session_id: sessionId,
        transcript_path: join(sessionMgr.getSessionDir(cwd, sessionId), `${sessionId}.jsonl`),
        cwd,
        permission_mode: effectivePermissionMode,
        reason: 'exit',
      });
    } catch { /* non-fatal */ }
    process.exit(0);
  }

  // ------------------------------------------------------------------
  // Interactive REPL mode
  // ------------------------------------------------------------------
  renderer.renderWelcome(model, cwd);
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
        tools: toolNames,
        checkpoint,
        sessionMgr,
        permissionMode: effectivePermissionMode,
        thinking: effectiveThinking.type,
        effort: effectiveEffort,
        agentTypes: agentLoader.list().map(([name, def]) => ({
          name,
          description: def.description,
        })),
        mcpStatus: mcpManager.getServerStatus().map((s: any) => ({
          name: s.name,
          status: s.status,
        })),
        permissionEngine,
      });
      if (result) {
        if (result.shouldExit) break;
        if (result.shouldClear) { console.clear(); continue; }
        if (result.output) console.log(result.output);
        continue;
      }
    }

    // Create a fresh AbortController for each prompt so that a previous
    // Ctrl+C abort does not carry over to the next turn.
    abortController = new AbortController();
    loop.setAbortSignal(abortController.signal);

    await executePrompt(loop, input, renderer, isStreamJson, sessionMgr, cwd, sessionId);
    repl.renderTurnSeparator();
  }

  repl.close();

  // Fire SessionEnd hook — session is closing normally.
  try {
    await hookExecutor.execute('SessionEnd', {
      hook_event_name: 'SessionEnd',
      session_id: sessionId,
      transcript_path: join(sessionMgr.getSessionDir(cwd, sessionId), `${sessionId}.jsonl`),
      cwd,
      permission_mode: effectivePermissionMode,
      reason: 'exit',
    });
  } catch {
    // SessionEnd hooks are non-fatal.
  }
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
  // Touch session to update lastActiveAt so --continue picks the right session.
  sessionMgr.touchSession(cwd, sessionId);
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
    case 'system':
      // Per-turn cost/token summary emitted by the conversation loop.
      if ((message as any).turn_cost !== undefined) {
        const tc = message as any;
        renderer.renderTurnCost(tc.turn_input_tokens, tc.turn_output_tokens, tc.cumulative_cost);
      }
      break;
    // 'user', 'assistant' messages are informational only; no
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
  /cost                       Show cumulative session cost and token usage
  /tools                      List all registered tools
  /permissions                Show current permission mode
  `);
}

main().catch((err: unknown) => {
  console.error('Fatal error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
