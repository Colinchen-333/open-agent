import type { LLMProvider, ChatOptions, Message, ContentBlock } from '@open-agent/providers';
import type { ToolDefinition, ToolContext } from '@open-agent/tools';
import type { ThinkingConfig } from './types.js';
import type { SDKMessage } from './types.js';
import { randomUUID } from 'crypto';

export interface ConversationLoopOptions {
  provider: LLMProvider;
  tools: Map<string, ToolDefinition>;
  model: string;
  systemPrompt?: string;
  maxTurns?: number;
  maxTokens?: number;
  thinking?: ThinkingConfig;
  effort?: 'low' | 'medium' | 'high' | 'max';
  cwd: string;
  sessionId: string;
  abortSignal?: AbortSignal;
}

// Internal marker type for tracking open content blocks during accumulation.
// The `_closed` flag is stripped before the block is stored in message history.
type AccumulatingBlock = ContentBlock & { _closed?: boolean };

export class ConversationLoop {
  private messages: Message[] = [];
  private options: ConversationLoopOptions;
  private turnCount = 0;

  constructor(options: ConversationLoopOptions) {
    this.options = options;
  }

  /**
   * Process a user message and stream back SDK messages for every significant
   * event in the agent loop (stream events, assistant turns, tool results,
   * and the final result/error).
   *
   * The generator runs until either:
   *   - The LLM returns a response with no tool_use blocks (success), or
   *   - maxTurns is exceeded, or
   *   - The abort signal fires, or
   *   - The provider throws an error.
   */
  async *run(userMessage: string): AsyncGenerator<SDKMessage> {
    const sessionId = this.options.sessionId;
    const startTime = Date.now();
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    // Append the user message to local history and emit it as an SDKUserMessage.
    this.messages.push({ role: 'user', content: userMessage });
    yield {
      type: 'user',
      message: { role: 'user', content: userMessage },
      parent_tool_use_id: null,
      uuid: randomUUID(),
      session_id: sessionId,
    };

    // Main agent loop — each iteration is one LLM call (one "turn").
    while (true) {
      this.turnCount++;

      // Guard: respect the caller-provided turn limit.
      if (this.options.maxTurns !== undefined && this.turnCount > this.options.maxTurns) {
        yield {
          type: 'result',
          subtype: 'error_max_turns',
          duration_ms: Date.now() - startTime,
          duration_api_ms: 0,
          is_error: true,
          num_turns: this.turnCount,
          stop_reason: 'max_turns',
          total_cost_usd: 0,
          usage: { input_tokens: totalInputTokens, output_tokens: totalOutputTokens },
          modelUsage: {},
          permission_denials: [],
          errors: ['Max turns exceeded'],
          uuid: randomUUID(),
          session_id: sessionId,
        };
        return;
      }

      // Build the tool spec list from the registered tools map.
      const toolSpecs = Array.from(this.options.tools.values()).map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
      }));

      const chatOptions: ChatOptions = {
        model: this.options.model,
        maxTokens: this.options.maxTokens ?? 16384,
        tools: toolSpecs.length > 0 ? toolSpecs : undefined,
        thinking: this.options.thinking,
        effort: this.options.effort,
        systemPrompt: this.options.systemPrompt,
      };

      // Accumulate content blocks as the stream arrives.
      let assistantContent: AccumulatingBlock[] = [];
      // Tracks the currently-streaming tool_use block while its JSON input is
      // being delivered via tool_use_delta events.
      let currentToolUse: { id: string; name: string; input: string } | null = null;
      let messageUsage: any = null;

      try {
        for await (const event of this.options.provider.chat(this.messages, chatOptions)) {
          // Honour abort requests as promptly as possible.
          if (this.options.abortSignal?.aborted) {
            yield {
              type: 'result',
              subtype: 'error_during_execution',
              duration_ms: Date.now() - startTime,
              duration_api_ms: 0,
              is_error: true,
              num_turns: this.turnCount,
              stop_reason: 'interrupted',
              total_cost_usd: 0,
              usage: { input_tokens: totalInputTokens, output_tokens: totalOutputTokens },
              modelUsage: {},
              permission_denials: [],
              errors: ['Interrupted'],
              uuid: randomUUID(),
              session_id: sessionId,
            };
            return;
          }

          // Re-emit every raw stream event so callers can render incremental output.
          yield {
            type: 'stream_event',
            event,
            parent_tool_use_id: null,
            uuid: randomUUID(),
            session_id: sessionId,
          };

          // Update the in-progress content accumulation based on the event type.
          switch (event.type) {
            case 'text_delta': {
              // Append to the most recent open text block, or start a new one.
              let textBlock = assistantContent
                .slice()
                .reverse()
                .find((b) => b.type === 'text' && !b._closed);
              if (!textBlock) {
                textBlock = { type: 'text', text: '', _closed: false };
                assistantContent.push(textBlock);
              }
              (textBlock as any).text += event.text;
              break;
            }

            case 'thinking_delta': {
              let thinkBlock = assistantContent
                .slice()
                .reverse()
                .find((b) => b.type === 'thinking' && !b._closed);
              if (!thinkBlock) {
                thinkBlock = { type: 'thinking', thinking: '', _closed: false };
                assistantContent.push(thinkBlock);
              }
              (thinkBlock as any).thinking += event.thinking;
              break;
            }

            case 'tool_use_start': {
              // A new tool_use block begins — close any open text/thinking blocks
              // so subsequent text_delta events start fresh blocks.
              for (const b of assistantContent) {
                if (b.type === 'text' || b.type === 'thinking') {
                  b._closed = true;
                }
              }
              currentToolUse = { id: event.id, name: event.name, input: '' };
              break;
            }

            case 'tool_use_delta': {
              // Accumulate the partial JSON input for the active tool_use block.
              if (currentToolUse) {
                currentToolUse.input += event.partial_json;
              }
              break;
            }

            case 'tool_use_end': {
              if (currentToolUse) {
                let parsedInput: Record<string, unknown> = {};
                try {
                  parsedInput = JSON.parse(currentToolUse.input || '{}');
                } catch {
                  // Leave parsedInput as {} if JSON is malformed — the tool
                  // implementation should handle missing fields gracefully.
                }
                assistantContent.push({
                  type: 'tool_use',
                  id: currentToolUse.id,
                  name: currentToolUse.name,
                  input: parsedInput,
                });
                currentToolUse = null;
              }
              break;
            }

            case 'message_end': {
              messageUsage = event.usage ?? null;
              break;
            }

            // Other event types (message_start, content_block_*, error) are
            // forwarded via stream_event above but require no content accumulation.
          }
        }
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        yield {
          type: 'result',
          subtype: 'error_during_execution',
          duration_ms: Date.now() - startTime,
          duration_api_ms: 0,
          is_error: true,
          num_turns: this.turnCount,
          stop_reason: 'error',
          total_cost_usd: 0,
          usage: { input_tokens: totalInputTokens, output_tokens: totalOutputTokens },
          modelUsage: {},
          permission_denials: [],
          errors: [msg],
          uuid: randomUUID(),
          session_id: sessionId,
        };
        return;
      }

      // Update cumulative token counts from this turn's usage.
      if (messageUsage) {
        totalInputTokens += messageUsage.input_tokens ?? 0;
        totalOutputTokens += messageUsage.output_tokens ?? 0;
      }

      // Strip the internal `_closed` marker before storing / emitting.
      const cleanContent: ContentBlock[] = assistantContent.map(({ _closed, ...rest }) => rest);

      // Persist the assistant turn in local conversation history.
      this.messages.push({ role: 'assistant', content: cleanContent });

      // Emit the fully-assembled assistant message.
      yield {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: cleanContent,
          model: this.options.model,
          usage: messageUsage ?? undefined,
        },
        parent_tool_use_id: null,
        uuid: randomUUID(),
        session_id: sessionId,
      };

      // Determine whether the model requested any tool calls.
      const toolUses = cleanContent.filter((b) => b.type === 'tool_use');

      if (toolUses.length === 0) {
        // No tool calls — the model has finished. Extract the final text and
        // emit a success result.
        const resultText = cleanContent
          .filter((b) => b.type === 'text')
          .map((b: any) => b.text as string)
          .join('');

        yield {
          type: 'result',
          subtype: 'success',
          duration_ms: Date.now() - startTime,
          duration_api_ms: 0,
          is_error: false,
          num_turns: this.turnCount,
          result: resultText,
          stop_reason: 'end_turn',
          total_cost_usd: 0,
          usage: { input_tokens: totalInputTokens, output_tokens: totalOutputTokens },
          modelUsage: {},
          permission_denials: [],
          uuid: randomUUID(),
          session_id: sessionId,
        };
        return;
      }

      // Execute all requested tool calls sequentially and collect results.
      // Sequential execution avoids ordering ambiguity when tools share state
      // (e.g., file-system tools writing then reading the same path).
      const toolResults: ContentBlock[] = [];

      for (const toolUse of toolUses) {
        const tool = this.options.tools.get(toolUse.name);

        if (!tool) {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: `Error: Tool '${toolUse.name}' not found`,
            is_error: true,
          });
          continue;
        }

        const toolCtx: ToolContext = {
          cwd: this.options.cwd,
          abortSignal: this.options.abortSignal,
          sessionId: this.options.sessionId,
        };

        try {
          const result = await tool.execute(toolUse.input, toolCtx);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: typeof result === 'string' ? result : JSON.stringify(result),
          });
        } catch (error: unknown) {
          const msg = error instanceof Error ? error.message : String(error);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: `Error: ${msg}`,
            is_error: true,
          });
        }
      }

      // Feed the tool results back as a user message so the LLM can continue.
      this.messages.push({ role: 'user', content: toolResults });

      // Loop back to call the LLM again with the updated conversation history.
    }
  }

  /** Return a snapshot of the current conversation history. */
  getMessages(): Message[] {
    return [...this.messages];
  }

  /** Return the number of LLM turns executed so far. */
  getTurnCount(): number {
    return this.turnCount;
  }
}
