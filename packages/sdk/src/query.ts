import { randomUUID } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type {
  SDKMessage,
  SDKUserMessage,
  SlashCommand,
  AccountInfo,
  McpServerStatusConfig,
  AgentDefinition,
} from '@open-agent/core';
import { ConversationLoop, SessionManager, buildSystemPrompt, ConfigLoader, AutoMemory, FileCheckpoint } from '@open-agent/core';
import { AgentLoader } from '@open-agent/agents';
import { createDefaultToolRegistry } from '@open-agent/tools';
import { autoDetectProvider, createProvider, calculateCost } from '@open-agent/providers';
import type { Message } from '@open-agent/providers';
import { PermissionEngine, SettingsLoader } from '@open-agent/permissions';
import type { SandboxConfig, SettingsFile } from '@open-agent/permissions';
import { HookExecutor } from '@open-agent/hooks';
import { McpManager } from '@open-agent/mcp';
import type { QueryOptions, Query, RewindFilesResult, AgentInfo } from './types.js';
import { applyPermissionUpdates } from './permission-updates.js';
import { createPermissionPrompterBridge } from './permission-prompter.js';

// --------------------------------------------------------------------------
// query() – V1 streaming API
//
// Supports two call signatures:
//
//   1. query(prompt, options?)        — Claude Code style (primary)
//   2. query({ prompt, options })     — legacy object style (backwards-compat)
// --------------------------------------------------------------------------

/**
 * Run an agent conversation and return a `Query` handle that is both an
 * `AsyncGenerator<SDKMessage>` and exposes control methods.
 *
 * @example — simple string prompt (Claude Code style)
 * ```ts
 * const q = query('List files in the current directory');
 * for await (const msg of q) {
 *   if (msg.type === 'result') console.log(msg.result);
 * }
 * ```
 *
 * @example — with options
 * ```ts
 * const q = query('Refactor this file', { model: 'claude-opus-4-6', cwd: '/my/project' });
 * for await (const msg of q) { ... }
 * ```
 */
export function query(prompt: string, options?: QueryOptions): Query;
export function query(params: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: QueryOptions;
}): Query;
export function query(
  promptOrParams: string | { prompt: string | AsyncIterable<SDKUserMessage>; options?: QueryOptions },
  maybeOptions?: QueryOptions,
): Query {
  // Normalise the two call signatures into a single shape.
  let prompt: string | AsyncIterable<SDKUserMessage>;
  let options: QueryOptions;

  if (typeof promptOrParams === 'string') {
    prompt = promptOrParams;
    options = maybeOptions ?? {};
  } else {
    prompt = promptOrParams.prompt;
    options = promptOrParams.options ?? {};
  }

  const cwd = options.cwd ?? process.cwd();
  assertUnsupportedOptions(options);
  if (options.resume && options.continue) {
    throw new Error('options.resume and options.continue are mutually exclusive.');
  }
  if (options.sessionId !== undefined && !isValidUuid(options.sessionId)) {
    throw new Error('options.sessionId must be a valid UUID.');
  }
  if (options.resume !== undefined && !isValidUuid(options.resume)) {
    throw new Error('options.resume must be a valid UUID.');
  }
  if (options.maxTurns !== undefined && (!Number.isInteger(options.maxTurns) || options.maxTurns <= 0)) {
    throw new Error('options.maxTurns must be a positive integer.');
  }
  if (
    options.maxBudgetUsd !== undefined &&
    (!Number.isFinite(options.maxBudgetUsd) || options.maxBudgetUsd < 0)
  ) {
    throw new Error('options.maxBudgetUsd must be a finite number >= 0.');
  }
  if (options.resumeSessionAt !== undefined && options.resume === undefined) {
    throw new Error('options.resumeSessionAt requires options.resume.');
  }
  if (
    options.sessionId &&
    !options.forkSession &&
    (options.resume !== undefined || options.continue === true)
  ) {
    throw new Error('options.sessionId cannot be combined with options.resume/options.continue unless forkSession=true.');
  }
  const resumeManager = new SessionManager();
  const effectiveResumeSessionId =
    options.resume ??
    (options.continue ? resumeManager.getLatestSession(cwd)?.id : undefined);
  if (options.resume && !resumeManager.getSession(cwd, options.resume)) {
    throw new Error(`Session not found for resume: ${options.resume}`);
  }
  const sessionId = options.forkSession
    ? randomUUID()
    : (options.sessionId ?? effectiveResumeSessionId ?? randomUUID());
  const settingSources = options.settingSources ?? [];
  const loadedSettings: SettingsFile | null = settingSources.length > 0
    ? new SettingsLoader().load(cwd, settingSources)
    : null;
  const shouldPersist = options.persistSession !== false;
  const availableAgents = loadAvailableAgents(cwd, options.agents);
  const selectedAgent = resolveSelectedAgent(options.agent, availableAgents);
  const supportedAgentInfos = buildAgentInfoList(availableAgents);
  const selectedAgentModel = resolveAgentModel(selectedAgent?.model);
  const requestedModelHint = options.model ?? selectedAgentModel;

  // Queue for best-effort streamInput support in async-iterable prompt mode.
  const queuedInputs: SDKUserMessage[] = [];
  const STREAM_DONE = Symbol('stream-done');
  let queueNotifier: (() => void) | null = null;
  let streamClosed = false;
  let sourcePumpStarted = false;

  function notifyQueue(): void {
    if (queueNotifier) {
      const notify = queueNotifier;
      queueNotifier = null;
      notify();
    }
  }

  function pushQueuedInput(msg: SDKUserMessage): void {
    if (streamClosed) return;
    queuedInputs.push(msg);
    notifyQueue();
  }

  async function readQueuedInput(): Promise<SDKUserMessage | typeof STREAM_DONE> {
    while (!streamClosed && queuedInputs.length === 0) {
      await new Promise<void>((resolve) => {
        queueNotifier = resolve;
      });
    }
    if (queuedInputs.length > 0) {
      return queuedInputs.shift()!;
    }
    return STREAM_DONE;
  }

  function startSourcePromptPumpIfNeeded(): void {
    if (typeof prompt === 'string' || sourcePumpStarted) return;
    sourcePumpStarted = true;
    const source = prompt;
    void (async () => {
      try {
        for await (const msg of source) {
          pushQueuedInput(msg);
        }
      } finally {
        streamClosed = true;
        notifyQueue();
      }
    })();
  }

  // ------------------------------------------------------------------
  // Env — apply caller-supplied environment overrides BEFORE provider
  // resolution so that OPENAI_API_KEY, ANTHROPIC_API_KEY etc. are
  // visible to autoDetectProvider() / createProvider().
  // ------------------------------------------------------------------
  const savedEnv: Record<string, string | undefined> = {};
  if (options.env) {
    for (const [key, value] of Object.entries(options.env)) {
      savedEnv[key] = process.env[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }

  // Apply debug env before provider creation too.
  // Append rather than replace so the user's existing DEBUG patterns are preserved.
  if (options.debug) {
    savedEnv['DEBUG'] ??= process.env['DEBUG'];
    const existing = process.env['DEBUG'];
    process.env['DEBUG'] = existing ? `${existing},open-agent:*` : 'open-agent:*';
  }

  // Helper to restore env vars if setup throws before the generator's finally block runs.
  let envRestored = false;
  function restoreEnv(): void {
    if (envRestored) return;
    envRestored = true;
    for (const [key, original] of Object.entries(savedEnv)) {
      if (original === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original;
      }
    }
  }

  // ------------------------------------------------------------------
  // Provider resolution
  // ------------------------------------------------------------------
  // If the caller explicitly specifies a provider, use it directly.
  // Otherwise fall back to model-name heuristics → environment auto-detect.
  let provider: ReturnType<typeof createProvider>;
  try {
    provider = options.provider
      ? createProvider({ provider: options.provider, apiKey: options.apiKey, baseURL: options.baseUrl })
      : (() => {
          const providerName = guessProviderFromModel(requestedModelHint);
          return providerName
            ? createProvider({ provider: providerName, apiKey: options.apiKey, baseURL: options.baseUrl })
            : autoDetectProvider();
        })();
  } catch (err) {
    restoreEnv();
    throw err;
  }

  const apiKeySource: string = options.apiKey
    ? 'direct'
    : (options.env && Object.keys(options.env).some(k => k.includes('API_KEY')))
      ? 'env_override'
      : (process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY)
        ? 'env'
        : 'auto';

  // ------------------------------------------------------------------
  // Tool registry — use public unregister() API, never touch internals.
  // ------------------------------------------------------------------
  const toolRegistry = createDefaultToolRegistry(cwd);

  // Apply selected agent tool policy first, then caller-level tool policies.
  if (selectedAgent?.tools && selectedAgent.tools.length > 0) {
    const allowed = new Set(selectedAgent.tools);
    for (const tool of toolRegistry.list()) {
      if (!allowed.has(tool.name)) {
        toolRegistry.unregister(tool.name);
      }
    }
  }

  if (selectedAgent?.disallowedTools) {
    for (const name of selectedAgent.disallowedTools) {
      toolRegistry.unregister(name);
    }
  }

  // Apply `tools` baseline first (official semantics): explicit list limits the
  // available set before allowedTools/disallowedTools are layered on top.
  if (options.tools) {
    if (Array.isArray(options.tools)) {
      const baseline = new Set(options.tools);
      for (const tool of toolRegistry.list()) {
        if (!baseline.has(tool.name)) {
          toolRegistry.unregister(tool.name);
        }
      }
    } else if (options.tools.type !== 'preset' || options.tools.preset !== 'claude_code') {
      throw new Error('Unsupported tools preset.');
    }
  }

  // Apply allowedTools: discard everything not in the list.
  if (Array.isArray(options.allowedTools) && options.allowedTools.length > 0) {
    const allowed = new Set(options.allowedTools);
    for (const tool of toolRegistry.list()) {
      if (!allowed.has(tool.name)) {
        toolRegistry.unregister(tool.name);
      }
    }
  }

  // Apply disallowedTools: remove each named tool.
  if (options.disallowedTools) {
    // Validate: warn if a tool appears in both lists (programming error).
    if (options.allowedTools) {
      const allowedSet = new Set(options.allowedTools);
      for (const name of options.disallowedTools) {
        if (allowedSet.has(name)) {
          console.warn(
            `[open-agent/sdk] Tool "${name}" is in both allowedTools and disallowedTools — it will be removed.`,
          );
        }
      }
    }
    for (const name of options.disallowedTools) {
      toolRegistry.unregister(name);
    }
  }
  const isToolAllowedByPolicy = (toolName: string) =>
    __internal_isToolAllowedByPolicies(toolName, {
      agentAllowedTools: selectedAgent?.tools,
      agentDisallowedTools: selectedAgent?.disallowedTools,
      toolsBaseline: Array.isArray(options.tools) ? options.tools : undefined,
      allowedTools: options.allowedTools,
      disallowedTools: options.disallowedTools,
    });

  // Base non-MCP tool set after all static filtering. Used to restore any
  // built-in tool shadowed by an MCP tool when that MCP tool disappears.
  const baseTools = new Map(toolRegistry.list().map((t) => [t.name, t]));
  const registeredMcpToolNames = new Set<string>();

  // ------------------------------------------------------------------
  // Hooks — wire from QueryOptions
  // ------------------------------------------------------------------
  let hookExecutor: InstanceType<typeof HookExecutor> | undefined;
  if (options.hooks) {
    hookExecutor = new HookExecutor();
    hookExecutor.loadFromConfig(options.hooks);
  }
  // Adapt HookExecutor to LoopHookExecutor interface (loose → strict input type).
  const loopHookExecutor = hookExecutor
    ? { execute: (event: string, input: Record<string, unknown>, toolUseId?: string) => hookExecutor!.execute(event as any, input as any, toolUseId) }
    : undefined;

  // ------------------------------------------------------------------
  // File checkpointing — record file state before modifications
  // ------------------------------------------------------------------
  let fileCheckpoint: InstanceType<typeof FileCheckpoint> | undefined;
  if (options.enableFileCheckpointing) {
    const sessionMgr = new SessionManager();
    const sessionDir = sessionMgr.getSessionDir(cwd, sessionId);
    fileCheckpoint = new FileCheckpoint(sessionDir);
  }

  // Wrap hook executor to intercept PreToolUse for checkpointing
  const effectiveHookExecutor = fileCheckpoint
    ? {
        execute: async (event: string, input: Record<string, unknown>, toolUseId?: string) => {
          if (event === 'PreToolUse' && toolUseId) {
            const toolName = input.tool_name as string;
            if (toolName === 'Write' || toolName === 'Edit' || toolName === 'NotebookEdit') {
              const filePath = (input.tool_input as any)?.file_path ?? (input.tool_input as any)?.notebook_path;
              if (filePath) {
                try { fileCheckpoint!.save(toolUseId, filePath); } catch { /* ignore */ }
              }
            }
          }
          return loopHookExecutor ? loopHookExecutor.execute(event, input, toolUseId) : {};
        },
      }
    : loopHookExecutor;

  // ------------------------------------------------------------------
  // MCP servers — connect and discover tools
  // ------------------------------------------------------------------
  let mcpManager: McpManager | undefined;
  const syncMcpToolsIntoRegistry = () => {
    if (!mcpManager) return;
    const nextMcpTools = mcpManager.getAllTools();
    const discoveredMcpNames = new Set(nextMcpTools.map((tool) => tool.name));
    const nextRegisteredMcpNames = new Set<string>();

    for (const staleName of registeredMcpToolNames) {
      if (discoveredMcpNames.has(staleName) && isToolAllowedByPolicy(staleName)) continue;
      const baseTool = baseTools.get(staleName);
      if (baseTool) {
        toolRegistry.register(baseTool);
      } else {
        toolRegistry.unregister(staleName);
      }
    }

    for (const mcpTool of nextMcpTools) {
      if (!isToolAllowedByPolicy(mcpTool.name)) {
        const baseTool = baseTools.get(mcpTool.name);
        if (baseTool) {
          toolRegistry.register(baseTool);
        } else {
          toolRegistry.unregister(mcpTool.name);
        }
        continue;
      }
      toolRegistry.register({
        name: mcpTool.name,
        description: mcpTool.description ?? '',
        inputSchema: mcpTool.inputSchema,
        execute: (input: Record<string, unknown>) =>
          mcpManager!.callTool(mcpTool.serverName, mcpTool.name, input),
      });
      nextRegisteredMcpNames.add(mcpTool.name);
    }

    registeredMcpToolNames.clear();
    for (const name of nextRegisteredMcpNames) {
      registeredMcpToolNames.add(name);
    }
  };
  // Stored as a promise so the async work completes inside the generator
  // without blocking the synchronous query() call.
  let mcpReadyPromise: Promise<void> | undefined;
  const trackMcpSetup = <T>(operation: Promise<T>): Promise<T> => {
    const setup = operation.then((result) => {
      syncMcpToolsIntoRegistry();
      return result;
    });
    mcpReadyPromise = setup.then(() => undefined);
    // Prevent unhandled-rejection warnings when callers don't await setup.
    void mcpReadyPromise.catch(() => {});
    return setup;
  };
  if (options.mcpServers && Object.keys(options.mcpServers).length > 0) {
    mcpManager = new McpManager();
    trackMcpSetup(mcpManager.setServers(options.mcpServers));
  }

  // (env and debug overrides already applied above, before provider resolution)

  // ------------------------------------------------------------------
  // Model resolution
  // ------------------------------------------------------------------
  const model =
    requestedModelHint ??
    (provider.name === 'anthropic' ? 'claude-sonnet-4-6' : 'gpt-4o');
  const sessionMgr = shouldPersist ? new SessionManager() : null;
  if (sessionMgr) {
    try {
      sessionMgr.ensureSession(cwd, sessionId, model);
    } catch {
      // Non-fatal: keep query usable even if session metadata init fails.
    }
  }

  // ------------------------------------------------------------------
  // Permission engine — wire from QueryOptions
  // ------------------------------------------------------------------
  const requestedPermissionMode = options.permissionMode ?? selectedAgent?.mode ?? 'default';
  if (
    requestedPermissionMode === 'bypassPermissions' &&
    options.allowDangerouslySkipPermissions !== true
  ) {
    throw new Error(
      'permissionMode="bypassPermissions" requires allowDangerouslySkipPermissions=true',
    );
  }
  if (
    options.allowDangerouslySkipPermissions === true &&
    requestedPermissionMode !== 'bypassPermissions'
  ) {
    throw new Error(
      'allowDangerouslySkipPermissions=true requires permissionMode="bypassPermissions"',
    );
  }
  const permMode = requestedPermissionMode;
  const settingsSandbox = parseSandboxConfig(loadedSettings?.sandbox);
  if (loadedSettings && loadedSettings.sandbox !== undefined && !settingsSandbox) {
    throw new Error('Loaded settings sandbox config is invalid; expected explicit boolean enabled field.');
  }
  let optionSandbox: SandboxConfig | undefined;
  if (options.sandbox !== undefined) {
    optionSandbox = parseSandboxConfig(options.sandbox);
    if (!optionSandbox) {
      throw new Error('options.sandbox must be a valid sandbox config with an explicit boolean enabled field.');
    }
  }
  const permissionEngine = new PermissionEngine({
    mode: permMode,
    ...(optionSandbox ?? settingsSandbox ? { sandbox: optionSandbox ?? settingsSandbox! } : {}),
  });
  if (loadedSettings) {
    permissionEngine.loadFromSettings(loadedSettings as Record<string, any>);
  }
  let effectivePermissionEngine: {
    evaluate: (request: { toolName: string; input: unknown; toolUseId?: string }) => { behavior: 'allow' | 'deny' | 'ask'; reason?: string } | Promise<{ behavior: 'allow' | 'deny' | 'ask'; reason?: string }>;
    addRule: (behavior: 'allow' | 'deny' | 'ask', rule: { toolName: string; ruleContent?: string }) => void;
    removeRule?: (behavior: 'allow' | 'deny' | 'ask', rule: { toolName: string; ruleContent?: string }) => void;
    setMode?: (mode: string) => void;
  } = permissionEngine as any;

  // Wire permissionPromptToolName into the permission engine when provided.
  if (options.permissionPromptToolName) {
    permissionEngine.setPermissionPromptToolName(options.permissionPromptToolName);
  }

  // Wrap permissionEngine.evaluate to apply canUseTool callback first.
  // canUseTool returning false → deny immediately.
  // canUseTool returning true → fall through to normal evaluation.
  if (options.canUseTool) {
    const originalEvaluate = permissionEngine.evaluate.bind(permissionEngine);
    effectivePermissionEngine = {
      evaluate: async (request) => {
        const baselineDecision = await originalEvaluate(request as any);
        const normalizedInput = request.input as Record<string, unknown>;
        const result = await options.canUseTool!(
          request.toolName,
          normalizedInput,
          {
            signal: internalAbortController.signal,
            suggestions: undefined,
            decisionReason: baselineDecision.reason,
            toolUseID: request.toolUseId ?? randomUUID(),
            agentID: options.agent,
          },
        );

        if (
          result &&
          typeof result === 'object' &&
          'toolUseID' in result &&
          typeof result.toolUseID === 'string' &&
          request.toolUseId &&
          result.toolUseID !== request.toolUseId
        ) {
          return {
            behavior: 'deny' as const,
            reason: `Mismatched toolUseID from canUseTool callback: expected ${request.toolUseId}, got ${result.toolUseID}`,
          };
        }

        if (result && typeof result === 'object' && 'updatedPermissions' in result) {
          applyPermissionUpdates(permissionEngine, result.updatedPermissions);
        }

        if (result && typeof result === 'object' && 'updatedInput' in result) {
          applyUpdatedInput(request.input, result.updatedInput);
        }

        if (result && typeof result === 'object' && 'behavior' in result) {
          if (result.behavior === 'allow') {
            return {
              behavior: 'allow' as const,
              reason: 'Allowed by canUseTool callback',
            };
          }
          if (result.behavior === 'deny') {
            if ('interrupt' in result && result.interrupt === true) {
              internalAbortController.abort();
            }
            const denyMessage = 'message' in result && typeof result.message === 'string'
              ? result.message
              : ('reason' in result && typeof result.reason === 'string'
                ? result.reason
                : 'Denied by canUseTool callback');
            return { behavior: 'deny' as const, reason: denyMessage };
          }
        }
        if (result === false) {
          return { behavior: 'deny' as const, reason: 'Denied by canUseTool callback' };
        }
        if (
          typeof result === 'object' &&
          result !== null &&
          'behavior' in result &&
          (result as any).behavior === 'ask'
        ) {
          return { behavior: 'ask' as const, reason: (result as any).reason };
        }
        return baselineDecision;
      },
      addRule: permissionEngine.addRule.bind(permissionEngine),
      setMode: (permissionEngine as any).setMode?.bind(permissionEngine),
    };
  }

  const permissionPrompter = createPermissionPrompterBridge({
    permissionPromptToolName: options.permissionPromptToolName,
    permissionPrompter: options.permissionPrompter,
    getMcpClient: () => mcpManager,
  });

  // ------------------------------------------------------------------
  // System prompt
  // ------------------------------------------------------------------
  let systemPrompt: string;
  if (typeof options.systemPrompt === 'string') {
    systemPrompt = options.systemPrompt;
    if (selectedAgent?.prompt) {
      systemPrompt += '\n\n' + selectedAgent.prompt;
    }
  } else {
    // Build the full system prompt (matching CLI behavior): includes tool
    // descriptions, safety guidelines, AGENT.md, auto-memory, etc.
    const toolNames = toolRegistry.list().map(t => t.name);
    const configLoader = new ConfigLoader();
    let agentMdInstructions: string[] = [];
    const sources = new Set(settingSources);
    if (sources.size > 0) {
      agentMdInstructions = configLoader.loadAgentMd(cwd);
    }

    // Filter AGENT.md sources when settingSources is provided.
    // The ConfigLoader returns instructions in order:
    //   index 0            — user-level (~/.open-agent/AGENT.md or ~/.claude/AGENT.md)
    //   index 1..N         — project/local level (walked from cwd upward)
    if (sources.size > 0) {
      const userHome = homedir();
      const hasUserAgentMd =
        existsSync(join(userHome, '.open-agent', 'AGENT.md')) ||
        existsSync(join(userHome, '.claude', 'AGENT.md')) ||
        existsSync(join(userHome, '.claude', 'CLAUDE.md'));
      const userCount = hasUserAgentMd ? 1 : 0;
      agentMdInstructions = agentMdInstructions.filter((_instruction, idx) => {
        if (idx < userCount) return sources.has('user');
        // Project-level source gates CLAUDE/AGENT instructions discovered in cwd ancestry.
        return sources.has('project');
      });
    }
    const memory = new AutoMemory(cwd);
    const memoryContent =
      sources.has('project')
        ? memory.readMemory()
        : undefined;

    systemPrompt = buildSystemPrompt({
      model,
      cwd,
      tools: toolNames,
      permissionMode: permMode,
      knowledgeCutoff: 'August 2025',
      agentInstructions: agentMdInstructions,
      memoryDir: memory.getDir(),
      memoryContent: memoryContent ?? undefined,
    });

    if (selectedAgent?.prompt) {
      systemPrompt += '\n\n' + selectedAgent.prompt;
    }

    if (options.systemPrompt?.type === 'preset' && options.systemPrompt.append) {
      systemPrompt += '\n\n' + options.systemPrompt.append;
    }
  }

  // Wire additionalDirectories into system prompt (applies regardless of prompt type)
  if (options.additionalDirectories && options.additionalDirectories.length > 0) {
    systemPrompt += '\n\nAdditional working directories:\n' +
      options.additionalDirectories.map(d => `  - ${d}`).join('\n') +
      '\nYou may read, search, and edit files in these directories in addition to the primary working directory.';
  }

  // ------------------------------------------------------------------
  // Session resume — restore prior history if requested
  // ------------------------------------------------------------------
  let initialMessages: Message[] = (options as QueryOptions & { initialMessages?: Message[] }).initialMessages ?? [];
  if (effectiveResumeSessionId && initialMessages.length === 0) {
    try {
      const sessionMgr = new SessionManager();
      if (options.resumeSessionAt) {
        const scoped = sessionMgr.loadTranscriptAnyCwdUpToAssistant(
          effectiveResumeSessionId,
          cwd,
          options.resumeSessionAt,
        );
        if (!scoped.found) {
          throw new Error(`Assistant message not found for resumeSessionAt: ${options.resumeSessionAt}`);
        }
        initialMessages = scoped.messages;
      } else {
        initialMessages = sessionMgr.loadTranscriptAnyCwd(effectiveResumeSessionId, cwd);
      }
    } catch (error) {
      if (options.resumeSessionAt) {
        throw error;
      }
      // If transcript is corrupted or missing, start fresh.
      initialMessages = [];
    }
  }

  // ------------------------------------------------------------------
  // Conversation loop
  // ------------------------------------------------------------------
  // Respect the caller's AbortController when provided; otherwise create one
  // internally so interrupt() / close() can still abort the loop.
  const callerAbortController = options.abortController;
  const internalAbortController = new AbortController();
  const callerAbortListener = () => {
    if (!internalAbortController.signal.aborted) {
      internalAbortController.abort();
    }
  };
  if (callerAbortController) {
    if (callerAbortController.signal.aborted) {
      callerAbortListener();
    } else {
      callerAbortController.signal.addEventListener('abort', callerAbortListener, { once: true });
    }
  }

  function removeCallerAbortListener(): void {
    if (callerAbortController) {
      callerAbortController.signal.removeEventListener('abort', callerAbortListener);
    }
  }

  function abortQuery(abortCaller = false): void {
    if (!internalAbortController.signal.aborted) {
      internalAbortController.abort();
    }
    if (abortCaller && callerAbortController && !callerAbortController.signal.aborted) {
      callerAbortController.abort();
    }
  }

  let cleanedUp = false;
  function cleanupQueryResources(): void {
    if (cleanedUp) return;
    cleanedUp = true;
    if (mcpManager) {
      mcpManager.disconnectAll().catch(() => {});
    }
    streamClosed = true;
    notifyQueue();
    removeCallerAbortListener();
    restoreEnv();
  }

  // Wire up a cost calculator so ConversationLoop can track spending and
  // enforce maxBudgetUsd.
  const maxBudgetUsd = options.maxBudgetUsd;

  const loop = new ConversationLoop({
    provider,
    tools: new Map(toolRegistry.list().map((t) => [t.name, t])),
    model,
    systemPrompt,
    maxTurns: options.maxTurns ?? selectedAgent?.maxTurns,
    thinking: options.thinking ?? (options.maxThinkingTokens ? { type: 'enabled', budgetTokens: options.maxThinkingTokens } : { type: 'adaptive' }),
    effort: options.effort,
    cwd,
    sessionId,
    abortSignal: internalAbortController.signal,
    permissionEngine: effectivePermissionEngine,
    permissionPrompter,
    initialMessages: initialMessages.length > 0 ? initialMessages : undefined,
    hookExecutor: effectiveHookExecutor,
    costCalculator: (m, inTok, outTok, cacheCreate, cacheRead) =>
      calculateCost(m, inTok, outTok, cacheCreate, cacheRead),
    responseFormat: options.outputFormat ? { type: options.outputFormat.type, schema: options.outputFormat.schema } : undefined,
  });

  const syncLoopToolsFromRegistry = () => {
    loop.setTools(new Map(toolRegistry.list().map((t) => [t.name, t])));
  };

  // ------------------------------------------------------------------
  // Core generator – iterates over all SDKMessages
  // ------------------------------------------------------------------
  async function* generateMessages(): AsyncGenerator<SDKMessage, void> {
    try {
      // Wait for MCP servers to connect and register their tools into the loop
      // before the first LLM call. This runs once when iteration starts.
      if (mcpReadyPromise) {
        await mcpReadyPromise;
        syncLoopToolsFromRegistry();
      }
      if (typeof prompt === 'string') {
        let usedFallback = false;
        // Retry loop — runs once normally; a second time with fallbackModel on model errors.
        while (true) {
          // Buffer the result message so we can inspect it for model errors before
          // deciding whether to yield it or retry with the fallback model.
          let resultMessage: SDKMessage | undefined;
          let modelError: Error | undefined;
          try {
            for await (const msg of loop.run(prompt)) {
              // Default behavior matches official SDK: partials are off unless explicitly enabled.
              if (options.includePartialMessages !== true && msg.type === 'stream_event') {
                continue;
              }
              // Hold back the result message — check it for model errors first.
              if (msg.type === 'result') {
                resultMessage = msg;
                continue;
              }
              yield msg;
              // Enforce maxBudgetUsd: check cumulative cost after each message.
              if (maxBudgetUsd !== undefined) {
                const { totalCostUsd } = loop.getTotalCost();
                if (totalCostUsd >= maxBudgetUsd) {
                  internalAbortController.abort();
                  yield {
                    type: 'result',
                    subtype: 'error_max_budget_usd',
                    duration_ms: 0,
                    duration_api_ms: 0,
                    is_error: true,
                    num_turns: loop.getTurnCount(),
                    stop_reason: 'max_budget_usd',
                    total_cost_usd: totalCostUsd,
                    usage: { input_tokens: 0, output_tokens: 0 },
                    modelUsage: {},
                    permission_denials: [],
                    errors: [`Budget limit exceeded: $${totalCostUsd.toFixed(4)} >= $${maxBudgetUsd}`],
                    uuid: randomUUID(),
                    session_id: sessionId,
                  };
                  return;
                }
              }
            }
          } catch (err) {
            modelError = err instanceof Error ? err : new Error(String(err));
          }

          // Check if the result message signals a model error that warrants
          // a fallback retry.  ConversationLoop yields result messages instead
          // of throwing for provider errors, so we must inspect the result too.
          if (
            !modelError &&
            resultMessage &&
            (resultMessage as any).is_error === true &&
            (resultMessage as any).stop_reason === 'error'
          ) {
            const errText = ((resultMessage as any).errors as string[] | undefined)?.join(' ') ?? '';
            if (isModelError(new Error(errText))) {
              modelError = new Error(errText);
            }
          }

          if (modelError) {
            // Switch to fallbackModel and retry once if this looks like a model error.
            if (options.fallbackModel && !usedFallback && isModelError(modelError)) {
              usedFallback = true;
              loop.setModel(options.fallbackModel);
              // Reset conversation history so that the user prompt is not
              // duplicated when loop.run(prompt) is called again below.
              loop.resetMessages(initialMessages.length > 0 ? initialMessages : undefined);
              resultMessage = undefined; // discard the error result — will retry
              continue; // retry with fallback model
            }
            // Not retrying — yield the buffered result if we have one, then surface error.
            if (resultMessage) yield resultMessage;
            if (!resultMessage) throw modelError;
          } else {
            // Normal completion — yield the buffered result message.
            if (resultMessage) yield resultMessage;
          }
          break; // normal completion
        }
      } else {
        // Multi-turn mode: consume user messages from the merged input queue.
        startSourcePromptPumpIfNeeded();
        let multiturnUsedFallback = false;
        while (true) {
          const userMsg = await readQueuedInput();
          if (userMsg === STREAM_DONE) break;
          const userPrompt = __internal_extractUserMessagePrompt(userMsg);
          if (userPrompt === undefined) continue;
          const preTurnMessages = loop.getMessages();

          let modelError: Error | undefined;
          let resultMessage: SDKMessage | undefined;
          try {
            for await (const msg of loop.run(userPrompt)) {
              if (options.includePartialMessages !== true && msg.type === 'stream_event') {
                continue;
              }
              if (msg.type === 'result') {
                resultMessage = msg;
                continue;
              }
              yield msg;
              // Enforce maxBudgetUsd in multi-turn mode too.
              if (maxBudgetUsd !== undefined) {
                const { totalCostUsd } = loop.getTotalCost();
                if (totalCostUsd >= maxBudgetUsd) {
                  internalAbortController.abort();
                  yield {
                    type: 'result',
                    subtype: 'error_max_budget_usd',
                    duration_ms: 0,
                    duration_api_ms: 0,
                    is_error: true,
                    num_turns: loop.getTurnCount(),
                    stop_reason: 'max_budget_usd',
                    total_cost_usd: totalCostUsd,
                    usage: { input_tokens: 0, output_tokens: 0 },
                    modelUsage: {},
                    permission_denials: [],
                    errors: [`Budget limit exceeded: $${totalCostUsd.toFixed(4)} >= $${maxBudgetUsd}`],
                    uuid: randomUUID(),
                    session_id: sessionId,
                  };
                  return;
                }
              }
            }
          } catch (err) {
            modelError = err instanceof Error ? err : new Error(String(err));
          }

          // Check result for model error (same logic as single-turn).
          if (
            !modelError &&
            resultMessage &&
            (resultMessage as any).is_error === true &&
            (resultMessage as any).stop_reason === 'error'
          ) {
            const errText = ((resultMessage as any).errors as string[] | undefined)?.join(' ') ?? '';
            if (isModelError(new Error(errText))) {
              modelError = new Error(errText);
            }
          }

          if (modelError) {
            if (options.fallbackModel && !multiturnUsedFallback && isModelError(modelError)) {
              multiturnUsedFallback = true;
              loop.setModel(options.fallbackModel);
              // Retry the same user message with the fallback model while
              // preserving conversation context accumulated before this turn.
              loop.resetMessages(preTurnMessages.length > 0 ? preTurnMessages : undefined);
              resultMessage = undefined;
              try {
                for await (const msg of loop.run(userPrompt)) {
                  if (options.includePartialMessages !== true && msg.type === 'stream_event') continue;
                  if (msg.type === 'result') { resultMessage = msg; continue; }
                  yield msg;
                }
              } catch (retryErr) {
                if (resultMessage) yield resultMessage;
                throw retryErr instanceof Error ? retryErr : new Error(String(retryErr));
              }
            } else {
              if (resultMessage) yield resultMessage;
              else throw modelError;
            }
          }
          if (resultMessage) yield resultMessage;
        }
      }
    } finally {
      // Ensure the abort controller fires so any dangling HTTP requests or
      // child processes are cleaned up when the caller stops iterating early.
      abortQuery(false);
      cleanupQueryResources();
    }
  }

  const rawGen = generateMessages();
  const gen = sessionMgr
    ? (async function* persistAndYield(): AsyncGenerator<SDKMessage, void> {
        try {
          for await (const msg of rawGen) {
            try {
              sessionMgr.appendToTranscript(cwd, sessionId, msg);
            } catch {
              // Non-fatal: never fail the request on transcript write errors.
            }
            yield msg;
          }
        } finally {
          try {
            sessionMgr.touchSession(cwd, sessionId);
          } catch {
            // Non-fatal
          }
        }
      })()
    : rawGen;

  // ------------------------------------------------------------------
  // Attach control methods to make the generator satisfy Query
  // ------------------------------------------------------------------
  const queryObj = gen as unknown as Query;
  const finalizeGenerator = () => {
    const returnPromise = queryObj.return?.(undefined as any) as Promise<IteratorResult<SDKMessage, void>> | undefined;
    if (returnPromise) {
      void returnPromise.catch(() => {});
    }
  };

  queryObj.interrupt = async () => {
    abortQuery(true);
    cleanupQueryResources();
    finalizeGenerator();
  };

  queryObj.setPermissionMode = async (mode) => {
    if (mode !== undefined) {
      if (mode === 'bypassPermissions' && options.allowDangerouslySkipPermissions !== true) {
        throw new Error(
          'permissionMode="bypassPermissions" requires allowDangerouslySkipPermissions=true',
        );
      }
      loop.setPermissionMode(mode);
    }
  };

  queryObj.setModel = async (newModel) => {
    if (newModel !== undefined) {
      if (typeof newModel !== 'string' || newModel.trim().length === 0) {
        throw new Error('setModel(model) requires a non-empty model string.');
      }
      loop.setModel(newModel);
    }
  };

  queryObj.setMaxThinkingTokens = async (tokens) => {
    if (tokens !== null) {
      if (!Number.isFinite(tokens) || tokens <= 0) {
        throw new Error('setMaxThinkingTokens(maxThinkingTokens) requires a positive finite number or null.');
      }
      loop.setThinking({ type: 'enabled', budgetTokens: tokens });
    } else {
      loop.setThinking({ type: 'disabled' });
    }
  };

  queryObj.supportedCommands = async () => getDefaultSlashCommands();

  queryObj.supportedAgents = async () => supportedAgentInfos.map((agent) => ({ ...agent }));

  queryObj.supportedModels = async () => provider.listModels();

  queryObj.mcpServerStatus = async () => {
    if (!mcpManager) return [];
    return mcpManager.getStatus().map((conn) => ({
      name: conn.name,
      status: mapMcpStatus(conn.status),
      ...(conn.serverInfo ? { serverInfo: { ...conn.serverInfo } } : {}),
      ...(conn.error ? { error: conn.error } : {}),
      config: sanitizeMcpStatusConfig(conn.config),
      tools: conn.tools.map((t) => ({
        name: t.name,
        ...(t.description ? { description: t.description } : {}),
        ...(t.annotations ? { annotations: { ...t.annotations } } : {}),
      })),
    }));
  };

  queryObj.accountInfo = async (): Promise<AccountInfo> => ({
    tokenSource: provider.name,
    apiKeySource,
    organization: provider.name,
  });

  queryObj.initializationResult = async () => {
    // If MCP tools are still loading, wait for them so the snapshot is complete.
    if (mcpReadyPromise) {
      await mcpReadyPromise;
    }
    const [commands, models, account, agents] = await Promise.all([
      queryObj.supportedCommands(),
      queryObj.supportedModels(),
      queryObj.accountInfo(),
      queryObj.supportedAgents(),
    ]);
    return {
      commands,
      agents,
      output_style: 'text',
      available_output_styles: ['text', 'stream-json'],
      models,
      account,
      fast_mode_state: undefined,
    };
  };

  queryObj.stopTask = async (_taskId: string) => {
    abortQuery(false);
    cleanupQueryResources();
    finalizeGenerator();
  };

  queryObj.close = () => {
    abortQuery(false);
    cleanupQueryResources();
    finalizeGenerator();
  };

  // ── MCP dynamic management ────────────────────────────────────────────────

  queryObj.reconnectMcpServer = async (serverName: string) => {
    if (!mcpManager) {
      throw new Error('No MCP manager configured for this query. Pass mcpServers in QueryOptions.');
    }
    await trackMcpSetup(mcpManager.reconnect(serverName));
    syncLoopToolsFromRegistry();
    const status = mcpManager.getStatus().find((conn) => conn.name === serverName);
    if (!status) {
      throw new Error(`MCP server '${serverName}' not found after reconnect.`);
    }
    if (status.status !== 'connected') {
      const reason = status.error ?? status.status;
      throw new Error(`Failed to reconnect MCP server '${serverName}': ${reason}`);
    }
  };

  queryObj.toggleMcpServer = async (serverName: string, enabled: boolean) => {
    if (!mcpManager) {
      throw new Error('No MCP manager configured for this query. Pass mcpServers in QueryOptions.');
    }
    await trackMcpSetup(mcpManager.toggle(serverName, enabled));
    syncLoopToolsFromRegistry();
    if (enabled) {
      const status = mcpManager.getStatus().find((conn) => conn.name === serverName);
      if (!status) {
        throw new Error(`MCP server '${serverName}' not found after toggle.`);
      }
      if (status.status !== 'connected') {
        const reason = status.error ?? status.status;
        throw new Error(`Failed to enable MCP server '${serverName}': ${reason}`);
      }
    }
  };

  queryObj.setMcpServers = async (servers) => {
    // Create an MCP manager on the fly if one does not exist yet.
    if (!mcpManager) {
      mcpManager = new McpManager();
    }
    const result = await trackMcpSetup(mcpManager.setServers(servers));
    syncLoopToolsFromRegistry();
    return result;
  };

  // ── File checkpointing ────────────────────────────────────────────────────

  queryObj.rewindFiles = async (
    userMessageId: string,
    options?: { dryRun?: boolean },
  ): Promise<RewindFilesResult> => {
    if (!fileCheckpoint) {
      return {
        canRewind: false,
        error: 'File checkpointing is not enabled.',
      };
    }
    const requestedId = resolveRewindCheckpointId(
      fileCheckpoint.list(),
      sessionMgr,
      cwd,
      sessionId,
      userMessageId,
    );
    const targets = fileCheckpoint.getRewindTargets(requestedId);
    if (!targets) {
      return {
        canRewind: false,
        error: `Checkpoint not found: ${userMessageId}`,
      };
    }
    const uniqueTarget = targets.map((t) => t.filePath);
    const beforeSnapshots = new Map<string, string | null>();
    for (const target of targets) {
      beforeSnapshots.set(target.filePath, readFileMaybe(target.filePath));
    }
    if (options?.dryRun) {
      const previewStats = accumulateRewindStats(
        targets,
        beforeSnapshots,
        new Set(uniqueTarget),
      );
      return {
        canRewind: true,
        filesChanged: uniqueTarget,
        insertions: previewStats.insertions,
        deletions: previewStats.deletions,
        rewindCount: uniqueTarget.length,
      };
    }
    const { restored, errors } = fileCheckpoint.rewindTo(requestedId);
    const restoredSet = new Set(restored);
    const appliedStats = accumulateRewindStats(targets, beforeSnapshots, restoredSet);
    return {
      canRewind: errors.length === 0,
      filesChanged: [...new Set(restored)],
      insertions: appliedStats.insertions,
      deletions: appliedStats.deletions,
      rewindCount: restored.length,
      ...(errors.length > 0 ? { error: errors.join('\n') } : {}),
    };
  };

  // ── Mid-stream input ──────────────────────────────────────────────────────

  queryObj.streamInput = async (input: AsyncIterable<SDKUserMessage> | string): Promise<void> => {
    if (typeof prompt === 'string') {
      throw new Error('streamInput() requires async-iterable prompt mode.');
    }
    if (streamClosed || internalAbortController.signal.aborted) {
      throw new Error('streamInput() cannot be used after the query is closed or interrupted.');
    }
    if (typeof input === 'string') {
      pushQueuedInput({
        type: 'user',
        message: input,
        parent_tool_use_id: null,
        session_id: sessionId,
        uuid: randomUUID(),
      } as SDKUserMessage);
      return;
    }
    for await (const msg of input) {
      pushQueuedInput(msg);
    }
  };

  return queryObj;
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function loadAvailableAgents(
  cwd: string,
  overrides?: Record<string, AgentDefinition>,
): Map<string, AgentDefinition> {
  const loader = new AgentLoader();
  loader.loadDefaults(cwd);
  if (overrides) {
    for (const [name, definition] of Object.entries(overrides)) {
      loader.register(name, definition);
    }
  }
  return new Map(loader.list());
}

function resolveSelectedAgent(
  requested: string | undefined,
  availableAgents: Map<string, AgentDefinition>,
): AgentDefinition | undefined {
  if (!requested) return undefined;
  const exact = availableAgents.get(requested);
  if (exact) return exact;

  const lowered = requested.toLowerCase();
  for (const [name, definition] of availableAgents.entries()) {
    if (name.toLowerCase() === lowered) {
      return definition;
    }
  }
  throw new Error(`Agent "${requested}" not found.`);
}

function buildAgentInfoList(availableAgents: Map<string, AgentDefinition>): AgentInfo[] {
  return [...availableAgents.entries()].map(([name, definition]) => {
    const model = resolveAgentModel(definition.model);
    return {
      name,
      description: definition?.description ?? '',
      ...(model ? { model } : {}),
    };
  });
}

function resolveAgentModel(
  model: AgentDefinition['model'] | undefined,
): string | undefined {
  switch (model) {
    case undefined:
    case 'inherit':
      return undefined;
    case 'sonnet':
      return 'claude-sonnet-4-6';
    case 'opus':
      return 'claude-opus-4-6';
    case 'haiku':
      return 'claude-haiku-4-5-20251001';
    default:
      return String(model);
  }
}

function applyUpdatedInput(
  targetInput: unknown,
  updatedInput: unknown,
): void {
  if (!targetInput || typeof targetInput !== 'object') return;
  if (!updatedInput || typeof updatedInput !== 'object') return;
  Object.assign(targetInput as Record<string, unknown>, updatedInput as Record<string, unknown>);
}

export function __internal_extractUserMessagePrompt(
  userMsg: SDKUserMessage,
): string | Message['content'] | undefined {
  const msg = userMsg.message;
  if (typeof msg === 'string') return msg;
  if (msg && typeof msg === 'object') {
    // { role, content: string | ContentBlock[] }
    const content = (msg as Record<string, unknown>).content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content.length > 0 ? (content as Message['content']) : undefined;
    }
  }
  return undefined;
}

/**
 * Heuristic: decide if an error looks like a model-level failure (e.g. model
 * not found, overloaded) where switching to a fallback model might help.
 * Handles both English and Chinese error messages from various providers.
 */
function isModelError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  const msgOriginal = err instanceof Error ? err.message : String(err);
  return (
    // English keywords
    msg.includes('model') ||
    msg.includes('not found') ||
    msg.includes('overloaded') ||
    msg.includes('capacity') ||
    msg.includes('unavailable') ||
    msg.includes('529') || // Anthropic overloaded HTTP status
    // Chinese keywords (e.g. zhipu/bigmodel API)
    msgOriginal.includes('模型') ||
    msgOriginal.includes('不存在') ||
    msgOriginal.includes('过载') ||
    msgOriginal.includes('不可用')
  );
}

function mapMcpStatus(
  status: 'connected' | 'connecting' | 'failed' | 'needs-auth' | 'error' | 'pending' | 'disabled' | 'disconnected',
): 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled' {
  if (status === 'connected') return 'connected';
  if (status === 'needs-auth') return 'needs-auth';
  if (status === 'disabled') return 'disabled';
  if (status === 'connecting' || status === 'pending') return 'pending';
  return 'failed';
}

function sanitizeMcpStatusConfig(config: unknown): McpServerStatusConfig | undefined {
  if (!config || typeof config !== 'object') return undefined;
  const c = config as Record<string, unknown>;
  if ((c.type === undefined || c.type === 'stdio') && typeof c.command === 'string') {
    const env = c.env && typeof c.env === 'object'
      ? Object.fromEntries(
          Object.entries(c.env as Record<string, unknown>)
            .filter(([k, v]) => typeof k === 'string' && typeof v === 'string'),
        )
      : undefined;
    return {
      type: 'stdio',
      command: c.command,
      ...(Array.isArray(c.args) ? { args: c.args } : {}),
      ...(env ? { env } : {}),
    } as McpServerStatusConfig;
  }
  if (c.type === 'sse' || c.type === 'http') {
    const headers = c.headers && typeof c.headers === 'object'
      ? Object.fromEntries(
          Object.entries(c.headers as Record<string, unknown>)
            .filter(([k, v]) => typeof k === 'string' && typeof v === 'string'),
        )
      : undefined;
    return {
      type: c.type,
      url: c.url,
      ...(headers ? { headers } : {}),
    } as McpServerStatusConfig;
  }
  if (c.type === 'sdk') {
    return {
      type: 'sdk',
      name: c.name,
    } as McpServerStatusConfig;
  }
  if (c.type === 'claudeai-proxy') {
    return {
      type: 'claudeai-proxy',
      url: c.url,
      id: c.id,
    } as McpServerStatusConfig;
  }
  return undefined;
}

function resolveRewindCheckpointId(
  checkpoints: Array<{ toolUseId: string }>,
  sessionManager: SessionManager | null,
  cwd: string,
  sessionId: string,
  userMessageId: string,
): string {
  if (checkpoints.some((c) => c.toolUseId === userMessageId)) {
    return userMessageId;
  }
  if (!sessionManager) return userMessageId;

  let transcript: unknown[] = [];
  try {
    transcript = sessionManager.readTranscript(cwd, sessionId);
  } catch {
    return userMessageId;
  }

  const start = transcript.findIndex((entry) => {
    const e = entry as Record<string, unknown>;
    return e.type === 'user' && e.uuid === userMessageId;
  });
  if (start === -1) return userMessageId;

  for (let i = start + 1; i < transcript.length; i++) {
    const e = transcript[i] as Record<string, unknown>;
    if (e.type === 'user') break;
    if (e.type === 'tool_result' && typeof e.tool_use_id === 'string') {
      return e.tool_use_id;
    }
  }
  return userMessageId;
}

function assertUnsupportedOptions(options: QueryOptions): void {
  const unsupportedKeys: Array<keyof QueryOptions> = [
    'betas',
    'onElicitation',
    'plugins',
    'debugFile',
    'spawnClaudeCodeProcess',
    'promptSuggestions',
  ];
  for (const key of unsupportedKeys) {
    if ((options as Record<string, unknown>)[key] !== undefined) {
      throw new Error(`Option "${String(key)}" is not supported yet in open-agent/sdk.`);
    }
  }
}

function parseSandboxConfig(config: unknown): SandboxConfig | undefined {
  if (!config || typeof config !== 'object') return undefined;
  const candidate = config as Record<string, unknown>;
  if (typeof candidate.enabled !== 'boolean') return undefined;
  return config as SandboxConfig;
}

function isValidUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function __internal_isToolAllowedByPolicies(
  toolName: string,
  policy: {
    agentAllowedTools?: string[];
    agentDisallowedTools?: string[];
    toolsBaseline?: string[];
    allowedTools?: string[];
    disallowedTools?: string[];
  },
): boolean {
  const denyLists = [policy.agentDisallowedTools, policy.disallowedTools]
    .filter((list): list is string[] => Array.isArray(list))
    .flat();
  if (denyLists.includes(toolName)) return false;

  const allowLists = [
    policy.agentAllowedTools,
    policy.toolsBaseline,
    policy.allowedTools,
  ].filter((list): list is string[] => Array.isArray(list) && list.length > 0);

  for (const allowList of allowLists) {
    if (!allowList.includes(toolName)) {
      return false;
    }
  }
  return true;
}

function readFileMaybe(filePath: string): string | null {
  try {
    return existsSync(filePath) ? readFileSync(filePath, 'utf-8') : null;
  } catch {
    return null;
  }
}

function toLines(content: string | null): string[] {
  if (content === null || content.length === 0) return [];
  return content.split(/\r?\n/);
}

function diffLineStats(
  fromContent: string | null,
  toContent: string | null,
): { insertions: number; deletions: number } {
  if (fromContent === toContent) {
    return { insertions: 0, deletions: 0 };
  }
  if (fromContent === null) {
    return { insertions: toLines(toContent).length, deletions: 0 };
  }
  if (toContent === null) {
    return { insertions: 0, deletions: toLines(fromContent).length };
  }
  const a = toLines(fromContent);
  const b = toLines(toContent);
  if (a.length === 0 && b.length === 0) return { insertions: 0, deletions: 0 };
  if (a.length === 0) return { insertions: b.length, deletions: 0 };
  if (b.length === 0) return { insertions: 0, deletions: a.length };

  const prev = new Uint32Array(b.length + 1);
  const curr = new Uint32Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = 0;
    for (let j = 1; j <= b.length; j++) {
      curr[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1] + 1
        : Math.max(prev[j], curr[j - 1]);
    }
    prev.set(curr);
  }

  const lcs = prev[b.length];
  return {
    insertions: b.length - lcs,
    deletions: a.length - lcs,
  };
}

function accumulateRewindStats(
  targets: Array<{ filePath: string; originalContent: string | null }>,
  beforeSnapshots: Map<string, string | null>,
  includeFiles: Set<string>,
): { insertions: number; deletions: number } {
  let insertions = 0;
  let deletions = 0;
  for (const target of targets) {
    if (!includeFiles.has(target.filePath)) continue;
    const before = beforeSnapshots.get(target.filePath) ?? null;
    const stats = diffLineStats(before, target.originalContent);
    insertions += stats.insertions;
    deletions += stats.deletions;
  }
  return { insertions, deletions };
}

/**
 * Infer the provider backend from well-known model name prefixes.
 * Returns `null` when the model is unknown (caller falls back to auto-detect).
 */
function guessProviderFromModel(
  model?: string,
): 'anthropic' | 'openai' | 'ollama' | null {
  if (!model) return null;
  if (model.startsWith('claude')) return 'anthropic';
  if (
    model.startsWith('gpt') ||
    model.startsWith('o1') ||
    model.startsWith('o3') ||
    model.startsWith('o4')
  ) {
    return 'openai';
  }
  return null;
}

/**
 * Returns the standard slash commands supported by the open-agent REPL.
 * Defined inline to keep the SDK self-contained (no dependency on @open-agent/cli).
 */
function getDefaultSlashCommands(): SlashCommand[] {
  return [
    { name: '/help', description: 'Show available commands', argumentHint: '' },
    { name: '/model', description: 'Show or change the current model', argumentHint: '[model_name]' },
    { name: '/compact', description: 'Compact conversation history', argumentHint: '' },
    { name: '/status', description: 'Show session status', argumentHint: '' },
    { name: '/cost', description: 'Show session cost', argumentHint: '' },
    { name: '/tools', description: 'List registered tools', argumentHint: '' },
    { name: '/memory', description: 'Show auto-memory status', argumentHint: '' },
    { name: '/permissions', description: 'Show permission mode and rules', argumentHint: '' },
    { name: '/thinking', description: 'Show or change thinking mode', argumentHint: '[adaptive|enabled|disabled]' },
    { name: '/effort', description: 'Show or change effort level', argumentHint: '[low|medium|high|max]' },
    { name: '/config', description: 'Show current configuration', argumentHint: '' },
    { name: '/agents', description: 'List available agent types', argumentHint: '' },
    { name: '/mcp', description: 'Show MCP server status', argumentHint: '' },
    { name: '/sessions', description: 'List recent sessions', argumentHint: '' },
    { name: '/commit', description: 'Create a git commit with AI message', argumentHint: '' },
    { name: '/review', description: 'Review current git diff', argumentHint: '' },
    { name: '/init', description: 'Create AGENT.md for this project', argumentHint: '' },
    { name: '/doctor', description: 'Diagnose environment issues', argumentHint: '' },
    { name: '/rewind', description: 'List or restore file checkpoints', argumentHint: '[number]' },
    { name: '/clear', description: 'Clear the terminal', argumentHint: '' },
    { name: '/exit', description: 'Exit the REPL', argumentHint: '' },
    { name: '/quit', description: 'Exit the REPL', argumentHint: '' },
  ];
}
