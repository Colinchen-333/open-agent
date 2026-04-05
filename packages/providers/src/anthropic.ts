import Anthropic from '@anthropic-ai/sdk';
import type { ModelInfo, SystemPromptBlock } from '@open-agent/core';
import type {
  ChatOptions,
  ContentBlock,
  LLMProvider,
  Message,
  ServerToolSpec,
  StreamEvent,
  ToolSpec,
} from './types.js';
import { buildAnthropicThinkingParam } from './thinking.js';

/**
 * Convert a list of SystemPromptBlocks into the Anthropic messages API
 * `system` parameter format, placing a single `cache_control` marker on the
 * LAST static block to seal the static prefix for prompt caching.
 *
 * Dynamic blocks (cwd, git state, memory, session info) receive no
 * cache_control so they are always re-sent to the model fresh each turn.
 */
export function buildAnthropicSystemParam(
  blocks: SystemPromptBlock[],
): Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }> {
  // Find the last static block — marking it seals the entire static prefix.
  let lastStaticIdx = -1;
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i]!.section === 'static') {
      lastStaticIdx = i;
      break;
    }
  }
  return blocks.map((b, i) => {
    const entry: { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } } = {
      type: 'text',
      text: b.text,
    };
    if (i === lastStaticIdx) {
      entry.cache_control = { type: 'ephemeral' };
    }
    return entry;
  });
}

// Convert unified Message[] to Anthropic MessageParam[] format.
// System messages are extracted separately and not included in the returned array.
// @internal
export function convertMessages(
  messages: Message[],
): Anthropic.Messages.MessageParam[] {
  const result: Anthropic.Messages.MessageParam[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      // System messages are handled separately via the top-level system param
      continue;
    }

    if (typeof msg.content === 'string') {
      result.push({ role: msg.role, content: msg.content });
      continue;
    }

    // Complex content blocks
    const converted: Anthropic.Messages.ContentBlockParam[] = [];

    for (const block of msg.content as ContentBlock[]) {
      switch (block.type) {
        case 'text':
          converted.push({ type: 'text', text: block.text as string });
          break;

        case 'thinking': {
          // Anthropic thinking blocks require a valid cryptographic signature.
          // Skip blocks with missing/empty signature to avoid API 400 errors.
          const sig = block.signature as string;
          if (sig) {
            converted.push({
              type: 'thinking',
              thinking: block.thinking as string,
              signature: sig,
            } as Anthropic.Messages.ThinkingBlockParam);
          }
          break;
        }

        case 'redacted_thinking': {
          // Redacted thinking blocks must be passed back verbatim to the API.
          converted.push({
            type: 'redacted_thinking',
            data: (block as any).data,
          } as any);
          break;
        }

        case 'tool_use':
          converted.push({
            type: 'tool_use',
            id: block.id as string,
            name: block.name as string,
            input: block.input ?? {},
          });
          break;

        case 'tool_result': {
          // tool_result appears in user messages.
          // The content may be a plain string, an array of typed content blocks
          // (including image blocks for vision), or any other value.
          const toolContent = block.content;
          let contentParam: string | Anthropic.Messages.ToolResultBlockParam['content'];

          if (typeof toolContent === 'string') {
            contentParam = toolContent;
          } else if (Array.isArray(toolContent)) {
            // Map each inner block to the appropriate Anthropic content param type.
            // Supports text and image blocks; anything else falls back to text/JSON.
            contentParam = (toolContent as ContentBlock[]).map((c) => {
              if (c.type === 'image') {
                // Image block — pass base64 data through for vision.
                return {
                  type: 'image' as const,
                  source: {
                    type: 'base64' as const,
                    media_type: (c.media_type as Anthropic.Messages.Base64ImageSource['media_type']) ?? 'image/png',
                    data: c.data as string,
                  },
                };
              }
              // Default: render as text
              return {
                type: 'text' as const,
                text: c.type === 'text' ? (c.text as string) : JSON.stringify(c),
              };
            });
          } else {
            contentParam = JSON.stringify(toolContent);
          }

          converted.push({
            type: 'tool_result',
            tool_use_id: block.tool_use_id as string,
            content: contentParam,
            is_error: block.is_error as boolean | undefined,
          });
          break;
        }

        case 'server_tool_use':
          // Server-side tool blocks must be passed back verbatim to the API.
          converted.push({
            type: 'server_tool_use',
            id: block.id as string,
            name: block.name as string,
            input: block.input ?? {},
          } as any);
          break;

        case 'web_search_tool_result':
          // Web search results from server-side execution — pass back as-is.
          converted.push({
            type: 'web_search_tool_result',
            tool_use_id: block.tool_use_id as string,
            content: block.content ?? [],
          } as any);
          break;

        case 'image':
          // Support base64-encoded images
          converted.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: (block.media_type as Anthropic.Messages.Base64ImageSource['media_type']) ?? 'image/png',
              data: block.data as string,
            },
          });
          break;

        default:
          // Fallback: render as text
          converted.push({
            type: 'text',
            text: JSON.stringify(block),
          });
      }
    }

    result.push({ role: msg.role, content: converted });
  }

  return result;
}

// Extract the first system message content, or fall back to ChatOptions.systemPrompt.
// @internal
export function extractSystemPrompt(
  messages: Message[],
  options: ChatOptions,
): string | undefined {
  const systemMsg = messages.find((m) => m.role === 'system');
  if (systemMsg) {
    return typeof systemMsg.content === 'string'
      ? systemMsg.content
      : (systemMsg.content as ContentBlock[])
          .filter((b) => b.type === 'text')
          .map((b) => b.text as string)
          .join('\n');
  }
  return options.systemPrompt;
}

// Convert ToolSpec[] to Anthropic Tool format.
// @internal
export function convertTools(tools: ToolSpec[]): Anthropic.Messages.Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema as Anthropic.Messages.Tool['input_schema'],
  }));
}

// Map effort level to thinking budget tokens.
// @internal
export function effortToBudget(effort: ChatOptions['effort']): number {
  switch (effort) {
    case 'low':
      return 2000;
    case 'medium':
      return 8000;
    case 'high':
      return 16000;
    case 'max':
      return 32000;
    default:
      return 8000;
  }
}

export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic';
  private client: Anthropic;

  constructor(options?: { apiKey?: string; baseURL?: string }) {
    this.client = new Anthropic({
      apiKey: options?.apiKey ?? process.env.ANTHROPIC_API_KEY,
      baseURL: options?.baseURL,
    });
  }

  async *chat(
    messages: Message[],
    options: ChatOptions,
  ): AsyncGenerator<StreamEvent> {
    try {
      const system = extractSystemPrompt(messages, options);
      const anthropicMessages = convertMessages(messages);
      const regularTools =
        options.tools && options.tools.length > 0
          ? convertTools(options.tools)
          : [];
      const serverTools: ServerToolSpec[] = options.serverTools ?? [];
      const tools =
        regularTools.length > 0 || serverTools.length > 0
          ? [...regularTools, ...serverTools]
          : undefined;

      // Determine thinking configuration.
      // buildAnthropicThinkingParam gates on both the caller's ThinkingConfig
      // and supportsThinking(model) so we never send thinking to a model that
      // doesn't support it.
      const thinkingParam = buildAnthropicThinkingParam(options);
      const budgetTokens = thinkingParam?.budget_tokens ?? 0;

      // When thinking is active max_tokens must exceed budget_tokens or the API
      // will reject the request / truncate output.  Guarantee at least
      // budget_tokens + 4096 headroom for the visible response.
      const effectiveMaxTokens = thinkingParam
        ? Math.max(options.maxTokens ?? 16384, budgetTokens + 4096)
        : (options.maxTokens ?? 8192);

      // If responseFormat is specified, instruct the model to output JSON
      let effectiveSystem = system;
      if (options.responseFormat) {
        const schemaStr = JSON.stringify(options.responseFormat.schema);
        effectiveSystem = (effectiveSystem ?? '') + `\n\nYou MUST respond with valid JSON matching this schema:\n${schemaStr}`;
      }

      // Enable prompt caching on system prompt and tool definitions.
      // This can reduce costs by up to 90% and latency by 85% on long conversations
      // where the system prompt and tool specs repeat every turn.
      //
      // When structured blocks are provided, use buildAnthropicSystemParam to
      // place cache_control only on the last static block (sealing the static
      // prefix) so dynamic session content is never cached.  Fall back to a
      // single fully-cached block when only a flat string is available.
      let systemParam:
        | Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }>
        | undefined;

      if (options.systemPromptBlocks && options.systemPromptBlocks.length > 0) {
        // If responseFormat appended JSON instructions, attach them as an
        // extra dynamic block so the boundary placement stays correct.
        const blocks = options.responseFormat
          ? [
              ...options.systemPromptBlocks,
              {
                text: `\n\nYou MUST respond with valid JSON matching this schema:\n${JSON.stringify(options.responseFormat.schema)}`,
                section: 'dynamic' as const,
              },
            ]
          : options.systemPromptBlocks;
        systemParam = buildAnthropicSystemParam(blocks);
      } else if (effectiveSystem) {
        systemParam = [{ type: 'text' as const, text: effectiveSystem, cache_control: { type: 'ephemeral' as const } }];
      }

      // Mark the last tool definition for caching so the entire tool list is cached.
      const cachedTools = tools && tools.length > 0
        ? tools.map((t, i) =>
            i === tools.length - 1
              ? { ...t, cache_control: { type: 'ephemeral' as const } }
              : t
          )
        : undefined;

      const baseParams = {
        model: options.model,
        max_tokens: effectiveMaxTokens,
        messages: anthropicMessages,
        ...(systemParam ? { system: systemParam } : {}),
        ...(cachedTools ? { tools: cachedTools as unknown as Anthropic.Messages.ToolUnion[] } : {}),
        // When thinking is active the Anthropic API requires temperature = 1.0
        // (any other value is rejected). Inject it explicitly so the model
        // behaves correctly regardless of the caller-supplied temperature.
        // When thinking is inactive, forward the caller's value if present.
        ...(thinkingParam
          ? { temperature: 1.0 }
          : options.temperature !== undefined
            ? { temperature: options.temperature }
            : {}),
        ...(options.topP !== undefined && !thinkingParam
          ? { top_p: options.topP }
          : {}),
        ...(options.stopSequences ? { stop_sequences: options.stopSequences } : {}),
      };

      // Pass the caller's AbortSignal so Ctrl+C cancels the HTTP request.
      const requestOptions = options.signal
        ? { signal: options.signal }
        : undefined;

      // Use the extended thinking beta when thinking is requested
      if (thinkingParam) {
        const stream = await (this.client.beta.messages.stream as any)(
          {
            ...baseParams,
            thinking: thinkingParam,
            betas: ['interleaved-thinking-2025-05-14'],
          },
          requestOptions,
        );

        yield* this.processStream(stream);
      } else {
        const stream = await this.client.messages.stream(baseParams, requestOptions);
        yield* this.processStream(stream);
      }
    } catch (err: unknown) {
      yield {
        type: 'error',
        error: err instanceof Error ? { message: err.message, name: err.name } : err,
      };
    }
  }

  // Process the Anthropic MessageStream and yield unified StreamEvents.
  // The parameter is typed as AsyncIterable over the event union so it works
  // with both the regular messages.stream() and beta.messages.stream() overloads.
  private async *processStream(
    stream: AsyncIterable<Anthropic.Messages.MessageStreamEvent> & {
      finalMessage(): Promise<Anthropic.Messages.Message>;
    },
  ): AsyncGenerator<StreamEvent> {
    // Map from content block index → tool_use id, populated at content_block_start.
    // This lets us emit tool_use_end at content_block_stop (per-block) rather than
    // batching all tool_use_end events at message_stop.
    const blockIndexToToolUseId = new Map<number, string>();

    for await (const event of stream) {
      switch (event.type) {
        case 'message_start':
          yield { type: 'message_start', message: event.message };
          break;

        case 'content_block_start': {
          const block = event.content_block;
          yield {
            type: 'content_block_start',
            index: event.index,
            content_block: block,
          };

          if (block.type === 'tool_use') {
            // Record the mapping so content_block_stop can look up the id.
            blockIndexToToolUseId.set(event.index, block.id);
            yield { type: 'tool_use_start', id: block.id, name: block.name };
          } else if ((block as any).type === 'server_tool_use') {
            yield {
              type: 'server_tool_use',
              id: (block as any).id,
              name: (block as any).name,
              input: (block as any).input,
            };
          } else if ((block as any).type === 'web_search_tool_result') {
            // web_search_tool_result blocks arrive as complete blocks at content_block_start
            yield {
              type: 'web_search_result',
              tool_use_id: (block as any).tool_use_id,
              content: (block as any).content,
            };
          }
          break;
        }

        case 'content_block_delta': {
          const delta = event.delta;
          yield {
            type: 'content_block_delta',
            index: event.index,
            delta,
          };

          if (delta.type === 'text_delta') {
            yield { type: 'text_delta', text: delta.text };
          } else if (delta.type === 'thinking_delta') {
            yield { type: 'thinking_delta', thinking: delta.thinking };
          } else if (delta.type === 'input_json_delta') {
            // Resolve the tool_use id from the block index map so consumers
            // get a populated id on every tool_use_delta event.
            // Only emit for registered tool_use blocks — server_tool_use blocks
            // also receive input_json_delta but are NOT in blockIndexToToolUseId.
            // Emitting with an empty id would create a phantom tool_use entry.
            const toolUseId = blockIndexToToolUseId.get(event.index);
            if (toolUseId) {
              yield {
                type: 'tool_use_delta',
                id: toolUseId,
                partial_json: delta.partial_json,
              };
            }
          }
          break;
        }

        case 'content_block_stop': {
          yield { type: 'content_block_stop', index: event.index };
          // Emit tool_use_end immediately when the block closes (per-block timing),
          // then remove the entry so we don't re-emit it at message_stop.
          const toolUseId = blockIndexToToolUseId.get(event.index);
          if (toolUseId !== undefined) {
            yield { type: 'tool_use_end', id: toolUseId };
            blockIndexToToolUseId.delete(event.index);
          }
          break;
        }

        case 'message_delta':
          // Carries stop_reason and usage (including cache token counts).
          yield {
            type: 'message_delta',
            delta: (event as any).delta,
            usage: (event as any).usage,
          };
          break;

        case 'message_stop': {
          const finalMsg = await stream.finalMessage();
          yield {
            type: 'message_end',
            message: finalMsg,
            usage: finalMsg.usage,
          };
          // blockIndexToToolUseId should be empty at this point because every
          // tool_use block emits tool_use_end at content_block_stop.  If any
          // stragglers remain (e.g. due to a truncated stream), emit them now
          // as a safety net.
          for (const id of blockIndexToToolUseId.values()) {
            yield { type: 'tool_use_end', id };
          }
          blockIndexToToolUseId.clear();
          return;
        }

        default:
          break;
      }
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    return [
      {
        value: 'claude-opus-4-6',
        displayName: 'Claude Opus 4.6',
        description: 'Most capable model for complex tasks',
        supportsThinking: true,
        supportsAdaptiveThinking: true,
        supportsEffort: true,
        supportedEffortLevels: ['low', 'medium', 'high', 'max'],
        supportsStructuredOutput: true,
        supportsImages: true,
        supportsServerTools: true,
      },
      {
        value: 'claude-sonnet-4-6',
        displayName: 'Claude Sonnet 4.6',
        description: 'Balanced performance and speed',
        supportsThinking: true,
        supportsAdaptiveThinking: true,
        supportsEffort: true,
        supportedEffortLevels: ['low', 'medium', 'high'],
        supportsStructuredOutput: true,
        supportsImages: true,
        supportsServerTools: true,
      },
      {
        value: 'claude-haiku-4-5-20251001',
        displayName: 'Claude Haiku 4.5',
        description: 'Fast and affordable for lightweight tasks',
        supportsThinking: true,
        supportsEffort: true,
        supportedEffortLevels: ['low', 'medium', 'high'],
        supportsStructuredOutput: true,
        supportsImages: true,
        supportsServerTools: true,
      },
    ];
  }

  async getCapabilities(model?: string) {
    const models = await this.listModels();
    const matched = model ? models.find((entry) => entry.value === model) : undefined;
    return {
      provider: this.name,
      ...(model ? { model } : {}),
      thinking: 'native' as const,
      structuredOutput: 'best_effort' as const,
      toolUse: 'native' as const,
      serverTools: 'native' as const,
      supportsAdaptiveThinking: matched?.supportsAdaptiveThinking ?? true,
      supportedEffortLevels: matched?.supportedEffortLevels ?? ['low', 'medium', 'high', 'max'],
    };
  }
}
