import Anthropic from '@anthropic-ai/sdk';
import type { ModelInfo } from '@open-agent/core';
import type {
  ChatOptions,
  ContentBlock,
  LLMProvider,
  Message,
  StreamEvent,
  ToolSpec,
} from './types.js';

// Convert unified Message[] to Anthropic MessageParam[] format.
// System messages are extracted separately and not included in the returned array.
function convertMessages(
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

        case 'thinking':
          // Anthropic thinking blocks in assistant messages
          converted.push({
            type: 'thinking',
            thinking: block.thinking as string,
            signature: (block.signature as string) ?? '',
          } as Anthropic.Messages.ThinkingBlockParam);
          break;

        case 'tool_use':
          converted.push({
            type: 'tool_use',
            id: block.id as string,
            name: block.name as string,
            input: block.input ?? {},
          });
          break;

        case 'tool_result': {
          // tool_result appears in user messages
          const toolContent = block.content;
          const contentParam: string | Anthropic.Messages.ToolResultBlockParam['content'] =
            typeof toolContent === 'string'
              ? toolContent
              : Array.isArray(toolContent)
                ? (toolContent as ContentBlock[]).map((c) => ({
                    type: 'text' as const,
                    text: typeof c === 'string' ? c : JSON.stringify(c),
                  }))
                : JSON.stringify(toolContent);

          converted.push({
            type: 'tool_result',
            tool_use_id: block.tool_use_id as string,
            content: contentParam,
            is_error: block.is_error as boolean | undefined,
          });
          break;
        }

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
function extractSystemPrompt(
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
function convertTools(tools: ToolSpec[]): Anthropic.Messages.Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema as Anthropic.Messages.Tool['input_schema'],
  }));
}

// Map effort level to thinking budget tokens.
function effortToBudget(effort: ChatOptions['effort']): number {
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
      const tools =
        options.tools && options.tools.length > 0
          ? convertTools(options.tools)
          : undefined;

      // Determine thinking configuration
      const thinking = options.thinking;
      const useThinking =
        thinking && thinking.type !== 'disabled';

      let thinkingParam: Anthropic.Messages.ThinkingConfigParam | undefined;
      if (useThinking) {
        const budgetTokens =
          thinking?.type === 'enabled'
            ? (thinking.budgetTokens ?? 10000)
            : effortToBudget(options.effort);

        thinkingParam = {
          type: 'enabled',
          budget_tokens: budgetTokens,
        };
      }

      const baseParams = {
        model: options.model,
        max_tokens: options.maxTokens ?? (thinkingParam ? 16000 : 8096),
        messages: anthropicMessages,
        ...(system ? { system } : {}),
        ...(tools ? { tools } : {}),
        ...(options.temperature !== undefined && !thinkingParam
          ? { temperature: options.temperature }
          : {}),
        ...(options.topP !== undefined && !thinkingParam
          ? { top_p: options.topP }
          : {}),
        ...(options.stopSequences ? { stop_sequences: options.stopSequences } : {}),
      };

      // Use the extended thinking beta when thinking is requested
      if (thinkingParam) {
        const stream = await (this.client.beta.messages.stream as any)({
          ...baseParams,
          thinking: thinkingParam,
          betas: ['interleaved-thinking-2025-05-14'],
        });

        yield* this.processStream(stream);
      } else {
        const stream = await this.client.messages.stream(baseParams);
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
            const toolUseId = blockIndexToToolUseId.get(event.index) ?? '';
            yield {
              type: 'tool_use_delta',
              id: toolUseId,
              partial_json: delta.partial_json,
            };
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
          // Carries stop_reason and usage
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
        supportsAdaptiveThinking: true,
        supportsEffort: true,
        supportedEffortLevels: ['low', 'medium', 'high', 'max'],
      },
      {
        value: 'claude-sonnet-4-6',
        displayName: 'Claude Sonnet 4.6',
        description: 'Balanced performance and speed',
        supportsAdaptiveThinking: true,
        supportsEffort: true,
        supportedEffortLevels: ['low', 'medium', 'high'],
      },
      {
        value: 'claude-haiku-4-5-20251001',
        displayName: 'Claude Haiku 4.5',
        description: 'Fast and affordable for lightweight tasks',
        supportsEffort: true,
        supportedEffortLevels: ['low', 'medium', 'high'],
      },
    ];
  }
}
