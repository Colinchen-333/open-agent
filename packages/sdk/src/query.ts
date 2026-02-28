import { randomUUID } from 'crypto';
import type { SDKMessage, SDKUserMessage } from '@open-agent/core';
import { ConversationLoop, SessionManager, buildSystemPrompt, ConfigLoader, AutoMemory } from '@open-agent/core';
import { createDefaultToolRegistry } from '@open-agent/tools';
import { autoDetectProvider, createProvider, calculateCost } from '@open-agent/providers';
import type { Message } from '@open-agent/providers';
import { PermissionEngine } from '@open-agent/permissions';
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
  // Provider resolution
  // ------------------------------------------------------------------
  const providerName = guessProviderFromModel(options.model);
  const provider = providerName
    ? createProvider({ provider: providerName, apiKey: (options as Record<string, unknown>).apiKey as string | undefined })
    : autoDetectProvider();

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
    thinking: options.thinking ?? { type: 'adaptive' },
    effort: options.effort,
    cwd,
    sessionId,
    abortSignal: internalAbortController.signal,
    permissionEngine,
    initialMessages: initialMessages.length > 0 ? initialMessages : undefined,
    costCalculator: (m, inTok, outTok, cacheCreate, cacheRead) =>
      calculateCost(m, inTok, outTok, cacheCreate, cacheRead),
  });

  // ------------------------------------------------------------------
  // Core generator – iterates over all SDKMessages
  // ------------------------------------------------------------------
  async function* generateMessages(): AsyncGenerator<SDKMessage, void> {
    try {
      if (typeof prompt === 'string') {
        for await (const msg of loop.run(prompt)) {
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
      } else {
        // Multi-turn mode: consume user messages from the async iterable.
        for await (const userMsg of prompt) {
          const text = extractUserMessageText(userMsg);
          if (text) {
            yield* loop.run(text);
          }
        }
      }
    } finally {
      // Ensure the abort controller fires so any dangling HTTP requests or
      // child processes are cleaned up when the caller stops iterating early.
      if (!internalAbortController.signal.aborted) {
        internalAbortController.abort();
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

  queryObj.supportedCommands = async () => [];

  queryObj.supportedModels = async () => provider.listModels();

  queryObj.mcpServerStatus = async () => [];

  queryObj.accountInfo = async () => ({});

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
