import type { LLMProvider, ChatOptions, Message, ContentBlock } from '@open-agent/providers';
import type { ToolDefinition, ToolContext } from '@open-agent/tools';
import type { ThinkingConfig } from './types.js';
import type { SDKMessage } from './types.js';
import { randomUUID } from 'crypto';

/**
 * Minimal interface for permission checking — implemented by PermissionEngine
 * from @open-agent/permissions, but defined here so core does not depend on
 * that package.
 */
export interface PermissionChecker {
  evaluate(request: { toolName: string; input: unknown }): { behavior: 'allow' | 'deny' | 'ask'; reason?: string };
  addRule(behavior: 'allow' | 'deny' | 'ask', rule: { toolName: string; ruleContent?: string }): void;
}

/**
 * Callback interface for prompting the user when a permission decision is
 * 'ask'.  Callers supply a concrete implementation (e.g. TerminalPermissionPrompter).
 */
export interface PermissionPrompter {
  prompt(request: { toolName: string; input: any; reason?: string }): Promise<'allow' | 'deny' | 'always'>;
}

// Hook executor interface — avoids a direct dependency on @open-agent/hooks.
// The caller supplies a compatible implementation (e.g. HookExecutor from
// @open-agent/hooks) when hook support is desired.
export interface LoopHookExecutor {
  execute(
    event: string,
    input: Record<string, unknown>,
    toolUseId?: string,
  ): Promise<{
    continue?: boolean;
    suppressOutput?: boolean;
    updatedInput?: Record<string, unknown>;
    additionalContext?: string;
    decision?: string;
  }>;
}

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
  permissionEngine?: PermissionChecker;
  permissionPrompter?: PermissionPrompter;
  hookExecutor?: LoopHookExecutor;
  compactThreshold?: number; // 触发压缩的估算 token 数，默认 100000
  costCalculator?: (model: string, inputTokens: number, outputTokens: number) => number;
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
    let totalCostUsd = 0;
    const allPermissionDenials: string[] = [];

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

      // Check if context needs compaction
      const threshold = this.options.compactThreshold ?? 100000;
      if (this.estimateTokens() > threshold) {
        await this.compact();
      }

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
          total_cost_usd: totalCostUsd,
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
              total_cost_usd: totalCostUsd,
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
          total_cost_usd: totalCostUsd,
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
      if (this.options.costCalculator && messageUsage) {
        totalCostUsd += this.options.costCalculator(
          this.options.model,
          messageUsage.input_tokens ?? 0,
          messageUsage.output_tokens ?? 0,
        );
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

        // ── Stop hook ───────────────────────────────────────────────────────
        if (this.options.hookExecutor) {
          await this.options.hookExecutor.execute('Stop', {
            stop_reason: 'end_turn',
            result: resultText,
          });
        }
        // ── End Stop hook ───────────────────────────────────────────────────

        yield {
          type: 'result',
          subtype: 'success',
          duration_ms: Date.now() - startTime,
          duration_api_ms: 0,
          is_error: false,
          num_turns: this.turnCount,
          result: resultText,
          stop_reason: 'end_turn',
          total_cost_usd: totalCostUsd,
          usage: { input_tokens: totalInputTokens, output_tokens: totalOutputTokens },
          modelUsage: {},
          permission_denials: allPermissionDenials,
          uuid: randomUUID(),
          session_id: sessionId,
        };
        return;
      }

      // Execute all requested tool calls sequentially and collect results.
      // Sequential execution avoids ordering ambiguity when tools share state
      // (e.g., file-system tools writing then reading the same path).
      const toolResults: ContentBlock[] = [];
      const permissionDenials: string[] = [];

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

        // ── Permission check ────────────────────────────────────────────────
        const { permissionEngine, permissionPrompter } = this.options;
        if (permissionEngine) {
          const decision = permissionEngine.evaluate({
            toolName: toolUse.name,
            input: toolUse.input,
          });

          if (decision.behavior === 'deny') {
            const reason = decision.reason ?? 'permission denied';
            permissionDenials.push(`${toolUse.name}: ${reason}`);
            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: `Permission denied: ${reason}`,
              is_error: true,
            });
            yield {
              type: 'tool_result' as const,
              tool_name: toolUse.name,
              tool_use_id: toolUse.id,
              result: `Permission denied: ${reason}`,
              is_error: true,
              uuid: randomUUID(),
              session_id: sessionId,
            };
            continue;
          }

          if (decision.behavior === 'ask') {
            if (!permissionPrompter) {
              // No prompter available — deny by default when mode requires confirmation.
              const reason = decision.reason ?? 'permission required but no prompter configured';
              permissionDenials.push(`${toolUse.name}: ${reason}`);
              toolResults.push({
                type: 'tool_result',
                tool_use_id: toolUse.id,
                content: `Permission denied: ${reason}`,
                is_error: true,
              });
              yield {
                type: 'tool_result' as const,
                tool_name: toolUse.name,
                tool_use_id: toolUse.id,
                result: `Permission denied: ${reason}`,
                is_error: true,
                uuid: randomUUID(),
                session_id: sessionId,
              };
              continue;
            }

            const userDecision = await permissionPrompter.prompt({
              toolName: toolUse.name,
              input: toolUse.input,
              reason: decision.reason,
            });

            if (userDecision === 'deny') {
              const reason = 'user denied permission';
              permissionDenials.push(`${toolUse.name}: ${reason}`);
              toolResults.push({
                type: 'tool_result',
                tool_use_id: toolUse.id,
                content: `Permission denied: ${reason}`,
                is_error: true,
              });
              yield {
                type: 'tool_result' as const,
                tool_name: toolUse.name,
                tool_use_id: toolUse.id,
                result: `Permission denied: ${reason}`,
                is_error: true,
                uuid: randomUUID(),
                session_id: sessionId,
              };
              continue;
            }

            if (userDecision === 'always') {
              // Persist an allow rule so this tool is pre-approved in future turns.
              permissionEngine.addRule('allow', { toolName: toolUse.name });
            }
            // 'allow' or 'always' — fall through to execute the tool.
          }
        }
        // ── End permission check ────────────────────────────────────────────

        // ── PreToolUse hook ─────────────────────────────────────────────────
        if (this.options.hookExecutor) {
          const hookResult = await this.options.hookExecutor.execute(
            'PreToolUse',
            { tool_name: toolUse.name, tool_input: toolUse.input },
            toolUse.id,
          );

          if (hookResult.continue === false) {
            // Hook blocked the tool execution.
            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: hookResult.decision ?? 'Blocked by hook',
              is_error: true,
            });
            continue;
          }

          // Allow the hook to mutate the tool input before execution.
          if (hookResult.updatedInput) {
            toolUse.input = { ...(toolUse.input as Record<string, unknown>), ...hookResult.updatedInput };
          }
        }
        // ── End PreToolUse hook ─────────────────────────────────────────────

        const toolCtx: ToolContext = {
          cwd: this.options.cwd,
          abortSignal: this.options.abortSignal,
          sessionId: this.options.sessionId,
        };

        try {
          const result = await tool.execute(toolUse.input, toolCtx);
          const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: resultStr,
          });
          yield {
            type: 'tool_result' as const,
            tool_name: toolUse.name,
            tool_use_id: toolUse.id,
            result: resultStr.slice(0, 500),
            is_error: false,
            uuid: randomUUID(),
            session_id: sessionId,
          };

          // ── PostToolUse hook (success) ────────────────────────────────────
          if (this.options.hookExecutor) {
            await this.options.hookExecutor.execute(
              'PostToolUse',
              {
                tool_name: toolUse.name,
                tool_input: toolUse.input,
                tool_result: resultStr,
              },
              toolUse.id,
            );
          }
          // ── End PostToolUse hook ──────────────────────────────────────────
        } catch (error: unknown) {
          const msg = error instanceof Error ? error.message : String(error);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: `Error: ${msg}`,
            is_error: true,
          });
          yield {
            type: 'tool_result' as const,
            tool_name: toolUse.name,
            tool_use_id: toolUse.id,
            result: msg,
            is_error: true,
            uuid: randomUUID(),
            session_id: sessionId,
          };
        }
      }

      // Accumulate permission denials across all turns for the final result.
      allPermissionDenials.push(...permissionDenials);

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

  /** Update the model used for subsequent LLM calls. */
  setModel(model: string): void {
    this.options.model = model;
  }

  /** Update the thinking configuration. */
  setThinking(thinking: ThinkingConfig): void {
    this.options.thinking = thinking;
  }

  /** 估算消息列表的总 token 数（按字符数/4粗略估算） */
  private estimateTokens(): number {
    let chars = 0;
    for (const msg of this.messages) {
      if (typeof msg.content === 'string') {
        chars += msg.content.length;
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'text') chars += ((block as any).text ?? '').length;
          else if (block.type === 'thinking') chars += ((block as any).thinking ?? '').length;
          else if (block.type === 'tool_use') chars += JSON.stringify((block as any).input ?? {}).length;
          else if (block.type === 'tool_result') chars += (typeof (block as any).content === 'string' ? (block as any).content.length : JSON.stringify((block as any).content ?? '').length);
        }
      }
    }
    return Math.ceil(chars / 4);
  }

  /** 压缩对话历史：用 LLM 生成摘要替换旧消息 */
  private async compact(): Promise<void> {
    if (this.messages.length <= 4) return; // 太短不压缩

    // 保留最后 2 轮（4 条消息）
    const keepCount = 4;
    const toSummarize = this.messages.slice(0, -keepCount);
    const toKeep = this.messages.slice(-keepCount);

    // 用 LLM 生成摘要
    const summaryPrompt = `Summarize the following conversation history in a concise manner, preserving key decisions, code changes, and context:\n\n${toSummarize.map(m => `[${m.role}]: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content).slice(0, 500)}`).join('\n\n')}`;

    let summaryText = '';
    try {
      for await (const event of this.options.provider.chat(
        [{ role: 'user', content: summaryPrompt }],
        { model: this.options.model, maxTokens: 2048, systemPrompt: 'You are a conversation summarizer. Be concise but preserve important details.' }
      )) {
        if (event.type === 'text_delta') {
          summaryText += event.text;
        }
      }
    } catch {
      // If summarization fails, just truncate without summary
      summaryText = '[Previous conversation history was compacted]';
    }

    this.messages = [
      { role: 'user', content: `[Conversation Summary]\n${summaryText}` },
      { role: 'assistant', content: [{ type: 'text', text: 'I understand the context. Let me continue helping you.' }] },
      ...toKeep,
    ];
  }
}
