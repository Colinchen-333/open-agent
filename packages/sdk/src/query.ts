import { randomUUID } from 'crypto';
import type { SDKMessage, SDKUserMessage } from '@open-agent/core';
import { ConversationLoop, SessionManager, buildSystemPrompt, ConfigLoader, AutoMemory } from '@open-agent/core';
import { createDefaultToolRegistry } from '@open-agent/tools';
import { autoDetectProvider, createProvider } from '@open-agent/providers';
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
    ? createProvider({ provider: providerName, apiKey: (options as any).apiKey })
    : autoDetectProvider();

  // ------------------------------------------------------------------
  // Tool registry
  // ------------------------------------------------------------------
  const toolRegistry = createDefaultToolRegistry(cwd);

  // Apply allowedTools: discard everything not in the list.
  if (Array.isArray(options.allowedTools) && options.allowedTools.length > 0) {
    const allowed = new Set(options.allowedTools);
    for (const tool of toolRegistry.list()) {
      if (!allowed.has(tool.name)) {
        (toolRegistry as any).tools.delete(tool.name);
      }
    }
  }

  // Apply disallowedTools: remove each named tool.
  if (options.disallowedTools) {
    for (const name of options.disallowedTools) {
      (toolRegistry as any).tools.delete(name);
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
    : (options.permissionMode as any) ?? 'bypassPermissions'; // SDK defaults to bypass
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
  let initialMessages: import('@open-agent/providers').Message[] = (options as any).initialMessages ?? [];
  if (options.resume && initialMessages.length === 0) {
    const sessionMgr = new SessionManager();
    initialMessages = sessionMgr.loadTranscript(cwd, options.resume);
  }

  // ------------------------------------------------------------------
  // Conversation loop
  // ------------------------------------------------------------------
  const internalAbortController = options.abortController ?? new AbortController();

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
  });

  // ------------------------------------------------------------------
  // Core generator – iterates over all SDKMessages
  // ------------------------------------------------------------------
  async function* generateMessages(): AsyncGenerator<SDKMessage, void> {
    if (typeof prompt === 'string') {
      yield* loop.run(prompt);
    } else {
      // Multi-turn mode: consume user messages from the async iterable.
      for await (const userMsg of prompt) {
        const text =
          typeof userMsg.message === 'string'
            ? userMsg.message
            : typeof (userMsg.message as any)?.content === 'string'
              ? (userMsg.message as any).content
              : '';
        if (text) {
          yield* loop.run(text);
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
    model.startsWith('o3')
  ) {
    return 'openai';
  }
  return null;
}

