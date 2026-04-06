import type { McpSamplingRequest, McpSamplingResponse } from './types.js';

/**
 * Handler for MCP sampling/createMessage requests.
 * The MCP server asks the client to make an LLM call on its behalf.
 */
export interface SamplingHandler {
  /** Execute a sampling request using the host's LLM provider. */
  createMessage(request: McpSamplingRequest): Promise<McpSamplingResponse>;
}

/**
 * Create a SamplingHandler that delegates to a provided LLM function.
 *
 * This factory wires the MCP sampling protocol (server → client LLM delegation)
 * to whatever LLM provider the host application is using. The `llmCall` function
 * receives simplified message/option shapes and returns text + model metadata.
 *
 * @example
 * ```ts
 * const handler = createSamplingHandler({
 *   llmCall: async (messages, options) => {
 *     const result = await myProvider.chat(messages, options);
 *     return { text: result.content, model: result.model, stopReason: 'endTurn' };
 *   },
 * });
 * ```
 */
export function createSamplingHandler(opts: {
  /** The function that actually calls the LLM */
  llmCall: (
    messages: Array<{ role: string; content: string }>,
    options: {
      systemPrompt?: string;
      maxTokens?: number;
      temperature?: number;
      stopSequences?: string[];
    },
  ) => Promise<{ text: string; model: string; stopReason?: string }>;
}): SamplingHandler {
  return {
    async createMessage(request: McpSamplingRequest): Promise<McpSamplingResponse> {
      const messages = request.messages.map(m => ({
        role: m.role,
        content: m.content.text,
      }));

      const result = await opts.llmCall(messages, {
        systemPrompt: request.systemPrompt,
        maxTokens: request.maxTokens,
        temperature: request.temperature,
        stopSequences: request.stopSequences,
      });

      return {
        role: 'assistant',
        content: { type: 'text', text: result.text },
        model: result.model,
        stopReason: (result.stopReason as McpSamplingResponse['stopReason']) ?? 'endTurn',
      };
    },
  };
}
