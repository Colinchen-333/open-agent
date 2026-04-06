#!/usr/bin/env bun
import { parseArgs, TerminalRenderer, REPL, emitStreamJson, emitStreamJsonInit, TerminalPermissionPrompter, handleSlashCommand } from '@open-agent/cli';
import { ConversationLoop, SessionManager, ConfigLoader, buildSystemPrompt, buildSystemPromptBlocks, isGitRepository, FileCheckpoint, buildTaskOrchestrationTemplates, loadPromptContext, buildSystemPromptRuntimeSnapshot, loadOutputStyles, mergeOutputStyles, findOutputStyle, BUILTIN_OUTPUT_STYLES, createLLMSummarizer, feature } from '@open-agent/core';
import type { OutputStyle } from '@open-agent/core';
import { createStore, createDefaultAppState } from '@open-agent/state';
import type { AppState } from '@open-agent/state';
import { renderApp } from '@open-agent/ink';
import { createProvider, autoDetectProvider, calculateCost } from '@open-agent/providers';
import {
  createDefaultToolRegistry,
  createTaskTool,
  createTaskOutputTool,
  createTaskStopTool,
  createEnterPlanModeTool,
  createExitPlanModeTool,
  createTaskCreateTool,
  createTaskUpdateTool,
  createTaskGetTool,
  createTaskListTool,
  createTeamCreateTool,
  createTeamDeleteTool,
  createSendMessageTool,
  getToolPromptDescriptions,
  createWorktree,
  cleanupWorktree,
  hasWorktreeChanges,
} from '@open-agent/tools';
import { AgentLoader, AgentExecutor, TaskManager, TeamManager } from '@open-agent/agents';
import type { AgentSession } from '@open-agent/agents';
import { HookExecutor } from '@open-agent/hooks';
import { OpenAgentRuntime, filterCapabilitySnapshot } from '@open-agent/runtime';
import type { SDKMessage, AgentDefinition, SDKTaskNotificationMessage, Settings } from '@open-agent/core';
import type { PermissionMode } from '@open-agent/core';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';
import { createCliPermissionRuntime, wrapCliPermissionPrompter } from './permission-runtime.js';
import { applyCliRuntimeSettingsRefresh, refreshCliRuntimeSurface } from './runtime-settings-refresh.js';

const VERSION = '0.1.0';

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.verbose) {
    process.env.DEBUG = 'open-agent:*';
  }

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
  const cwd = args.cwd ? require('path').resolve(args.cwd) : process.cwd();
  const additionalDirectories = (args.addDirs ?? []).map((d: string) => require('path').resolve(cwd, d));
  const configLoader = new ConfigLoader();
  let settings = configLoader.loadSettings(cwd);

  // ------------------------------------------------------------------
  // Model selection — CLI flag > settings.json > provider default
  // ------------------------------------------------------------------
  const model = args.model ?? (settings.defaultModel as string | undefined) ?? getDefaultModel(provider.name);
  const cliOutputStyle = args.outputFormat === 'stream-json' || args.json === true ? 'stream-json' : 'text';

  // ------------------------------------------------------------------
  // Tool registry
  // ------------------------------------------------------------------
  const toolRegistry = createDefaultToolRegistry(cwd);

  // ------------------------------------------------------------------
  // Task tool (subagent spawning)
  // ------------------------------------------------------------------
  const agentLoader = new AgentLoader();
  agentLoader.loadDefaults(cwd);
  const configuredSkillDirs = Array.isArray(settings.skillDirectories)
    ? (settings.skillDirectories as unknown[])
        .filter((dir): dir is string => typeof dir === 'string')
        .map((dir) => require('path').resolve(cwd, dir))
    : undefined;
  const runtime = new OpenAgentRuntime({
    cwd,
    toolRegistry,
    availableAgents: new Map(agentLoader.list() as [string, AgentDefinition][]),
    ...(configuredSkillDirs ? { skillDirectories: configuredSkillDirs } : {}),
    mcp: {
      toolNameStyle: 'namespaced',
      formatResult: (result) => (typeof result === 'string' ? result : JSON.stringify(result)),
      onToolRegistered: (tool) => {
        if ((globalThis as any).__openAgentLoop) {
          (globalThis as any).__openAgentLoop.addTool(tool);
        }
      },
    },
  });
  await runtime.initialize();
  runtime.registerSkillTool();
  runtime.registerMcpResourceTools();
  runtime.registerToolSearchTool();

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

      // R12: caller-supplied isolation wins; absent → fall back to agentDef.isolation.
      const effectiveIsolation = isolation ?? agentDef.isolation;
      // R12: explicit run_in_background=true wins; undefined → honour agentDef.allowBackgroundExecution.
      const effectiveRunInBackground =
        runInBackground === true ||
        (runInBackground === undefined && agentDef.allowBackgroundExecution === true);

      // --- Worktree setup ---
      let worktreePath: string | undefined;
      let worktreeBranch: string | undefined;

      if (effectiveIsolation === 'worktree') {
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
        model: agentModel ?? model, // inherit parent model when not specified
        maxTurns,
        mode: mode ?? agentDef.mode,
        teamName,
        isolation: effectiveIsolation,
        runInBackground: effectiveRunInBackground,
        resume,
        worktreePath,
      };

      // Fork isolation: snapshot parent messages and run in an isolated sidechain.
      // Checked before runInBackground so fork takes precedence over background dispatch.
      if (effectiveIsolation === 'fork' && typeof agentExecutor.executeForked === 'function') {
        const { agentId, outputFile } = await agentExecutor.executeForked({
          ...executeOptions,
          parentMessages: loop.getMessages(),
          root: effectiveCwd,
        });
        return JSON.stringify({
          status: 'async_launched',
          agentId,
          description: name ?? subagentType,
          prompt,
          outputFile,
          canReadOutputFile: true,
          task_event: {
            type: 'system',
            subtype: 'task_started',
            task_id: agentId,
            description: name ?? subagentType,
            task_type: 'agent',
          },
        });
      }

      if (effectiveRunInBackground) {
        const { agentId, outputFile } = await agentExecutor.executeInBackground(executeOptions);
        return JSON.stringify({
          status: 'async_launched',
          agentId,
          description: name ?? subagentType,
          prompt,
          outputFile,
          canReadOutputFile: true,
          task_event: {
            type: 'system',
            subtype: 'task_started',
            task_id: agentId,
            description: name ?? subagentType,
            task_type: 'agent',
          },
          ...(worktreePath ? { worktree_path: worktreePath, worktree_branch: worktreeBranch } : {}),
        });
      }

      const { agentId, result, session } = await agentExecutor.execute(executeOptions);

      if (teamName && name) {
        try {
          teamManager.notifyIdle(teamName, name);
        } catch { /* Non-fatal */ }
      }

      let worktreeCleanedUp = false;
      if (worktreePath) {
        const changed = await hasWorktreeChanges(worktreePath);
        if (!changed) {
          await cleanupWorktree(worktreePath);
          worktreeCleanedUp = true;
        }
      }

      const defaultUsage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: null, cache_read_input_tokens: null, server_tool_use: null, service_tier: null, cache_creation: null };
      const orchestrationTemplates = buildTaskOrchestrationTemplates({
        taskId: agentId,
        status: 'completed',
        description: name ?? subagentType,
        summary: summarizePlainText(result),
        result,
      });
      return JSON.stringify({
        status: 'completed',
        agentId,
        content: [{ type: 'text', text: result }],
        totalToolUseCount: session.totalToolUseCount ?? 0,
        totalDurationMs: session.durationMs,
        totalTokens: session.totalTokens ?? 0,
        usage: session.usage ?? defaultUsage,
        prompt,
        orchestration_templates: orchestrationTemplates,
        task_event: {
          type: 'system',
          subtype: 'task_notification',
          task_id: agentId,
          status: 'completed',
          ...(teamName ? { team_name: teamName } : {}),
          ...(name ? { description: name } : {}),
          output_file: session.outputFile ?? '',
          summary: summarizePlainText(result),
          orchestration_templates: orchestrationTemplates,
          usage: {
            total_tokens: session.totalTokens ?? 0,
            tool_uses: session.totalToolUseCount ?? 0,
            duration_ms: session.durationMs,
          },
        },
        ...(worktreePath ? { worktree_path: worktreePath, worktree_branch: worktreeBranch, worktree_cleaned_up: worktreeCleanedUp } : {}),
      });
    },
    getBackgroundAgent: (agentId: string) => {
      const session = agentExecutor.getAgent(agentId);
      if (!session) return null;
      return {
        status: session.state === 'running'
          ? 'running'
          : session.state === 'completed'
            ? 'completed'
            : session.state === 'shutdown'
              ? 'stopped'
              : 'failed',
        output_file: session.outputFile ?? '',
        result: session.result,
        summary: summarizePlainText(session.result ?? session.error),
        team_name: session.teamName,
        description: session.name ?? session.agentType,
        usage: {
          total_tokens: session.totalTokens ?? 0,
          tool_uses: session.totalToolUseCount ?? 0,
          duration_ms: session.durationMs,
        },
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
        status: (
          session.state === 'running'
            ? 'running'
            : session.state === 'completed'
              ? 'completed'
              : session.state === 'shutdown'
                ? 'stopped'
                : 'failed'
        ) as 'running' | 'completed' | 'failed' | 'stopped',
        output_file: session.outputFile ?? '',
        result: session.result,
        summary: summarizePlainText(session.result ?? session.error),
        team_name: session.teamName,
        description: session.name ?? session.agentType,
        usage: {
          total_tokens: session.totalTokens ?? 0,
          tool_uses: session.totalToolUseCount ?? 0,
          duration_ms: session.durationMs,
        },
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
  let _savedTools: Map<string, import('@open-agent/tools').ToolDefinition> | null = null;
  const READ_ONLY_TOOLS = new Set([
    'Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'TaskOutput',
    'EnterPlanMode', 'ExitPlanMode', 'AskUser', 'ListMcpResourcesTool', 'ReadMcpResourceTool',
    'ToolSearch',
  ]);
  const planModeDeps = {
    enterPlanMode: () => {
      _planMode = true;
      // Save current tools and restrict to read-only
      const allTools = new Map(toolRegistry.list().map(t => [t.name, t]));
      _savedTools = allTools;
      const readOnlyMap = new Map<string, import('@open-agent/tools').ToolDefinition>();
      for (const [name, tool] of allTools) {
        const isReadOnly = typeof tool.isReadOnly === 'function'
          ? tool.isReadOnly({})
          : tool.isReadOnly === true;
        if (isReadOnly || READ_ONLY_TOOLS.has(name) || name.startsWith('mcp__')) {
          readOnlyMap.set(name, tool);
        }
      }
      // loop may not exist yet at registration time; it's set later
      if ((globalThis as any).__openAgentLoop) {
        (globalThis as any).__openAgentLoop.setTools(readOnlyMap);
      }
    },
    exitPlanMode: (_allowedPrompts?: { tool: string; prompt: string }[]) => {
      _planMode = false;
      if (_savedTools && (globalThis as any).__openAgentLoop) {
        (globalThis as any).__openAgentLoop.setTools(_savedTools);
        _savedTools = null;
      }
    },
    isPlanMode: () => _planMode,
  };
  toolRegistry.register(createEnterPlanModeTool(planModeDeps));
  toolRegistry.register(createExitPlanModeTool(planModeDeps));

  // ------------------------------------------------------------------
  // MCP tools
  // ------------------------------------------------------------------
  // Load MCP server configs from settings (key: mcpServers)
  const mcpServers = (settings.mcpServers ?? {}) as Record<string, any>;
  let mcpReadyPromise: Promise<void> | undefined;
  if (Object.keys(mcpServers).length > 0) {
    // Ensure MCP tools are ready before loop creation so they appear in the
    // system prompt and initial tool map from the first turn.
    mcpReadyPromise = runtime
      .setMcpServers(mcpServers)
      .then(() => undefined)
      .catch(() => {});
  }

  // ------------------------------------------------------------------
  // Task management tools (TaskCreate / TaskUpdate / TaskGet / TaskList)
  // ------------------------------------------------------------------
  // Use a stable default team name scoped to this session's cwd so tasks
  // persist across --continue invocations.
  const defaultTeamName = 'default';
  const taskManager = new TaskManager(defaultTeamName);

  const taskToolsDeps = {
    createTask: async (params: {
      subject: string;
      description: string;
      activeForm?: string;
      metadata?: Record<string, unknown>;
      priority?: number;
    }) => {
      const item = taskManager.create(
        params.subject,
        params.description,
        params.activeForm,
        params.metadata,
        params.priority,
      );
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
  let activeTeamName: string | null = (settings.activeTeam as string | undefined) ?? null;
  const teamToolsDeps = {
    createTeam: async (name: string, description?: string) => {
      teamManager.createTeam(name, description);
      activeTeamName = name;
      const configPath = join(homedir(), '.open-agent', 'teams', name, 'config.json');
      const scratchpadPath = teamManager.getScratchpadDir(name);
      return { teamName: name, configPath, scratchpadPath };
    },
    deleteTeam: async (name: string) => {
      teamManager.deleteTeam(name);
      if (activeTeamName === name) {
        activeTeamName = null;
      }
      return { success: true };
    },
    getActiveTeam: () => activeTeamName ?? defaultTeamName,
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
      const activeTeam = activeTeamName ?? (settings.activeTeam as string | undefined) ?? defaultTeamName;

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
  // Session management
  // ------------------------------------------------------------------
  const sessionMgr = new SessionManager();
  const pendingNotificationExecutor = new AgentExecutor();
  let sessionId: string;
  let initialMessages: import('@open-agent/providers').Message[] = [];

  if (args.resume) {
    // Resume an explicit session by ID — restore its conversation history.
    // Uses cross-CWD fallback so --resume works even from a different directory.
    sessionId = args.resume;
    const transcriptCwd = sessionMgr.getSession(cwd, sessionId)?.cwd ?? cwd;
    const pendingTaskNotifications = collectPendingTaskNotificationsForSession(
      sessionId,
      sessionMgr.readTranscript(transcriptCwd, sessionId),
      pendingNotificationExecutor.listPersistedAgents(),
    );
    for (const message of pendingTaskNotifications) {
      sessionMgr.appendToTranscript(transcriptCwd, sessionId, message);
    }
    initialMessages = sessionMgr.loadTranscriptAnyCwd(sessionId, transcriptCwd);
  } else if (args.continue) {
    // Continue from the most recent session for this CWD, or create one.
    const latest = sessionMgr.getLatestSession(cwd);
    if (latest) {
      sessionId = latest.id;
      const transcriptCwd = latest.cwd ?? cwd;
      const pendingTaskNotifications = collectPendingTaskNotificationsForSession(
        sessionId,
        sessionMgr.readTranscript(transcriptCwd, sessionId),
        pendingNotificationExecutor.listPersistedAgents(),
      );
      for (const message of pendingTaskNotifications) {
        sessionMgr.appendToTranscript(transcriptCwd, sessionId, message);
      }
      initialMessages = sessionMgr.loadTranscript(transcriptCwd, sessionId);
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
    args.dangerouslySkipPermissions ? 'bypassPermissions' :
    (args.permissionMode as PermissionMode | undefined) ??
    (settings.permissionMode as PermissionMode | undefined) ??
    'default';
  try {
    sessionMgr.updateSession(
      cwd,
      sessionId,
      {
        permissionMode: effectivePermissionMode,
        outputStyle: cliOutputStyle,
      },
      { touch: false },
    );
  } catch {
    // Non-fatal
  }

  const cliPermissionRuntime = createCliPermissionRuntime({
    cwd,
    mode: effectivePermissionMode,
    additionalDirectories,
    permissionPromptToolName: args.permissionPromptTool,
  });
  const permissionEngine = cliPermissionRuntime.permissionEngine;
  const permissionPrompter = wrapCliPermissionPrompter(new TerminalPermissionPrompter());

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
      _hookExecutor.loadFromConfig(config, 'global_hooks_json');
    } catch {
      // Malformed global hooks.json — skip silently.
    }
  }

  const projectHooksPath = join(cwd, '.open-agent', 'hooks.json');
  if (existsSync(projectHooksPath)) {
    try {
      const config = JSON.parse(readFileSync(projectHooksPath, 'utf-8'));
      _hookExecutor.loadFromConfig(config, 'project_hooks_json');
    } catch {
      // Malformed project hooks.json — skip silently.
    }
  }

  // Also load hooks from settings.json (merged across user → project → local layers).
  // settings.hooks shape: { [HookEvent]: HookDefinition[] } — same as loadFromConfig expects.
  if (settings.hooks && typeof settings.hooks === 'object') {
    try {
      _hookExecutor.loadFromConfig(settings.hooks as any, 'settings_json');
    } catch {
      // Malformed hooks in settings — skip silently.
    }
  }

  const buildCliPromptHookSurface = () => _hookExecutor.getHookSurface();

  // Adapter: bridge HookExecutor's strict HookInput signature to the loose
  // Record<string, unknown> interface expected by ConversationLoop.
  // Also intercepts PreToolUse events for file-modifying tools to save
  // checkpoints before any changes are applied.
  const hookExecutor = {
    async execute(event: string, input: Record<string, unknown>, toolUseId?: string) {
      // Auto-checkpoint before file-modifying tools so /rewind can restore.
      if (event === 'PreToolUse' && toolUseId) {
        const toolName = input.tool_name as string;
        if (toolName === 'Write' || toolName === 'Edit' || toolName === 'NotebookEdit') {
          const filePath = (input.tool_input as any)?.file_path ?? (input.tool_input as any)?.notebook_path;
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

  // Wire hookExecutor into the permission engine so the PreToolUseHooks
  // pipeline stage fires real hooks instead of being a no-op.
  // The wrapper's setHookExecutor stores and re-applies across engine rebuilds.
  permissionEngine.setHookExecutor({
    run: (event: string, input: unknown) =>
      hookExecutor.execute(event, input as Record<string, unknown>),
  });

  // Wire the LLM provider for the transcript classifier stage when the
  // TRANSCRIPT_CLASSIFIER feature flag is enabled.
  if (feature('TRANSCRIPT_CLASSIFIER')) {
    permissionEngine.setLLMProvider({
      classify: async (prompt: string): Promise<string> => {
        let result = '';
        const stream = provider.chat(
          [{ role: 'user', content: prompt }],
          { model, systemPrompt: '', maxTokens: 50 },
        );
        for await (const event of stream) {
          if (event.type === 'text_delta') result += (event as any).text ?? '';
        }
        return result;
      },
    });
  }

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
  // Supports both string and string[] formats in settings.json.
  const rawCustomInstructions = settings.customInstructions;
  const customInstructionsList: string[] = Array.isArray(rawCustomInstructions)
    ? rawCustomInstructions.filter((s): s is string => typeof s === 'string')
    : typeof rawCustomInstructions === 'string'
      ? [rawCustomInstructions]
      : [];
  // --system-prompt CLI flag appends to custom instructions
  if (args.systemPrompt) {
    customInstructionsList.push(args.systemPrompt);
  }
  // --append-system-prompt adds extra text after the default system prompt
  if (args.appendSystemPrompt) {
    customInstructionsList.push(args.appendSystemPrompt);
  }

  // Apply --allowedTools / --disallowedTools filtering
  if (args.allowedTools && args.allowedTools.length > 0) {
    const allowed = new Set(args.allowedTools);
    for (const t of toolRegistry.list()) {
      if (!allowed.has(t.name)) toolRegistry.unregister(t.name);
    }
  }
  if (args.disallowedTools && args.disallowedTools.length > 0) {
    for (const name of args.disallowedTools) {
      toolRegistry.unregister(name);
    }
  }

  if (mcpReadyPromise) {
    await mcpReadyPromise;
  }

  const isPrintMode = Boolean(args.print && args.prompt);
  const getAvailableTools = () => (isPrintMode ? [] : toolRegistry.list());
  let toolNames = getAvailableTools().map((tool) => tool.name);
  // Mutable: set by /output-style and picked up by buildCliSystemPrompt on the next turn.
  let activeCliOutputStyle: Pick<OutputStyle, 'name' | 'instructions' | 'keepCodingInstructions'> | undefined = undefined;
  // Forward reference so prompt builders declared before appStore can read
  // briefMode at call time without hitting the TDZ of `const appStore`.
  let cliAppStoreRef: ReturnType<typeof createStore<AppState>> | undefined;
  const isGitRepo = isGitRepository(cwd);
  const loadCurrentPromptContext = () => loadPromptContext({
    cwd,
    includeGit: isGitRepo,
    includeMemory: true,
    includeAgentInstructions: true,
    additionalDirectories,
  });
  const buildCliSystemPrompt = (): string => {
    const promptContext = loadCurrentPromptContext();
    const currentTools = getAvailableTools();
    const currentToolNames = currentTools.map((tool) => tool.name);
    const runtimeSnapshot = runtime.buildSnapshot();
    const promptCapabilitySnapshot = filterCapabilitySnapshot(runtimeSnapshot.capabilitySnapshot, currentToolNames);
    const configuredActiveTeam = activeTeamName ?? (settings.activeTeam as string | undefined) ?? defaultTeamName;
    const coordinatorScratchpadDir = teamManager.getTeam(configuredActiveTeam)
      ? teamManager.getScratchpadDir(configuredActiveTeam)
      : join(cwd, '.open-agent', 'scratchpad');

    return buildSystemPrompt({
      cwd,
      model,
      tools: currentToolNames,
      permissionMode: permissionEngine.getSummary().mode as PermissionMode,
      agentInstructions: [
        ...promptContext.agentInstructions,
        ...customInstructionsList,
      ],
      memoryContent: promptContext.memoryContent,
      memoryDir: promptContext.memoryDir,
      isGitRepo,
      gitContext: promptContext.gitContext,
      contextSections: promptContext.sections,
      toolDescriptions: getToolPromptDescriptions(),
      runtimeSnapshot: buildSystemPromptRuntimeSnapshot({
        runtime: runtimeSnapshot,
        tools: currentToolNames,
        activeTeam: teamManager.getTeam(configuredActiveTeam) ? configuredActiveTeam : undefined,
        scratchpadDir: coordinatorScratchpadDir,
        hookSurface: buildCliPromptHookSurface(),
        capabilitySnapshot: promptCapabilitySnapshot,
      }),
      outputStyle: cliOutputStyle,
      activeOutputStyle: activeCliOutputStyle,
      briefMode: (cliAppStoreRef?.getState().briefMode === true) || false,
      knowledgeCutoff: 'August 2025',
    });
  };

  /** Return the structured blocks for the CLI system prompt (same options as buildCliSystemPrompt). */
  const buildCliSystemPromptBlocks = (): import('@open-agent/core').SystemPromptBlock[] => {
    const promptContext = loadCurrentPromptContext();
    const currentTools = getAvailableTools();
    const currentToolNames = currentTools.map((tool) => tool.name);
    const runtimeSnapshot = runtime.buildSnapshot();
    const promptCapabilitySnapshot = filterCapabilitySnapshot(runtimeSnapshot.capabilitySnapshot, currentToolNames);
    const configuredActiveTeam = activeTeamName ?? (settings.activeTeam as string | undefined) ?? defaultTeamName;
    const coordinatorScratchpadDir = teamManager.getTeam(configuredActiveTeam)
      ? teamManager.getScratchpadDir(configuredActiveTeam)
      : join(cwd, '.open-agent', 'scratchpad');

    return buildSystemPromptBlocks({
      cwd,
      model,
      tools: currentToolNames,
      permissionMode: permissionEngine.getSummary().mode as PermissionMode,
      agentInstructions: [
        ...promptContext.agentInstructions,
        ...customInstructionsList,
      ],
      memoryContent: promptContext.memoryContent,
      memoryDir: promptContext.memoryDir,
      isGitRepo,
      gitContext: promptContext.gitContext,
      contextSections: promptContext.sections,
      toolDescriptions: getToolPromptDescriptions(),
      runtimeSnapshot: buildSystemPromptRuntimeSnapshot({
        runtime: runtimeSnapshot,
        tools: currentToolNames,
        activeTeam: teamManager.getTeam(configuredActiveTeam) ? configuredActiveTeam : undefined,
        scratchpadDir: coordinatorScratchpadDir,
        hookSurface: buildCliPromptHookSurface(),
        capabilitySnapshot: promptCapabilitySnapshot,
      }),
      outputStyle: cliOutputStyle,
      activeOutputStyle: activeCliOutputStyle,
      briefMode: (cliAppStoreRef?.getState().briefMode === true) || false,
      knowledgeCutoff: 'August 2025',
    });
  };

  // ------------------------------------------------------------------
  // Conversation loop
  // ------------------------------------------------------------------
  const appStore = createStore<AppState>(createDefaultAppState({
    sessionId,
    cwd,
    model,
    permissionMode: effectivePermissionMode,
    tools: new Map(getAvailableTools().map((t) => [t.name, t])),
    thinkingConfig: effectiveThinking,
    verbose: args.verbose ?? false,
  }));
  cliAppStoreRef = appStore;

  const loop = new ConversationLoop({
    provider,
    // Pass the full tool map; ConversationLoop expects Map<name, ToolDefinition>.
    tools: new Map(getAvailableTools().map((t) => [t.name, t])),
    model,
    systemPrompt: buildCliSystemPrompt(),
    systemPromptBlocks: buildCliSystemPromptBlocks(),
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
    getAppState: () => appStore.getState(),
    setAppState: (updater) => appStore.setState(updater),
  });

  // Activate proactive autocompact so the snip + microcompact pipeline fires
  // before each turn when token thresholds are hit, not just reactively.
  loop.setAutoCompactPolicy('proactive');

  // Wire a real LLM-backed summarizer so the llmAutocompact tier actually
  // calls the provider instead of falling back to the noop placeholder.
  loop.setMessageSummarizer(createLLMSummarizer(provider, model));

  // Expose loop for plan mode tool access
  (globalThis as any).__openAgentLoop = loop;

  const syncCliLoopTools = (availableTools: import('@open-agent/tools').ToolDefinition[]): void => {
    const allTools = new Map(availableTools.map((tool) => [tool.name, tool]));
    toolNames = [...allTools.keys()];
    if (_planMode) {
      const readOnlyMap = new Map<string, import('@open-agent/tools').ToolDefinition>();
      for (const [name, tool] of allTools) {
        const isReadOnly = typeof tool.isReadOnly === 'function'
          ? tool.isReadOnly({})
          : tool.isReadOnly === true;
        if (isReadOnly || READ_ONLY_TOOLS.has(name) || name.startsWith('mcp__')) {
          readOnlyMap.set(name, tool);
        }
      }
      loop.setTools(readOnlyMap);
    } else {
      loop.setTools(allTools);
    }
  };

  const refreshCliRuntimeTurnBoundary = () => refreshCliRuntimeSurface({
      runtime,
      toolRegistry,
      loop,
      appStore,
      buildSystemPrompt: buildCliSystemPrompt,
      buildSystemPromptBlocks: buildCliSystemPromptBlocks,
      syncLoopTools: syncCliLoopTools,
      isPrintMode,
    });

  const applyCliSettingsState = (nextSettings: Settings | Record<string, unknown> | null | undefined) => {
    settings = (nextSettings ?? {}) as Settings;
    try {
      const nextHooks = nextSettings && typeof nextSettings === 'object' && nextSettings.hooks && typeof nextSettings.hooks === 'object'
        ? nextSettings.hooks as any
        : {};
      _hookExecutor.replaceShellHooksFromConfig(nextHooks, 'settings_json');
    } catch {
      _hookExecutor.replaceShellHooksFromConfig({}, 'settings_json');
    }
  };

  const settingsWatcher = cliPermissionRuntime.watchSettings(['user', 'project', 'local'], {
    onRefresh(nextSettings, source) {
      void (async () => {
        await applyCliRuntimeSettingsRefresh({
          runtime,
          toolRegistry,
          loop,
          appStore,
          buildSystemPrompt: buildCliSystemPrompt,
          buildSystemPromptBlocks: buildCliSystemPromptBlocks,
          syncLoopTools: syncCliLoopTools,
          isPrintMode: false,
          applySettingsState: applyCliSettingsState,
        }, nextSettings);

        await hookExecutor.execute('ConfigChange', {
          hook_event_name: 'ConfigChange',
          session_id: sessionId,
          transcript_path: join(sessionMgr.getSessionDir(cwd, sessionId), `${sessionId}.jsonl`),
          cwd,
          permission_mode: permissionEngine.getSummary().mode,
          source,
        });
      })().catch(() => {
        // Settings refresh is best-effort.
      });
    },
  });
  let settingsWatcherClosed = false;
  const closeSettingsWatcher = () => {
    if (settingsWatcherClosed) return;
    settingsWatcherClosed = true;
    settingsWatcher.close();
  };
  process.once('exit', closeSettingsWatcher);
  process.once('SIGINT', closeSettingsWatcher);
  process.once('SIGTERM', closeSettingsWatcher);

  const renderer = new TerminalRenderer({ noMarkdown: args.noMarkdown });
  const isStreamJson = args.outputFormat === 'stream-json' || args.json === true;

  // ------------------------------------------------------------------
  // Input format: stream-json reads prompt from stdin as NDJSON
  // ------------------------------------------------------------------
  if (args.inputFormat === 'stream-json' && !args.prompt) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    const stdinText = Buffer.concat(chunks).toString('utf-8').trim();
    if (stdinText) {
      // Parse NDJSON lines — extract user messages to build the prompt
      const lines = stdinText.split('\n').filter(l => l.trim());
      const promptParts: string[] = [];
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.type === 'user' && parsed.message?.content) {
            const content = parsed.message.content;
            promptParts.push(typeof content === 'string' ? content : JSON.stringify(content));
          } else if (typeof parsed.content === 'string') {
            promptParts.push(parsed.content);
          }
        } catch { /* skip malformed lines */ }
      }
      if (promptParts.length > 0) {
        args.prompt = promptParts.join('\n');
      }
    }
  }

  // ------------------------------------------------------------------
  // Print mode  (open-agent --print "…")
  // Sends the prompt to the LLM with NO tools and prints the raw text
  // output.  Useful for scripting and piping.
  // ------------------------------------------------------------------
  if (args.print && args.prompt) {
    // Print mode: one-shot with full tools, streams only text to stdout.
    // Matches Claude Code's `-p` behavior — runs agent loop then exits.
    const refreshed = await refreshCliRuntimeTurnBoundary();
    if (isStreamJson) {
      emitStreamJsonInit({
        tools: refreshed.toolNames,
        capabilitySnapshot: refreshed.runtimeSnapshot.capabilitySnapshot,
        model,
        cwd,
        permissionMode: permissionEngine.getSummary().mode as PermissionMode,
        sessionId,
      });
    }
    for await (const message of loop.run(args.prompt)) {
      if (isStreamJson) {
        emitStreamJson(message);
      } else if (message.type === 'stream_event') {
        const evt = (message as any).event;
        if (evt?.type === 'text_delta') {
          process.stdout.write(evt.text);
        }
      } else if (message.type === 'result' && (message as any).result) {
        // Final text only if we haven't been streaming deltas
      }
      // Persist transcript so --resume can restore this session.
      sessionMgr.appendToTranscript(cwd, sessionId, message);
    }
    if (!isStreamJson) process.stdout.write('\n');
    sessionMgr.touchSession(cwd, sessionId);
    process.exit(0);
  }

  // ------------------------------------------------------------------
  // Single-prompt mode  (open-agent -p "…" or open-agent "…")
  // ------------------------------------------------------------------
  if (args.prompt) {
    const refreshed = await refreshCliRuntimeTurnBoundary();
    if (isStreamJson) {
      emitStreamJsonInit({
        tools: refreshed.toolNames,
        capabilitySnapshot: refreshed.runtimeSnapshot.capabilitySnapshot,
        model,
        cwd,
        permissionMode: permissionEngine.getSummary().mode as PermissionMode,
        sessionId,
      });
    }
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

  if (isStreamJson) {
    console.error('stream-json output mode requires a prompt (--prompt) or stdin with --input-format stream-json.');
    process.exit(1);
  }

  // ------------------------------------------------------------------
  // Interactive REPL mode
  // ------------------------------------------------------------------

  // Experimental Ink UI mode (--ink flag)
  if (args.ink) {
    const waitUntilExit = renderApp({
      store: appStore,
      loop,
      model,
      cwd,
    });
    await waitUntilExit();
    process.exit(0);
  }

  renderer.renderWelcome(model, cwd);
  const repl = new REPL(model);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    let input = await repl.getInput();

    if (input === null) {
      // EOF — user pressed Ctrl+D
      console.log('\nGoodbye!');
      break;
    }

    if (input === '') continue;

    await refreshCliRuntimeTurnBoundary();

    if (input.startsWith('/')) {
      const result = await handleSlashCommand(input, {
        loop,
        cwd,
        model,
        sessionId,
        tools: toolNames,
        capabilities: runtime.buildSnapshot().capabilitySnapshot,
        checkpoint,
        sessionMgr,
        permissionMode: effectivePermissionMode,
        thinking: effectiveThinking.type,
        effort: effectiveEffort,
        agentTypes: agentLoader.list().map(([name, def]) => ({
          name,
          description: def.description,
        })),
        skills: runtime.listSkills().map((skill) => ({
          name: skill.name,
          description: skill.description,
          source: skill.source,
        })),
        mcpStatus: runtime.listMcpServerStatus().map((s: any) => ({
          name: s.name,
          status: s.status,
        })),
        permissionEngine,
        listBackgroundAgents: () =>
          agentExecutor.listPersistedAgents().map((session) => ({
            task_id: session.agentId,
            info: {
              status: session.state === 'running'
                ? 'running'
                : session.state === 'completed'
                  ? 'completed'
                  : session.state === 'shutdown'
                    ? 'stopped'
                    : 'failed',
              output_file: session.outputFile ?? '',
              result: session.result,
              summary: summarizePlainText(session.result ?? session.error),
              team_name: session.teamName,
              description: session.name ?? session.agentType,
              usage: {
                total_tokens: session.totalTokens ?? 0,
                tool_uses: session.totalToolUseCount ?? 0,
                duration_ms: session.durationMs,
              },
            },
          })),
        getBackgroundAgent: agentManagementDeps.getBackgroundAgent,
        stopBackgroundAgent: agentManagementDeps.stopBackgroundAgent,
        setOutputStyleName: (name: string) => {
          // Resolve the style object and persist it in the REPL-scoped mutable.
          // The resolution is fire-and-forget; buildCliSystemPrompt picks it up
          // on the next turn boundary via refreshCliRuntimeTurnBoundary.
          loadOutputStyles(cwd).then((loaded) => {
            const all = mergeOutputStyles(loaded, BUILTIN_OUTPUT_STYLES);
            activeCliOutputStyle = findOutputStyle(name, all);
          }).catch(() => {
            // Fall back to builtin only — still functional.
            const all = mergeOutputStyles([], BUILTIN_OUTPUT_STYLES);
            activeCliOutputStyle = findOutputStyle(name, all);
          });
        },
      });
      if (result) {
        if (result.shouldExit) break;
        if (result.shouldClear) { console.clear(); continue; }
        if (result.shouldResume && Array.isArray(result.resumeTranscript)) {
          // Hydrate the live ConversationLoop with the restored transcript so
          // the user genuinely resumes where the session left off.  The Message
          // cast is safe: resumeTranscript is produced by SessionManager which
          // returns the same shape that ConversationLoop originally persisted.
          loop.setMessages(result.resumeTranscript as import('@open-agent/providers').Message[]);
          // Propagate the restored session identity into the loop so that all
          // subsequent hooks, stream events, and tool-execution records use the
          // resumed session ID rather than the original startup session ID.
          if (typeof loop.setSessionId === 'function') {
            loop.setSessionId(result.shouldResume);
          }
          sessionId = result.shouldResume;
          console.log(`\nSession ${result.shouldResume.slice(0, 8)} loaded with ${result.resumeTranscript.length} messages. Continue typing to resume.\n`);
          continue;
        }
        if (!result.handled && result.output) {
          // Command wants to delegate to the agent loop (e.g. /commit, /review).
          // Use the output as the prompt instead of the raw slash command.
          input = result.output;
        } else {
          if (result.output) console.log(result.output);
          continue;
        }
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
  try {
    const current = sessionMgr.getSession(cwd, sessionId);
    if (!current?.createdFromPrompt) {
      sessionMgr.updateSession(
        cwd,
        sessionId,
        buildPromptSessionMetadata(prompt),
        { touch: false },
      );
    }
  } catch {
    // Non-fatal
  }
  if (!isStreamJson) {
    renderer.startSpinner('Thinking');
  }
  for await (const message of loop.run(prompt)) {
    if (isStreamJson) {
      emitStreamJson(message);
    } else {
      renderMessage(renderer, message);
    }
    // Persist every message to the on-disk transcript.
    sessionMgr.appendToTranscript(cwd, sessionId, message);
  }
  if (!isStreamJson) {
    renderer.stopSpinner();
  }
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
        (message as any)._fullResult ?? (message as any).result,
        (message as any).is_error,
      );
      break;
    case 'result':
      renderer.renderResult(message as Record<string, any>);
      break;
    case 'prompt_suggestion':
      renderer.renderPromptSuggestion((message as any).suggestion, (message as any).scaffold);
      break;
    case 'tool_use_summary':
      renderer.renderToolUseSummary((message as any).summary);
      break;
    case 'system':
      // Per-turn cost/token summary emitted by the conversation loop.
      if ((message as any).turn_cost !== undefined) {
        const tc = message as any;
        renderer.renderTurnCost(tc.turn_input_tokens, tc.turn_output_tokens, tc.cumulative_cost);
      } else if ((message as any).subtype === 'compact_boundary') {
        renderer.renderCompactBoundary(
          (message as any).compact_metadata?.pre_tokens ?? 0,
          (message as any).compact_metadata?.trigger ?? 'auto',
        );
      } else if ((message as any).subtype === 'task_started') {
        renderer.renderTaskStarted((message as any).description, (message as any).task_id);
      } else if ((message as any).subtype === 'task_progress') {
        renderer.renderTaskProgress((message as any).description, (message as any).usage, (message as any).last_tool_name);
      } else if ((message as any).subtype === 'task_notification') {
        renderer.renderTaskNotification(
          (message as any).status,
          (message as any).summary,
          (message as any).usage,
        );
      }
      break;
    // 'user', 'assistant' messages are informational only; no
    // terminal output is needed for them in the default renderer.
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function buildTaskNotificationFingerprint(input: {
  task_id?: unknown;
  status?: unknown;
  completed_at?: unknown;
}): string | null {
  if (typeof input.task_id !== 'string' || typeof input.status !== 'string') {
    return null;
  }
  const completedAt = typeof input.completed_at === 'string' ? input.completed_at : '';
  return `${input.task_id}::${input.status}::${completedAt}`;
}

function mapAgentStateToTaskStatus(
  state: AgentSession['state'],
): SDKTaskNotificationMessage['status'] | null {
  if (state === 'completed') return 'completed';
  if (state === 'failed') return 'failed';
  if (state === 'shutdown') return 'stopped';
  return null;
}

function collectPendingTaskNotificationsForSession(
  sessionId: string,
  transcriptEntries: unknown[],
  childSessions: AgentSession[],
): SDKTaskNotificationMessage[] {
  const seen = new Set<string>();

  for (const entry of transcriptEntries) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    if (record.type !== 'system' || record.subtype !== 'task_notification') continue;
    const fingerprint = buildTaskNotificationFingerprint(record);
    if (fingerprint) {
      seen.add(fingerprint);
    }
  }

  return childSessions
    .filter((session) => session.parentSessionId === sessionId)
    .filter((session) => mapAgentStateToTaskStatus(session.state) !== null)
    .filter((session) => typeof session.completedAt === 'string' && session.completedAt.length > 0)
    .sort((left, right) => new Date(left.completedAt ?? 0).getTime() - new Date(right.completedAt ?? 0).getTime())
    .filter((session) => {
      const fingerprint = buildTaskNotificationFingerprint({
        task_id: session.agentId,
        status: mapAgentStateToTaskStatus(session.state),
        completed_at: session.completedAt,
      });
      return fingerprint ? !seen.has(fingerprint) : false;
    })
    .map((session) => {
      const status = mapAgentStateToTaskStatus(session.state)!;
      return {
        type: 'system' as const,
        subtype: 'task_notification' as const,
        task_id: session.agentId,
        status,
        ...(session.teamName ? { team_name: session.teamName } : {}),
        completed_at: session.completedAt,
        output_file: session.outputFile ?? '',
        summary: summarizePlainText(session.result ?? session.error),
        ...(session.result ?? session.error ? { result: session.result ?? session.error } : {}),
        ...(session.name ?? session.agentType ? { description: session.name ?? session.agentType } : {}),
        orchestration_templates: buildTaskOrchestrationTemplates({
          taskId: session.agentId,
          status,
          description: session.name ?? session.agentType,
          summary: summarizePlainText(session.result ?? session.error),
          result: session.result ?? session.error,
        }),
        ...(session.totalTokens !== undefined || session.totalToolUseCount !== undefined || session.durationMs !== undefined
          ? {
              usage: {
                total_tokens: session.totalTokens ?? 0,
                tool_uses: session.totalToolUseCount ?? 0,
                duration_ms: session.durationMs ?? 0,
              },
            }
          : {}),
        uuid: randomUUID(),
        session_id: sessionId,
      };
    });
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function truncateText(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function summarizePlainText(text?: string): string {
  const normalized = normalizeOptionalString(text);
  if (!normalized) return 'No summary available.';
  return truncateText(normalized.replace(/\s+/g, ' '), 200);
}

function buildPromptSessionMetadata(
  prompt: string,
): { title?: string; summary?: string; createdFromPrompt?: string } {
  const normalized = normalizeOptionalString(prompt);
  if (!normalized) return {};
  return {
    title: truncateText(normalized.split('\n')[0].replace(/\s+/g, ' '), 80),
    summary: truncateText(normalized.replace(/\s+/g, ' '), 200),
    createdFromPrompt: truncateText(normalized, 4000),
  };
}

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
      --add-dir <path>        Additional working directory (can be repeated)
      --permission-prompt-tool <name>  MCP tool for permission decisions
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
