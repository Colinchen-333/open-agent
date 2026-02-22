// @open-agent/providers - LLM provider abstractions
// Provides a unified streaming interface for Anthropic, OpenAI, and Ollama backends.

export type {
  LLMProvider,
  Message,
  ContentBlock,
  StreamEvent,
  ChatOptions,
  ToolSpec,
} from './types.js';

export { AnthropicProvider } from './anthropic.js';
export { OpenAIProvider } from './openai.js';
export { OllamaProvider } from './ollama.js';
export { calculateCost } from './pricing.js';

import type { LLMProvider } from './types.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAIProvider } from './openai.js';
import { OllamaProvider } from './ollama.js';

export interface ProviderConfig {
  provider: 'anthropic' | 'openai' | 'ollama';
  apiKey?: string;
  baseURL?: string;
}

/**
 * Create an LLMProvider instance from an explicit configuration object.
 *
 * @example
 * const provider = createProvider({ provider: 'anthropic', apiKey: '...' });
 * const provider = createProvider({ provider: 'openai', baseURL: 'http://localhost:8000/v1' });
 * const provider = createProvider({ provider: 'ollama' });
 */
export function createProvider(config: ProviderConfig): LLMProvider {
  switch (config.provider) {
    case 'anthropic':
      return new AnthropicProvider({ apiKey: config.apiKey, baseURL: config.baseURL });
    case 'openai':
      return new OpenAIProvider({ apiKey: config.apiKey, baseURL: config.baseURL });
    case 'ollama':
      return new OllamaProvider({ baseURL: config.baseURL });
    default: {
      // Exhaustiveness guard
      const _: never = config.provider;
      throw new Error(`Unknown provider: ${String(_)}`);
    }
  }
}

/**
 * Auto-detect an available LLM provider by inspecting environment variables.
 *
 * Priority order:
 * 1. ANTHROPIC_API_KEY → AnthropicProvider
 * 2. OPENAI_API_KEY    → OpenAIProvider
 * 3. Fallback          → OllamaProvider (assumes http://localhost:11434)
 *
 * @example
 * const provider = autoDetectProvider();
 */
export function autoDetectProvider(): LLMProvider {
  if (process.env.ANTHROPIC_API_KEY) {
    return new AnthropicProvider();
  }
  if (process.env.OPENAI_API_KEY) {
    return new OpenAIProvider();
  }
  console.warn('No API key found (ANTHROPIC_API_KEY, OPENAI_API_KEY). Falling back to Ollama at localhost:11434.');
  return new OllamaProvider();
}
