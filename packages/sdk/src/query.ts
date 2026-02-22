import { randomUUID } from 'crypto';
import type { SDKMessage, SDKUserMessage } from '@open-agent/core';
import { ConversationLoop } from '@open-agent/core';
import { createDefaultToolRegistry } from '@open-agent/tools';
import { autoDetectProvider, createProvider } from '@open-agent/providers';
import type { QueryOptions, Query } from './types.js';

// --------------------------------------------------------------------------
// query() – V1 streaming API
// --------------------------------------------------------------------------

/**
 * Start a new agent conversation and return a `Query` handle that is both an
 * `AsyncGenerator<SDKMessage>` and exposes control methods.
 *
 * @example
 * ```ts
 * const q = query({ prompt: 'List files in the current directory' });
 * for await (const msg of q) {
 *   if (msg.type === 'result') console.log(msg.result);
 * }
 * ```
 */
export function query(params: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: QueryOptions;
}): Query {
  const { prompt, options = {} } = params;
  const cwd = options.cwd ?? process.cwd();
  const sessionId = options.sessionId ?? randomUUID();

  // ------------------------------------------------------------------
  // Provider resolution
  // ------------------------------------------------------------------
  const providerName = guessProviderFromModel(options.model);
  const provider = providerName
    ? createProvider({ provider: providerName })
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
        // ToolRegistry has no `remove` method; rebuild via a filtered Map.
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
  // System prompt
  // ------------------------------------------------------------------
  let systemPrompt: string;
  if (typeof options.systemPrompt === 'string') {
    systemPrompt = options.systemPrompt;
  } else if (options.systemPrompt?.type === 'preset') {
    systemPrompt = buildDefaultSystemPrompt(cwd);
    if (options.systemPrompt.append) {
      systemPrompt += '\n\n' + options.systemPrompt.append;
    }
  } else {
    systemPrompt = buildDefaultSystemPrompt(cwd);
  }

  // ------------------------------------------------------------------
  // Conversation loop
  // ------------------------------------------------------------------
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
    abortSignal: options.abortController?.signal,
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
    options.abortController?.abort();
  };

  queryObj.setPermissionMode = async (_mode) => {
    // Dynamic permission-mode changes are not yet implemented in the core loop.
    // Documented as a no-op stub for forward compatibility.
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
    options.abortController?.abort();
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

/** Minimal default system prompt injected when no override is supplied. */
function buildDefaultSystemPrompt(cwd: string): string {
  return `You are OpenAgent, an AI coding assistant. Current working directory: ${cwd}`;
}
