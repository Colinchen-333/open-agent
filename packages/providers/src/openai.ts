import OpenAI from 'openai';
import type { ModelInfo } from '@open-agent/core';
import type {
  ChatOptions,
  ContentBlock,
  LLMProvider,
  Message,
  StreamEvent,
  ToolSpec,
} from './types.js';

// Convert unified Message[] to OpenAI ChatCompletionMessageParam[].
// Handles system, user, assistant, and tool result messages.
function convertMessages(
  messages: Message[],
  systemPrompt?: string,
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const result: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];

  // Prepend explicit systemPrompt option if there is no system message already
  const hasSystemMessage = messages.some((m) => m.role === 'system');
  if (systemPrompt && !hasSystemMessage) {
    result.push({ role: 'system', content: systemPrompt });
  }

  for (const msg of messages) {
    if (msg.role === 'system') {
      // System messages: content is always a string
      const text =
        typeof msg.content === 'string'
          ? msg.content
          : (msg.content as ContentBlock[])
              .filter((b) => b.type === 'text')
              .map((b) => b.text as string)
              .join('\n');
      result.push({ role: 'system', content: text });
      continue;
    }

    if (msg.role === 'user') {
      result.push(...convertUserMessage(msg));
      continue;
    }

    if (msg.role === 'assistant') {
      result.push(convertAssistantMessage(msg));
      continue;
    }
  }

  return result;
}

// User messages may contain tool_result blocks, which become separate role:'tool' messages.
function convertUserMessage(
  msg: Message,
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  if (typeof msg.content === 'string') {
    return [{ role: 'user', content: msg.content }];
  }

  const blocks = msg.content as ContentBlock[];
  const textParts: OpenAI.Chat.Completions.ChatCompletionContentPartText[] = [];
  const toolResults: OpenAI.Chat.Completions.ChatCompletionToolMessageParam[] = [];

  for (const block of blocks) {
    if (block.type === 'tool_result') {
      // OpenAI represents tool results as role: 'tool' messages
      const content =
        typeof block.content === 'string'
          ? block.content
          : JSON.stringify(block.content);
      toolResults.push({
        role: 'tool',
        tool_call_id: block.tool_use_id as string,
        content,
      });
    } else if (block.type === 'text') {
      textParts.push({ type: 'text', text: block.text as string });
    } else if (block.type === 'image') {
      // Images are included inline in user messages
      (textParts as OpenAI.Chat.Completions.ChatCompletionContentPart[]).push({
        type: 'image_url',
        image_url: {
          url: `data:${block.media_type ?? 'image/png'};base64,${block.data}`,
        },
      });
    }
  }

  const out: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];

  // If there are any text parts alongside tool results, emit user message first
  if (textParts.length > 0) {
    out.push({
      role: 'user',
      content: textParts.length === 1 ? textParts[0].text : (textParts as OpenAI.Chat.Completions.ChatCompletionContentPart[]),
    });
  }

  out.push(...toolResults);
  return out;
}

// Assistant messages may contain tool_use blocks.
function convertAssistantMessage(
  msg: Message,
): OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam {
  if (typeof msg.content === 'string') {
    return { role: 'assistant', content: msg.content };
  }

  const blocks = msg.content as ContentBlock[];
  let textContent = '';
  const toolCalls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[] = [];

  for (const block of blocks) {
    if (block.type === 'text') {
      textContent += block.text as string;
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id as string,
        type: 'function',
        function: {
          name: block.name as string,
          arguments:
            typeof block.input === 'string'
              ? block.input
              : JSON.stringify(block.input ?? {}),
        },
      });
    }
    // thinking blocks are not supported in OpenAI format — silently drop them
  }

  const param: OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam = {
    role: 'assistant',
    content: textContent || null,
  };

  if (toolCalls.length > 0) {
    param.tool_calls = toolCalls;
  }

  return param;
}

// Convert ToolSpec[] to OpenAI ChatCompletionTool format.
function convertTools(
  tools: ToolSpec[],
): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));
}

function normalizeUsage(
  usage: OpenAI.Chat.Completions.CompletionUsage | undefined,
): Record<string, number> | undefined {
  if (!usage) return undefined;
  const normalized: Record<string, number> = {
    input_tokens: usage.prompt_tokens ?? 0,
    output_tokens: usage.completion_tokens ?? 0,
  };
  const cached = usage.prompt_tokens_details?.cached_tokens;
  if (typeof cached === 'number') {
    normalized.cache_read_input_tokens = cached;
  }
  return normalized;
}

// State for accumulating a single streaming tool call.
interface ToolCallAccumulator {
  id: string;
  name: string;
  argumentsJson: string;
  started: boolean;
}

export class OpenAIProvider implements LLMProvider {
  readonly name = 'openai';
  private client: OpenAI;

  constructor(options?: { apiKey?: string; baseURL?: string }) {
    this.client = new OpenAI({
      apiKey: options?.apiKey ?? process.env.OPENAI_API_KEY,
      baseURL: options?.baseURL,
    });
  }

  async *chat(
    messages: Message[],
    options: ChatOptions,
  ): AsyncGenerator<StreamEvent> {
    try {
      const oaiMessages = convertMessages(messages, options.systemPrompt);
      const tools =
        options.tools && options.tools.length > 0
          ? convertTools(options.tools)
          : undefined;

      const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
        model: options.model,
        messages: oaiMessages,
        stream: true,
        // Request usage counts to be included in the final stream chunk so
        // token tracking works correctly.
        stream_options: { include_usage: true },
        ...(options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
        ...(options.topP !== undefined ? { top_p: options.topP } : {}),
        ...(options.stopSequences ? { stop: options.stopSequences } : {}),
        ...(tools ? { tools, tool_choice: 'auto' } : {}),
        ...(options.responseFormat && {
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'structured_output',
              strict: true,
              schema: options.responseFormat.schema,
            },
          },
        }),
      };

      const stream = await this.client.chat.completions.create(params);

      // Accumulated tool call state keyed by index in the delta array
      const toolAccumulators = new Map<number, ToolCallAccumulator>();
      let contentBuffer = '';

      // Emit a synthetic message_start
      yield { type: 'message_start', message: { model: options.model } };

      for await (const chunk of stream) {
        const choice = chunk.choices[0];
        if (!choice) continue;

        const delta = choice.delta;

        // Text content
        if (delta.content) {
          contentBuffer += delta.content;
          yield { type: 'text_delta', text: delta.content };
        }

        // Tool calls — OpenAI streams them as incremental deltas indexed by position
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index;

            if (!toolAccumulators.has(idx)) {
              // First chunk for this tool call: id and name are provided here
              const acc: ToolCallAccumulator = {
                id: tc.id ?? '',
                name: tc.function?.name ?? '',
                argumentsJson: tc.function?.arguments ?? '',
                started: false,
              };
              toolAccumulators.set(idx, acc);
            }

            const acc = toolAccumulators.get(idx)!;

            // Accumulate id/name/arguments across chunks
            if (tc.id) acc.id = tc.id;
            if (tc.function?.name) acc.name = tc.function.name;
            if (tc.function?.arguments) {
              acc.argumentsJson += tc.function.arguments;

              // Emit tool_use_start on first argument chunk (name is known by now)
              if (!acc.started) {
                acc.started = true;
                yield { type: 'tool_use_start', id: acc.id, name: acc.name };
              }

              // Emit incremental JSON delta
              yield {
                type: 'tool_use_delta',
                id: acc.id,
                partial_json: tc.function.arguments,
              };
            }
          }
        }

        // Finish reason
        if (choice.finish_reason) {
          // Close all pending tool calls — including zero-argument ones that
          // never received an arguments chunk and thus were never "started".
          for (const [, acc] of toolAccumulators) {
            if (!acc.started) {
              // Zero-argument tool call: emit start + empty args + end
              acc.started = true;
              yield { type: 'tool_use_start', id: acc.id, name: acc.name };
              yield { type: 'tool_use_delta', id: acc.id, partial_json: acc.argumentsJson || '{}' };
            }
            yield { type: 'tool_use_end', id: acc.id };
          }

          yield {
            type: 'message_end',
            message: {
              model: options.model,
              content: contentBuffer,
              tool_calls: [...toolAccumulators.values()].map((acc) => ({
                id: acc.id,
                name: acc.name,
                input: (() => {
                  try {
                    return JSON.parse(acc.argumentsJson);
                  } catch {
                    return acc.argumentsJson;
                  }
                })(),
              })),
              stop_reason: choice.finish_reason,
            },
            usage: normalizeUsage(chunk.usage),
          };
        }
      }
    } catch (err: unknown) {
      yield {
        type: 'error',
        error: err instanceof Error ? { message: err.message, name: err.name } : err,
      };
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    return [
      {
        value: 'gpt-4o',
        displayName: 'GPT-4o',
        description: 'Most capable OpenAI model',
        supportsEffort: false,
      },
      {
        value: 'gpt-4o-mini',
        displayName: 'GPT-4o Mini',
        description: 'Fast and cost-effective',
        supportsEffort: false,
      },
      {
        value: 'o3',
        displayName: 'o3',
        description: 'Advanced reasoning model',
        supportsEffort: true,
        supportedEffortLevels: ['low', 'medium', 'high'],
      },
      {
        value: 'o4-mini',
        displayName: 'o4-mini',
        description: 'Fast reasoning model',
        supportsEffort: true,
        supportedEffortLevels: ['low', 'medium', 'high'],
      },
    ];
  }
}
