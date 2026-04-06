import OpenAI from 'openai';
import { randomUUID } from 'crypto';
import type { ModelInfo } from '@open-agent/core';
import type {
  ChatOptions,
  ContentBlock,
  LLMProvider,
  Message,
  StreamEvent,
  ToolSpec,
} from './types.js';
import { supportsThinking, getContextWindowForModel, getModelCapability } from './model-capability.js';

// ---------------------------------------------------------------------------
// Token estimation — local chars/4 heuristic (avoids a hard dep on core)
// ---------------------------------------------------------------------------

/** Rough estimate: 1 token ≈ 4 characters (English). */
function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/** Estimate the total token count for an array of OpenAI-format messages. */
function estimateOaiMessageTokens(messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[]): number {
  let total = 0;
  for (const msg of messages) {
    // 4-token fixed overhead per message (role + JSON framing)
    total += 4;
    const content = msg.content;
    if (typeof content === 'string') {
      total += estimateTokens(content);
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (part && typeof part === 'object' && 'text' in part && typeof (part as any).text === 'string') {
          total += estimateTokens((part as any).text);
        }
      }
    }
    // tool_calls in assistant messages
    if ('tool_calls' in msg && Array.isArray((msg as any).tool_calls)) {
      for (const tc of (msg as any).tool_calls) {
        total += estimateTokens(tc.function?.name ?? '');
        total += estimateTokens(tc.function?.arguments ?? '');
      }
    }
  }
  return total;
}

// Track which models we have already warned about unsupported thinking so we
// emit the console.warn at most once per process (not once per request).
const _thinkingWarnedModels = new Set<string>();

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
  const contentParts: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];
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
      contentParts.push({ type: 'text', text: block.text as string });
    } else if (block.type === 'image') {
      // Images are included inline in user messages
      contentParts.push({
        type: 'image_url',
        image_url: {
          url: `data:${block.media_type ?? 'image/png'};base64,${block.data}`,
        },
      });
    }
  }

  const out: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];

  // If there are any text parts alongside tool results, emit user message first
  if (contentParts.length > 0) {
    const singleText =
      contentParts.length === 1 && contentParts[0]?.type === 'text'
        ? contentParts[0]
        : null;
    out.push({
      role: 'user',
      content: singleText ? singleText.text : contentParts,
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
  usage:
    | {
        prompt_tokens?: number;
        completion_tokens?: number;
        prompt_tokens_details?: { cached_tokens?: number };
      }
    | null
    | undefined,
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

function shouldRetryWithoutStreamOptions(err: unknown): boolean {
  const status = (err as any)?.status;
  const msg = String((err as any)?.message ?? '').toLowerCase();
  return (
    status === 400 &&
    (msg.includes('stream_options') ||
      msg.includes('include_usage') ||
      msg.includes('unknown parameter'))
  );
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
      // ── Part 1: Thinking / reasoning support ────────────────────────────────
      //
      // For models that natively support reasoning (e.g. gpt-5), forward the
      // effort level via `reasoning_effort`.  For models that don't, emit a
      // one-time warning and carry on — the option is silently dropped so the
      // request still succeeds.
      const modelSupportsThinking = supportsThinking(options.model);
      if (options.thinking && options.thinking.type !== 'disabled') {
        if (!modelSupportsThinking && !_thinkingWarnedModels.has(options.model)) {
          _thinkingWarnedModels.add(options.model);
          console.warn(
            `[OpenAIProvider] thinking was requested for model "${options.model}" but this model does not support extended thinking — the setting will be ignored.`,
          );
        }
      }

      // ── Part 2: Context-window budget & message truncation ──────────────────
      //
      // Use the capability registry to compute how much input headroom we have.
      // If the estimated token count of the converted messages exceeds the
      // available budget, drop the oldest non-system messages until we fit.
      // System messages are always preserved.
      const contextWindow = getContextWindowForModel(options.model);
      const maxOutputTokens = options.maxTokens ?? getModelCapability(options.model)?.maxOutput ?? 4096;
      const maxInputTokens = contextWindow - maxOutputTokens;

      let oaiMessages = convertMessages(messages, options.systemPrompt);

      // Truncate if necessary, keeping system messages intact.
      if (maxInputTokens > 0) {
        let estimatedTokens = estimateOaiMessageTokens(oaiMessages);
        if (estimatedTokens > maxInputTokens) {
          // Split into system and non-system messages, then trim from the
          // oldest non-system messages until we are under budget.
          const systemMessages = oaiMessages.filter((m) => m.role === 'system');
          const nonSystemMessages = oaiMessages.filter((m) => m.role !== 'system');

          while (nonSystemMessages.length > 1 && estimatedTokens > maxInputTokens) {
            nonSystemMessages.shift();
            estimatedTokens = estimateOaiMessageTokens([...systemMessages, ...nonSystemMessages]);
          }

          oaiMessages = [...systemMessages, ...nonSystemMessages];
        }
      }

      const tools =
        options.tools && options.tools.length > 0
          ? convertTools(options.tools)
          : undefined;

      // ── Part 3: Build request params ────────────────────────────────────────

      // Tool choice: caller can override; fall back to 'auto' when tools exist.
      const toolChoiceValue = options.toolChoice ?? (tools ? 'auto' : undefined);

      // Reasoning effort mapping: our effort levels map 1-to-1 to OpenAI's.
      // Only attached when the model actually supports thinking.
      const reasoningEffort =
        modelSupportsThinking && options.thinking && options.thinking.type !== 'disabled'
          ? ((options.effort ?? 'medium') as OpenAI.ReasoningEffort)
          : undefined;

      const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
        model: options.model,
        messages: oaiMessages,
        stream: true,
        ...(options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
        ...(options.topP !== undefined ? { top_p: options.topP } : {}),
        ...(options.stopSequences ? { stop: options.stopSequences } : {}),
        // Tools + tool_choice
        ...(tools ? { tools } : {}),
        ...(toolChoiceValue !== undefined
          ? { tool_choice: toolChoiceValue as OpenAI.Chat.Completions.ChatCompletionToolChoiceOption }
          : {}),
        // Structured output (JSON schema)
        ...(options.responseFormat && {
          response_format: {
            type: 'json_schema' as const,
            json_schema: {
              name: 'structured_output',
              strict: true,
              schema: options.responseFormat.schema,
            },
          },
        }),
        // Reasoning effort for o-series and gpt-5 class models
        ...(reasoningEffort !== undefined ? { reasoning_effort: reasoningEffort } : {}),
      };

      let stream: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>;
      try {
        stream = await this.client.chat.completions.create(
          {
            ...params,
            stream_options: { include_usage: true },
          },
          { signal: options.signal },
        );
      } catch (err) {
        if (!shouldRetryWithoutStreamOptions(err)) throw err;
        stream = await this.client.chat.completions.create(params, { signal: options.signal });
      }

      // Accumulated tool call state keyed by index in the delta array
      const toolAccumulators = new Map<number, ToolCallAccumulator>();
      let contentBuffer = '';

      // Emit a synthetic message_start
      yield { type: 'message_start', message: { model: options.model } };

      for await (const chunk of stream) {
        const normalizedUsage = normalizeUsage(chunk.usage);
        const choice = chunk.choices[0];
        if (!choice) {
          // OpenAI may send a final usage-only chunk with no choices.
          if (normalizedUsage) {
            yield {
              type: 'message_delta',
              delta: {},
              usage: normalizedUsage,
            };
          }
          continue;
        }

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
                id: tc.id ?? `openai-tool-${idx}-${randomUUID().slice(0, 8)}`,
                name: tc.function?.name ?? '',
                argumentsJson: tc.function?.arguments ?? '',
                started: false,
              };
              toolAccumulators.set(idx, acc);
            }

            const acc = toolAccumulators.get(idx)!;

            // Accumulate id/name/arguments across chunks
            if (tc.id && !acc.started) acc.id = tc.id;
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
            usage: normalizedUsage,
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
        supportsThinking: false,
        supportsEffort: false,
        supportsStructuredOutput: true,
        supportsImages: true,
        supportsServerTools: false,
      },
      {
        value: 'gpt-4o-mini',
        displayName: 'GPT-4o Mini',
        description: 'Fast and cost-effective',
        supportsThinking: false,
        supportsEffort: false,
        supportsStructuredOutput: true,
        supportsImages: true,
        supportsServerTools: false,
      },
      {
        value: 'o3',
        displayName: 'o3',
        description: 'Advanced reasoning model',
        supportsThinking: false,
        supportsEffort: true,
        supportedEffortLevels: ['low', 'medium', 'high'],
        supportsStructuredOutput: true,
        supportsImages: true,
        supportsServerTools: false,
      },
      {
        value: 'o4-mini',
        displayName: 'o4-mini',
        description: 'Fast reasoning model',
        supportsThinking: false,
        supportsEffort: true,
        supportedEffortLevels: ['low', 'medium', 'high'],
        supportsStructuredOutput: true,
        supportsImages: true,
        supportsServerTools: false,
      },
    ];
  }

  async getCapabilities(model?: string) {
    const cap = model ? getModelCapability(model) : null;
    const modelSupportsThinking = cap?.supportsThinking ?? false;

    return {
      provider: this.name,
      ...(model ? { model } : {}),
      // Thinking: native when the model supports reasoning_effort, otherwise unsupported
      thinking: (modelSupportsThinking ? 'native' : 'unsupported') as 'native' | 'unsupported',
      // All OpenAI-compatible endpoints support JSON schema structured output
      structuredOutput: 'native' as const,
      toolUse: 'native' as const,
      serverTools: 'unsupported' as const,
      supportsAdaptiveThinking: false,
      // Effort levels only meaningful for thinking-capable models
      supportedEffortLevels: modelSupportsThinking
        ? (['low', 'medium', 'high'] as ('low' | 'medium' | 'high')[])
        : [],
    };
  }
}
