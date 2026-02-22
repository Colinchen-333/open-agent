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
  /** Pre-populate conversation history when resuming a session. */
  initialMessages?: Message[];
}

// Internal marker type for tracking open content blocks during accumulation.
// The `_closed` flag is stripped before the block is stored in message history.
type AccumulatingBlock = ContentBlock & { _closed?: boolean };

export class ConversationLoop {
  private messages: Message[] = [];
  private options: ConversationLoopOptions;
  private turnCount = 0;
  // Cumulative cost counters — accumulate across multiple run() calls.
  private _totalInputTokens = 0;
  private _totalOutputTokens = 0;
  private _totalCostUsd = 0;

  constructor(options: ConversationLoopOptions) {
    this.options = options;
    // Restore prior conversation history when resuming a session.
    if (options.initialMessages && options.initialMessages.length > 0) {
      this.messages = [...options.initialMessages];
    }
  }

  /**
   * Return the cumulative cost and token usage across all run() calls in this
   * session. Useful for /cost slash commands and end-of-session reporting.
   */
  getTotalCost(): { totalCostUsd: number; totalInputTokens: number; totalOutputTokens: number } {
    return {
      totalCostUsd: this._totalCostUsd,
      totalInputTokens: this._totalInputTokens,
      totalOutputTokens: this._totalOutputTokens,
    };
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
    // Per-run counters track only this invocation; instance-level counters
    // accumulate the full session totals.
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
        for await (const event of this.chatWithRetry(this.messages, chatOptions)) {
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
        const inTok = messageUsage.input_tokens ?? 0;
        const outTok = messageUsage.output_tokens ?? 0;
        totalInputTokens += inTok;
        totalOutputTokens += outTok;
        this._totalInputTokens += inTok;
        this._totalOutputTokens += outTok;
      }
      if (this.options.costCalculator && messageUsage) {
        const turnCost = this.options.costCalculator(
          this.options.model,
          messageUsage.input_tokens ?? 0,
          messageUsage.output_tokens ?? 0,
        );
        totalCostUsd += turnCost;
        this._totalCostUsd += turnCost;
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

      // Emit a per-turn cost/token summary so the renderer can display it.
      if (messageUsage) {
        const turnCost = this.options.costCalculator
          ? this.options.costCalculator(
              this.options.model,
              messageUsage.input_tokens ?? 0,
              messageUsage.output_tokens ?? 0,
            )
          : 0;
        yield {
          type: 'system' as const,
          subtype: 'status' as const,
          status: null,
          uuid: randomUUID(),
          session_id: sessionId,
          // Extra fields for the per-turn cost display (carried as extra properties
          // and consumed by the renderer via type-cast).
          turn_cost: turnCost,
          turn_input_tokens: messageUsage.input_tokens ?? 0,
          turn_output_tokens: messageUsage.output_tokens ?? 0,
          cumulative_cost: this._totalCostUsd,
        } as any;
      }

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

      // Execute all requested tool calls with a two-phase approach:
      //   Phase 1 — Permission checks run serially so the user approves one
      //             tool at a time (avoids interleaved permission prompts).
      //   Phase 2 — All approved tools execute concurrently via Promise.all
      //             for performance, matching Claude Code behaviour.
      //   Phase 3 — Yield results in original call order for determinism.
      const toolResults: ContentBlock[] = [];
      const permissionDenials: string[] = [];

      // Approved tools collected during Phase 1, preserving call order.
      type ApprovedEntry = { toolUse: ContentBlock & { id: string; name: string; input: any }; tool: ToolDefinition };
      const approvedTools: ApprovedEntry[] = [];

      // ── Phase 1: Serial permission checks ────────────────────────────────
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

        // ── Permission check ───────────────────────────────────────────────
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
            // 'allow' or 'always' — fall through to queue the tool.
          }
        }
        // ── End permission check ───────────────────────────────────────────

        approvedTools.push({ toolUse: toolUse as ApprovedEntry['toolUse'], tool });
      }
      // ── End Phase 1 ───────────────────────────────────────────────────────

      // ── Phase 2: Parallel execution of all approved tools ─────────────────
      type ExecutionResult = {
        toolUse: ApprovedEntry['toolUse'];
        resultStr: string;
        isError: boolean;
        blocked: boolean;
        blockReason?: string;
        isImageResult?: boolean;
      };

      const parallelResults: ExecutionResult[] = await Promise.all(
        approvedTools.map(async ({ toolUse, tool }): Promise<ExecutionResult> => {
          const toolCtx: ToolContext = {
            cwd: this.options.cwd,
            abortSignal: this.options.abortSignal,
            sessionId: this.options.sessionId,
          };

          // ── PreToolUse hook ──────────────────────────────────────────────
          if (this.options.hookExecutor) {
            const hookResult = await this.options.hookExecutor.execute(
              'PreToolUse',
              { tool_name: toolUse.name, tool_input: toolUse.input },
              toolUse.id,
            );

            if (hookResult.continue === false) {
              return {
                toolUse,
                resultStr: hookResult.decision ?? 'Blocked by hook',
                isError: true,
                blocked: true,
                blockReason: hookResult.decision ?? 'Blocked by hook',
              };
            }

            // Allow the hook to mutate the tool input before execution.
            if (hookResult.updatedInput) {
              toolUse.input = { ...(toolUse.input as Record<string, unknown>), ...hookResult.updatedInput };
            }
          }
          // ── End PreToolUse hook ──────────────────────────────────────────

          try {
            const result = await tool.execute(toolUse.input, toolCtx);
            const resultStr = typeof result === 'string' ? result : JSON.stringify(result);

            // ── PostToolUse hook (success) ───────────────────────────────
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
            // ── End PostToolUse hook ─────────────────────────────────────

            // Check if the result is a structured image content block.
            // When the Read tool returns base64 image data, we want the LLM
            // to receive it as an actual image block rather than a JSON string
            // so vision capabilities are properly exercised.
            let isImageResult = false;
            try {
              const parsed = JSON.parse(resultStr);
              if (
                parsed?.type === 'image' &&
                parsed?.source?.type === 'base64' &&
                typeof parsed?.source?.media_type === 'string' &&
                typeof parsed?.source?.data === 'string'
              ) {
                isImageResult = true;
              }
            } catch {
              // Not JSON — not an image result
            }

            return { toolUse, resultStr, isError: false, blocked: false, isImageResult };
          } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            return { toolUse, resultStr: msg, isError: true, blocked: false, isImageResult: false };
          }
        }),
      );
      // ── End Phase 2 ───────────────────────────────────────────────────────

      // ── Phase 3: Yield results in original call order ─────────────────────
      for (const { toolUse, resultStr, isError, blocked, isImageResult } of parallelResults) {
        if (blocked) {
          // Pre-hook blocked execution — surface as an error result.
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: resultStr,
            is_error: true,
          });
          continue;
        }

        if (isError) {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: `Error: ${resultStr}`,
            is_error: true,
          });
          yield {
            type: 'tool_result' as const,
            tool_name: toolUse.name,
            tool_use_id: toolUse.id,
            result: resultStr,
            is_error: true,
            uuid: randomUUID(),
            session_id: sessionId,
          };
        } else if (isImageResult) {
          // Parse the structured image result and send it as actual image
          // content blocks so the LLM can visually inspect the image.
          const parsed = JSON.parse(resultStr) as {
            type: 'image';
            source: { type: 'base64'; media_type: string; data: string };
            file_path?: string;
          };
          const imageContentBlocks: ContentBlock[] = [
            {
              type: 'image',
              media_type: parsed.source.media_type,
              data: parsed.source.data,
            },
            {
              type: 'text',
              text: `Image: ${parsed.file_path ?? 'unknown'}`,
            },
          ];
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: imageContentBlocks,
          });
          yield {
            type: 'tool_result' as const,
            tool_name: toolUse.name,
            tool_use_id: toolUse.id,
            result: `[Image: ${parsed.file_path ?? 'unknown'}]`,
            is_error: false,
            uuid: randomUUID(),
            session_id: sessionId,
          };
        } else {
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
        }
      }
      // ── End Phase 3 ───────────────────────────────────────────────────────

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

  /**
   * Replace the abort signal used for the next (and subsequent) LLM calls.
   * Call this before each user prompt in REPL mode so that a prior Ctrl+C
   * abort does not permanently poison the loop.
   */
  setAbortSignal(signal: AbortSignal): void {
    this.options.abortSignal = signal;
  }

  /**
   * Wrap provider.chat() with exponential backoff retry logic.
   *
   * Retries up to 5 times on transient network/rate-limit errors.
   * Each successive delay doubles (1 s → 2 s → 4 s → … up to 60 s),
   * with ±50 % random jitter to prevent thundering-herd reconnections.
   */
  private async *chatWithRetry(
    messages: Message[],
    options: ChatOptions,
  ): AsyncGenerator<import('@open-agent/providers').StreamEvent> {
    const maxRetries = 5;
    let delay = 1000;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        yield* this.options.provider.chat(messages, options);
        return;
      } catch (error: unknown) {
        const isRetryable = this.isRetryableError(error);
        if (!isRetryable || attempt === maxRetries) throw error;

        // Jitter: uniform random in [0, delay * 0.5]
        const jitter = Math.random() * delay * 0.5;
        await new Promise<void>((resolve) => setTimeout(resolve, delay + jitter));
        delay = Math.min(delay * 2, 60_000);
      }
    }
  }

  /**
   * Return true when the error is a transient condition that can be safely
   * retried (rate limits, server overload, network resets, timeouts).
   */
  private isRetryableError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const msg = error.message.toLowerCase();
    return (
      msg.includes('429') ||
      msg.includes('rate limit') ||
      msg.includes('529') ||
      msg.includes('overloaded') ||
      msg.includes('503') ||
      msg.includes('timeout') ||
      msg.includes('econnreset') ||
      msg.includes('network')
    );
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

  /** Compact conversation history by summarising older messages with the LLM. */
  private async compact(): Promise<void> {
    // Keep the last 6 messages (3 turns) — enough to preserve immediate context
    // while still meaningfully reducing the window size.
    if (this.messages.length <= 6) return;

    const keepCount = 6;
    const toSummarize = this.messages.slice(0, -keepCount);
    const toKeep = this.messages.slice(-keepCount);

    // Build the summarisation prompt with the messages we are compacting.
    const historyText = toSummarize
      .map(m => `[${m.role}]: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content).slice(0, 800)}`)
      .join('\n\n');

    const summaryPrompt =
      `Summarize this conversation history concisely. Preserve:\n` +
      `- All file paths that were read, created, or modified\n` +
      `- Key technical decisions and their rationale\n` +
      `- Current task status and what remains to be done\n` +
      `- Any errors encountered and how they were resolved\n` +
      `Be factual and specific. Do not add commentary.\n\n` +
      `Conversation history:\n\n${historyText}`;

    let summaryText = '';
    try {
      for await (const event of this.options.provider.chat(
        [{ role: 'user', content: summaryPrompt }],
        {
          model: this.options.model,
          maxTokens: 2048,
          systemPrompt: 'You are a conversation summarizer. Be concise but preserve important technical details.',
        },
      )) {
        if (event.type === 'text_delta') {
          summaryText += event.text;
        }
      }
    } catch {
      // If summarisation fails, fall back to a minimal placeholder so the loop
      // can continue without losing the kept messages entirely.
      summaryText = '[Previous conversation history was compacted due to context length.]';
    }

    // Inject the summary as a user message so that the assistant turn that
    // follows (the first of toKeep) has a consistent role alternation.
    this.messages = [
      {
        role: 'user',
        content: `[Conversation context was compacted. Summary of prior conversation:]\n\n${summaryText}`,
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Understood. I have the context from our previous conversation. How can I continue helping?' }],
      },
      ...toKeep,
    ];
  }
}
