import type { ModelInfo } from '@open-agent/core';
import type {
  ChatOptions,
  ContentBlock,
  LLMProvider,
  Message,
  StreamEvent,
  ToolSpec,
} from './types.js';

// Ollama chat message format
interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  images?: string[]; // base64-encoded images for multimodal models
  tool_calls?: OllamaToolCall[];
}

interface OllamaToolCall {
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

interface OllamaToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

// Streaming NDJSON chunk from Ollama /api/chat
interface OllamaChatChunk {
  model: string;
  created_at: string;
  message?: {
    role: string;
    content: string;
    tool_calls?: OllamaToolCall[];
  };
  done: boolean;
  done_reason?: string;
  total_duration?: number;
  prompt_eval_count?: number;
  eval_count?: number;
}

// Ollama model info from /api/tags
interface OllamaModelEntry {
  name: string;
  modified_at: string;
  size: number;
}

// Convert unified Message[] to Ollama message format.
// tool_result blocks become role:'tool' messages; tool_use blocks are folded into assistant content.
function convertMessages(messages: Message[]): OllamaMessage[] {
  const result: OllamaMessage[] = [];

  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      result.push({ role: msg.role, content: msg.content });
      continue;
    }

    const blocks = msg.content as ContentBlock[];

    if (msg.role === 'user') {
      // Separate tool_result blocks from regular content
      const images: string[] = [];
      const textParts: string[] = [];
      const toolResults: OllamaMessage[] = [];

      for (const block of blocks) {
        if (block.type === 'tool_result') {
          const content =
            typeof block.content === 'string'
              ? block.content
              : JSON.stringify(block.content);
          toolResults.push({ role: 'tool', content });
        } else if (block.type === 'text') {
          textParts.push(block.text as string);
        } else if (block.type === 'image') {
          images.push(block.data as string);
        }
      }

      if (textParts.length > 0 || images.length > 0) {
        const userMsg: OllamaMessage = {
          role: 'user',
          content: textParts.join('\n'),
        };
        if (images.length > 0) userMsg.images = images;
        result.push(userMsg);
      }

      result.push(...toolResults);
      continue;
    }

    if (msg.role === 'assistant') {
      const textParts: string[] = [];
      const toolCalls: OllamaToolCall[] = [];

      for (const block of blocks) {
        if (block.type === 'text') {
          textParts.push(block.text as string);
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            function: {
              name: block.name as string,
              arguments:
                typeof block.input === 'object' && block.input !== null
                  ? (block.input as Record<string, unknown>)
                  : {},
            },
          });
        }
        // thinking and image blocks are dropped — Ollama doesn't support them
      }

      const assistantMsg: OllamaMessage = {
        role: 'assistant',
        content: textParts.join('\n'),
      };
      if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls;
      result.push(assistantMsg);
      continue;
    }

    // system
    const text = blocks
      .filter((b) => b.type === 'text')
      .map((b) => b.text as string)
      .join('\n');
    result.push({ role: msg.role, content: text });
  }

  return result;
}

// Convert ToolSpec[] to Ollama tool definition format.
function convertTools(tools: ToolSpec[]): OllamaToolDefinition[] {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));
}

export class OllamaProvider implements LLMProvider {
  readonly name = 'ollama';
  private baseURL: string;

  constructor(options?: { baseURL?: string }) {
    this.baseURL = options?.baseURL ?? process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
  }

  async *chat(
    messages: Message[],
    options: ChatOptions,
  ): AsyncGenerator<StreamEvent> {
    try {
      const ollamaMessages = convertMessages(messages);

      // Ollama accepts a top-level system field in addition to system role messages
      const systemMsg = messages.find((m) => m.role === 'system');
      const systemPrompt =
        options.systemPrompt ??
        (systemMsg
          ? typeof systemMsg.content === 'string'
            ? systemMsg.content
            : (systemMsg.content as ContentBlock[])
                .filter((b) => b.type === 'text')
                .map((b) => b.text as string)
                .join('\n')
          : undefined);

      const tools =
        options.tools && options.tools.length > 0
          ? convertTools(options.tools)
          : undefined;

      const body: Record<string, unknown> = {
        model: options.model,
        messages: ollamaMessages,
        stream: true,
        ...(tools ? { tools } : {}),
        options: {
          ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
          ...(options.topP !== undefined ? { top_p: options.topP } : {}),
          ...(options.maxTokens !== undefined ? { num_predict: options.maxTokens } : {}),
          ...(options.stopSequences ? { stop: options.stopSequences } : {}),
        },
      };

      if (systemPrompt) {
        body.system = systemPrompt;
      }

      const response = await fetch(`${this.baseURL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorText = await response.text();
        yield {
          type: 'error',
          error: {
            message: `Ollama API error ${response.status}: ${errorText}`,
            status: response.status,
          },
        };
        return;
      }

      if (!response.body) {
        yield { type: 'error', error: { message: 'Ollama response has no body' } };
        return;
      }

      // Emit synthetic message_start
      yield { type: 'message_start', message: { model: options.model } };

      // Track tool call accumulation across chunks
      const toolCallAccumulators = new Map<
        string,
        { name: string; argumentsJson: string; started: boolean }
      >();

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Split on newlines — Ollama sends NDJSON
        const lines = buffer.split('\n');
        // The last element may be an incomplete line; keep it in the buffer
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          let chunk: OllamaChatChunk;
          try {
            chunk = JSON.parse(trimmed) as OllamaChatChunk;
          } catch {
            // Malformed line — skip
            continue;
          }

          const msgContent = chunk.message?.content;

          // Text delta
          if (msgContent) {
            yield { type: 'text_delta', text: msgContent };
          }

          // Tool calls (non-streaming tool responses come in a single done=true chunk)
          if (chunk.message?.tool_calls) {
            for (const tc of chunk.message.tool_calls) {
              const name = tc.function.name;
              const argsJson = JSON.stringify(tc.function.arguments);
              const id = `ollama-tool-${name}-${Date.now()}`;

              yield { type: 'tool_use_start', id, name };
              yield { type: 'tool_use_delta', id, partial_json: argsJson };
              yield { type: 'tool_use_end', id };
            }
          }

          if (chunk.done) {
            // Flush any leftover tool accumulators
            for (const [id, acc] of toolCallAccumulators) {
              if (acc.started) {
                yield { type: 'tool_use_end', id };
              }
            }

            yield {
              type: 'message_end',
              message: {
                model: chunk.model,
                done_reason: chunk.done_reason,
              },
              usage: {
                prompt_tokens: chunk.prompt_eval_count,
                completion_tokens: chunk.eval_count,
              },
            };
          }
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
    try {
      const response = await fetch(`${this.baseURL}/api/tags`);
      if (!response.ok) return [];

      const data = (await response.json()) as { models: OllamaModelEntry[] };
      return (data.models ?? []).map((m) => ({
        value: m.name,
        displayName: m.name,
        description: `Ollama local model (${formatBytes(m.size)})`,
        supportsEffort: false,
      }));
    } catch {
      return [];
    }
  }
}

function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)}GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)}MB`;
  return `${bytes}B`;
}
