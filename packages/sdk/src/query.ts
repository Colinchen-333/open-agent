import { randomUUID } from 'crypto';
import type { SDKMessage, SDKUserMessage } from '@open-agent/core';
import { ConversationLoop, SessionManager, buildSystemPrompt, ConfigLoader, AutoMemory } from '@open-agent/core';
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
  const sessionId = options.sessionId ?? randomUUID();

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
  if (options.debug) {
    savedEnv['DEBUG'] ??= process.env['DEBUG'];
    process.env['DEBUG'] = 'open-agent:*';
  }

  // ------------------------------------------------------------------
  // Provider resolution
  // ------------------------------------------------------------------
  // If the caller explicitly specifies a provider, use it directly.
  // Otherwise fall back to model-name heuristics → environment auto-detect.
  const provider = options.provider
    ? createProvider({ provider: options.provider, apiKey: options.apiKey, baseURL: options.baseUrl })
    : (() => {
        const providerName = guessProviderFromModel(options.model);
        return providerName
          ? createProvider({ provider: providerName, apiKey: options.apiKey, baseURL: options.baseUrl })
          : autoDetectProvider();
      })();

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
    const agentMdInstructions = configLoader.loadAgentMd(cwd);
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
  const internalAbortController = options.abortController ?? new AbortController();

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
    initialMessages: initialMessages.length > 0 ? initialMessages : undefined,
    hookExecutor: loopHookExecutor,
    costCalculator: (m, inTok, outTok, cacheCreate, cacheRead) =>
      calculateCost(m, inTok, outTok, cacheCreate, cacheRead),
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
        for await (const userMsg of prompt) {
          const text = extractUserMessageText(userMsg);
          if (text) {
            for await (const msg of loop.run(text)) {
              if (options.includePartialMessages === false && msg.type === 'stream_event') {
                continue;
              }
              yield msg;
            }
          }
        }
      }
    } finally {
      // Ensure the abort controller fires so any dangling HTTP requests or
      // child processes are cleaned up when the caller stops iterating early.
      if (!internalAbortController.signal.aborted) {
        internalAbortController.abort();
      }
      // Disconnect MCP servers when the conversation ends.
      if (mcpManager) {
        mcpManager.disconnectAll().catch(() => {});
      }
      // Restore any env vars that were overridden by options.env or options.debug.
      for (const [key, original] of Object.entries(savedEnv)) {
        if (original === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = original;
        }
      }
    }
  }

  const gen = generateMessages();

  // ------------------------------------------------------------------
  // Attach control methods to make the generator satisfy Query
  // ------------------------------------------------------------------
  const queryObj = gen as unknown as Query;

  queryObj.interrupt = async () => {
    internalAbortController.abort();
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

  // TODO: return registered slash commands once command registry is implemented
  queryObj.supportedCommands = async () => [];

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

  queryObj.accountInfo = async () => ({
    tokenSource: provider.name,
  });

  queryObj.close = () => {
    internalAbortController.abort();
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
