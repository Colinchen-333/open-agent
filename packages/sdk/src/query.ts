import { randomUUID } from 'crypto';
import type { SDKMessage, SDKUserMessage, SlashCommand, AccountInfo } from '@open-agent/core';
import { ConversationLoop, SessionManager, buildSystemPrompt, ConfigLoader, AutoMemory, FileCheckpoint } from '@open-agent/core';
import { createDefaultToolRegistry } from '@open-agent/tools';
import { autoDetectProvider, createProvider, calculateCost } from '@open-agent/providers';
import type { Message } from '@open-agent/providers';
import { PermissionEngine } from '@open-agent/permissions';
import { HookExecutor } from '@open-agent/hooks';
import { McpManager } from '@open-agent/mcp';
import type { QueryOptions, Query } from './types.js';

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
  const sessionId = options.forkSession ? randomUUID() : (options.sessionId ?? randomUUID());

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
          const providerName = guessProviderFromModel(options.model);
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
  // Stored as a promise so the async work completes inside the generator
  // without blocking the synchronous query() call.
  let mcpReadyPromise: Promise<void> | undefined;
  if (options.mcpServers && Object.keys(options.mcpServers).length > 0) {
    mcpManager = new McpManager();
    mcpReadyPromise = mcpManager.setServers(options.mcpServers).then(() => {
      // Register each MCP tool as a ToolDefinition in the registry.
      for (const mcpTool of mcpManager!.getAllTools()) {
        toolRegistry.register({
          name: mcpTool.name,
          description: mcpTool.description ?? '',
          inputSchema: mcpTool.inputSchema,
          execute: (input: Record<string, unknown>) =>
            mcpManager!.callTool(mcpTool.serverName, mcpTool.name, input),
        });
      }
    });
  }

  // (env and debug overrides already applied above, before provider resolution)

  // ------------------------------------------------------------------
  // Model resolution
  // ------------------------------------------------------------------
  const model =
    options.model ??
    (provider.name === 'anthropic' ? 'claude-sonnet-4-6' : 'gpt-4o');

  // ------------------------------------------------------------------
  // Permission engine — wire from QueryOptions
  // ------------------------------------------------------------------
  const permMode = options.allowDangerouslySkipPermissions
    ? 'bypassPermissions'
    : (options.permissionMode ?? 'bypassPermissions'); // SDK defaults to bypass
  const permissionEngine = new PermissionEngine({ mode: permMode });

  // Wire permissionPromptToolName into the permission engine when provided.
  if (options.permissionPromptToolName) {
    permissionEngine.setPermissionPromptToolName(options.permissionPromptToolName);
  }

  // Wrap permissionEngine.evaluate to apply canUseTool callback first.
  // canUseTool returning false → deny immediately.
  // canUseTool returning true → fall through to normal evaluation.
  if (options.canUseTool) {
    const originalEvaluate = permissionEngine.evaluate.bind(permissionEngine);
    permissionEngine.evaluate = (request) => {
      const result = options.canUseTool!(
        request.toolName,
        request.input as Record<string, unknown>,
      );
      if (result === false) {
        return { behavior: 'deny' as const, reason: 'Denied by canUseTool callback' };
      }
      return originalEvaluate(request);
    };
  }

  const permissionPrompter = options.permissionPrompter
    ? { prompt: options.permissionPrompter }
    : undefined;

  // ------------------------------------------------------------------
  // System prompt
  // ------------------------------------------------------------------
  let systemPrompt: string;
  if (typeof options.systemPrompt === 'string') {
    systemPrompt = options.systemPrompt;
  } else {
    // Build the full system prompt (matching CLI behavior): includes tool
    // descriptions, safety guidelines, AGENT.md, auto-memory, etc.
    const toolNames = toolRegistry.list().map(t => t.name);
    const configLoader = new ConfigLoader();
    let agentMdInstructions = configLoader.loadAgentMd(cwd);

    // Filter AGENT.md sources when settingSources is provided.
    // The ConfigLoader returns instructions in order:
    //   index 0            — user-level (~/.open-agent/AGENT.md or ~/.claude/AGENT.md)
    //   index 1..N         — project/local level (walked from cwd upward)
    if (options.settingSources) {
      const sources = new Set(options.settingSources);
      const userHome = require('os').homedir();
      const hasUserAgentMd =
        require('fs').existsSync(require('path').join(userHome, '.open-agent', 'AGENT.md')) ||
        require('fs').existsSync(require('path').join(userHome, '.claude', 'AGENT.md')) ||
        require('fs').existsSync(require('path').join(userHome, '.claude', 'CLAUDE.md'));
      const userCount = hasUserAgentMd ? 1 : 0;
      agentMdInstructions = agentMdInstructions.filter((_instruction, idx) => {
        if (idx < userCount) return sources.has('user');
        return sources.has('project') || sources.has('local');
      });
    }
    const memory = new AutoMemory(cwd);
    const memoryContent = memory.readMemory();

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
  if (options.resume && initialMessages.length === 0) {
    try {
      const sessionMgr = new SessionManager();
      initialMessages = sessionMgr.loadTranscript(cwd, options.resume);
    } catch {
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

  // Wire up a cost calculator so ConversationLoop can track spending and
  // enforce maxBudgetUsd.
  const maxBudgetUsd = options.maxBudgetUsd;

  const loop = new ConversationLoop({
    provider,
    tools: new Map(toolRegistry.list().map((t) => [t.name, t])),
    model,
    systemPrompt,
    maxTurns: options.maxTurns,
    thinking: options.thinking ?? (options.maxThinkingTokens ? { type: 'enabled', budgetTokens: options.maxThinkingTokens } : { type: 'adaptive' }),
    effort: options.effort,
    cwd,
    sessionId,
    abortSignal: internalAbortController.signal,
    permissionEngine,
    permissionPrompter,
    initialMessages: initialMessages.length > 0 ? initialMessages : undefined,
    hookExecutor: effectiveHookExecutor,
    costCalculator: (m, inTok, outTok, cacheCreate, cacheRead) =>
      calculateCost(m, inTok, outTok, cacheCreate, cacheRead),
    responseFormat: options.outputFormat ? { type: options.outputFormat.type, schema: options.outputFormat.schema } : undefined,
  });

  // ------------------------------------------------------------------
  // Core generator – iterates over all SDKMessages
  // ------------------------------------------------------------------
  async function* generateMessages(): AsyncGenerator<SDKMessage, void> {
    // Wait for MCP servers to connect and register their tools into the loop
    // before the first LLM call. This runs once when iteration starts.
    if (mcpReadyPromise) {
      await mcpReadyPromise;
      // Push MCP tools into the live loop tool map.
      for (const t of toolRegistry.list()) {
        loop.addTool(t);
      }
    }

    try {
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
              // When includePartialMessages is false, suppress incremental stream events.
              if (options.includePartialMessages === false && msg.type === 'stream_event') {
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
        // Multi-turn mode: consume user messages from the async iterable.
        let multiturnUsedFallback = false;
        for await (const userMsg of prompt) {
          const text = extractUserMessageText(userMsg);
          if (!text) continue;

          let modelError: Error | undefined;
          let resultMessage: SDKMessage | undefined;
          try {
            for await (const msg of loop.run(text)) {
              if (options.includePartialMessages === false && msg.type === 'stream_event') {
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
              // Retry the same user message with the fallback model.
              loop.resetMessages();
              resultMessage = undefined;
              try {
                for await (const msg of loop.run(text)) {
                  if (options.includePartialMessages === false && msg.type === 'stream_event') continue;
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
      // Disconnect MCP servers when the conversation ends.
      if (mcpManager) {
        mcpManager.disconnectAll().catch(() => {});
      }
      removeCallerAbortListener();
      // Restore any env vars that were overridden by options.env or options.debug.
      restoreEnv();
    }
  }

  const gen = generateMessages();

  // ------------------------------------------------------------------
  // Attach control methods to make the generator satisfy Query
  // ------------------------------------------------------------------
  const queryObj = gen as unknown as Query;

  queryObj.interrupt = async () => {
    abortQuery(true);
  };

  queryObj.setPermissionMode = async (mode) => {
    if (mode !== undefined) {
      loop.setPermissionMode(mode);
    }
  };

  queryObj.setModel = async (newModel) => {
    if (newModel !== undefined) {
      loop.setModel(newModel);
    }
  };

  queryObj.setMaxThinkingTokens = async (tokens) => {
    if (tokens !== null) {
      loop.setThinking({ type: 'enabled', budgetTokens: tokens });
    } else {
      loop.setThinking({ type: 'disabled' });
    }
  };

  queryObj.supportedCommands = async () => getDefaultSlashCommands();

  queryObj.supportedModels = async () => provider.listModels();

  queryObj.mcpServerStatus = async () => {
    if (!mcpManager) return [];
    return mcpManager.getStatus().map(conn => ({
      name: conn.name,
      status: (conn.status === 'connected' || conn.status === 'connecting' || conn.status === 'error')
        ? conn.status
        : ('disconnected' as const),
      error: conn.error,
      tools: conn.tools.map(t => t.name),
    }));
  };

  queryObj.accountInfo = async (): Promise<AccountInfo> => ({
    tokenSource: provider.name,
    apiKeySource,
    organization: provider.name,
  });

  // Capture a mutable initialization snapshot.  The tools list is updated
  // lazily after MCP tools are loaded inside the generator.  Non-MCP callers
  // get an accurate snapshot immediately; MCP callers get the full tool list
  // once iteration has begun and MCP servers have connected.
  const initSnapshot = {
    tools: toolRegistry.list().map(t => t.name),
    model,
    cwd,
    sessionId,
    permissionMode: permMode,
  };

  queryObj.initializationResult = async () => {
    // If MCP tools are still loading, wait for them so the snapshot is complete.
    if (mcpReadyPromise) {
      await mcpReadyPromise;
      // Refresh the tools list now that MCP tools have been registered.
      initSnapshot.tools = toolRegistry.list().map(t => t.name);
    }
    return { ...initSnapshot };
  };

  queryObj.stopTask = async (_taskId?: string) => {
    abortQuery(true);
  };

  queryObj.close = () => {
    abortQuery(false);
    removeCallerAbortListener();
    restoreEnv();
  };

  // ── MCP dynamic management ────────────────────────────────────────────────

  queryObj.reconnectMcpServer = async (serverName: string) => {
    if (!mcpManager) {
      throw new Error('No MCP manager configured for this query. Pass mcpServers in QueryOptions.');
    }
    // Remember old tools from this server before reconnecting so we can clean them up.
    const oldTools = mcpManager.getAllTools()
      .filter(t => t.serverName === serverName)
      .map(t => t.name);
    await mcpManager.reconnect(serverName);
    // Remove stale tools from this server before re-registering new ones.
    for (const name of oldTools) {
      toolRegistry.unregister(name);
    }
    // Re-register updated tools from the reconnected server into the live loop.
    for (const mcpTool of mcpManager.getAllTools()) {
      if (mcpTool.serverName === serverName) {
        const toolDef = {
          name: mcpTool.name,
          description: mcpTool.description ?? '',
          inputSchema: mcpTool.inputSchema,
          execute: (input: Record<string, unknown>) =>
            mcpManager!.callTool(mcpTool.serverName, mcpTool.name, input),
        };
        toolRegistry.register(toolDef);
        loop.addTool(toolRegistry.get(mcpTool.name)!);
      }
    }
  };

  queryObj.toggleMcpServer = async (serverName: string, enabled: boolean) => {
    if (!mcpManager) {
      throw new Error('No MCP manager configured for this query. Pass mcpServers in QueryOptions.');
    }
    await mcpManager.toggle(serverName, enabled);
  };

  queryObj.setMcpServers = async (servers) => {
    // Create an MCP manager on the fly if one does not exist yet.
    if (!mcpManager) {
      mcpManager = new McpManager();
    }
    const result = await mcpManager.setServers(servers);
    // Re-register all MCP tools into the tool registry and live loop.
    for (const mcpTool of mcpManager.getAllTools()) {
      const toolDef = {
        name: mcpTool.name,
        description: mcpTool.description ?? '',
        inputSchema: mcpTool.inputSchema,
        execute: (input: Record<string, unknown>) =>
          mcpManager!.callTool(mcpTool.serverName, mcpTool.name, input),
      };
      toolRegistry.register(toolDef);
      loop.addTool(toolRegistry.get(mcpTool.name)!);
    }
    return result;
  };

  // ── File checkpointing ────────────────────────────────────────────────────

  queryObj.rewindFiles = async (toolUseId: string): Promise<boolean> => {
    if (!fileCheckpoint) {
      return false;
    }
    const { restored } = fileCheckpoint.rewindTo(toolUseId);
    return restored.length > 0;
  };

  // ── Mid-stream input ──────────────────────────────────────────────────────

  queryObj.streamInput = async (message: string): Promise<void> => {
    // ConversationLoop does not expose a live-injection API.
    // Log a warning so the caller is aware the message was not processed.
    process.stderr.write(
      `[open-agent/sdk] streamInput("${message}"): live message injection is not yet supported — message discarded.\n`,
    );
  };

  return queryObj;
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

/**
 * Extract the plain-text content from an SDKUserMessage.
 * Handles both string and Anthropic-style content blocks.
 */
function extractUserMessageText(userMsg: SDKUserMessage): string {
  const msg = userMsg.message;
  if (typeof msg === 'string') return msg;
  if (msg && typeof msg === 'object') {
    // { role, content: string | ContentBlock[] }
    const content = (msg as Record<string, unknown>).content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .filter((b: Record<string, unknown>) => b.type === 'text')
        .map((b: Record<string, unknown>) => b.text as string)
        .join('\n');
    }
  }
  return '';
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
