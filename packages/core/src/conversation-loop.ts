import type { LLMProvider, ChatOptions, Message, ContentBlock, ServerToolSpec } from '@open-agent/providers';
import type { ToolDefinition, ToolContext } from '@open-agent/tools';
import type { ThinkingConfig } from './types.js';
import type { SDKMessage } from './types.js';
import type { PermissionDenial } from './types.js';
import type { AppState } from '@open-agent/state';
import { randomUUID } from 'crypto';
import { basename } from 'path';
import { SessionManager } from './session-manager.js';
import { StreamingToolExecutor } from './tool-executor.js';

/**
 * Minimal interface for permission checking — implemented by PermissionEngine
 * from @open-agent/permissions, but defined here so core does not depend on
 * that package.
 */
export interface PermissionChecker {
  evaluate(
    request: {
      toolName: string;
      input: unknown;
      toolUseId?: string;
      metadata?: {
        readOnly?: boolean;
        destructive?: boolean;
        openWorld?: boolean;
        source?: 'builtin' | 'dynamic' | 'mcp';
        serverName?: string;
        capability?: {
          category?: string;
          risk?: 'low' | 'medium' | 'high';
          needsWorkspaceWrite?: boolean;
        };
      };
    },
  ): { behavior: 'allow' | 'deny' | 'ask'; reason?: string } | Promise<{ behavior: 'allow' | 'deny' | 'ask'; reason?: string }>;
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
    reason?: string;
    permissionDecision?: 'allow' | 'deny' | 'ask';
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
  costCalculator?: (model: string, inputTokens: number, outputTokens: number, cacheCreationTokens?: number, cacheReadTokens?: number) => number;
  /** Pre-populate conversation history when resuming a session. */
  initialMessages?: Message[];
  /** Structured output format — passed through to the provider. */
  responseFormat?: { type: 'json_schema'; schema: Record<string, unknown> };
  /** Server-side tools (e.g. Anthropic native web search) — executed by the provider, not locally. */
  serverTools?: ServerToolSpec[];
  /** Reactive state store — getter. */
  getAppState?: () => AppState;
  /** Reactive state store — updater. */
  setAppState?: (updater: (prev: AppState) => AppState) => void;
}

// Internal marker type for tracking open content blocks during accumulation.
// The `_closed` flag is stripped before the block is stored in message history.
type AccumulatingBlock = ContentBlock & { _closed?: boolean };

function normalizeTokenUsage(usage: unknown): Record<string, number> {
  if (!usage || typeof usage !== 'object') {
    return {};
  }
  const raw = usage as Record<string, unknown>;
  const toNum = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined;

  const inputTokens = toNum(raw.input_tokens) ?? toNum(raw.prompt_tokens) ?? 0;
  const outputTokens = toNum(raw.output_tokens) ?? toNum(raw.completion_tokens) ?? 0;

  const normalized: Record<string, number> = {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
  };

  const cacheCreate = toNum(raw.cache_creation_input_tokens);
  if (cacheCreate !== undefined) {
    normalized.cache_creation_input_tokens = cacheCreate;
  }
  const cacheRead = toNum(raw.cache_read_input_tokens);
  if (cacheRead !== undefined) {
    normalized.cache_read_input_tokens = cacheRead;
  }
  return normalized;
}

function normalizePermissionDenialInput(input: unknown): Record<string, unknown> {
  // Keep backward-compatible shape for object inputs while guaranteeing
  // the SDK PermissionDenial contract (tool_input is always an object).
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return {};
  }
  return input as Record<string, unknown>;
}

interface ToolUseSummaryEntry {
  toolName: string;
  toolUseId: string;
  input: unknown;
  result: string;
  isError: boolean;
}

function truncateSummaryText(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function summarizeToolFile(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const record = input as Record<string, unknown>;
  const filePath = typeof record.file_path === 'string'
    ? record.file_path
    : typeof record.notebook_path === 'string'
      ? record.notebook_path
      : null;
  return filePath ? basename(filePath) : null;
}

function summarizeSingleToolUse(
  entry: ToolUseSummaryEntry,
  resolveTool?: (toolName: string) => ToolDefinition | undefined,
): string {
  const tool = resolveTool?.(entry.toolName);
  try {
    const customSummary = tool?.getToolUseSummary?.(entry.input, entry.result, entry.isError);
    if (customSummary && customSummary.trim()) {
      return truncateSummaryText(customSummary.trim(), 60);
    }
  } catch {
    // Fall back to built-in heuristics.
  }

  const file = summarizeToolFile(entry.input);
  const input = (entry.input && typeof entry.input === 'object')
    ? entry.input as Record<string, unknown>
    : {};

  switch (entry.toolName) {
    case 'Read':
      return `Read ${file ?? 'file'}`;
    case 'Edit':
      return `Edited ${file ?? 'file'}`;
    case 'Write':
      return `Wrote ${file ?? 'file'}`;
    case 'NotebookEdit':
      return `Edited ${file ?? 'notebook'}`;
    case 'Glob':
      return `Matched ${truncateSummaryText(String(input.pattern ?? 'files'), 40)}`;
    case 'Grep':
      return `Searched ${truncateSummaryText(String(input.pattern ?? 'codebase'), 40)}`;
    case 'Bash': {
      const description = typeof input.description === 'string' ? input.description : '';
      const command = typeof input.command === 'string' ? input.command : '';
      const summary = description || command || 'shell command';
      return `Ran ${truncateSummaryText(summary, 50)}`;
    }
    case 'WebSearch':
      return `Searched web for ${truncateSummaryText(String(input.query ?? input.q ?? 'query'), 40)}`;
    case 'WebFetch':
      return `Fetched ${truncateSummaryText(String(input.url ?? 'URL'), 45)}`;
    case 'Task':
      return `Delegated ${truncateSummaryText(String(input.description ?? input.subagent_type ?? 'task'), 40)}`;
    case 'TaskOutput':
      return 'Checked task output';
    case 'TaskStop':
      return 'Stopped task';
    case 'ToolSearch':
      return `Looked up ${truncateSummaryText(String(input.query ?? input.search_query ?? 'tool'), 40)}`;
    case 'Skill':
      return `Used skill ${truncateSummaryText(String(input.name ?? 'workflow'), 40)}`;
    default:
      return entry.isError ? `${entry.toolName} failed` : `Used ${entry.toolName}`;
  }
}

function buildToolUseSummary(
  entries: ToolUseSummaryEntry[],
  resolveTool?: (toolName: string) => ToolDefinition | undefined,
): string | null {
  if (entries.length === 0) {
    return null;
  }

  if (entries.length === 1) {
    return summarizeSingleToolUse(entries[0], resolveTool);
  }

  const failures = entries.filter((entry) => entry.isError).length;
  const countTools = (names: string[]) => entries.filter((entry) => names.includes(entry.toolName)).length;
  const readCount = countTools(['Read']);
  const writeCount = countTools(['Edit', 'Write', 'NotebookEdit']);
  const grepCount = countTools(['Grep', 'Glob']);
  const taskCount = countTools(['Task', 'TaskOutput', 'TaskStop']);
  const webCount = countTools(['WebSearch', 'WebFetch']);
  const bashEntries = entries.filter((entry) => entry.toolName === 'Bash');
  const ranTests = bashEntries.some((entry) => /\b(test|tests|pytest|vitest|jest|bun test|npm test|pnpm test|yarn test|cargo test|go test)\b/i.test(String((entry.input as Record<string, unknown> | undefined)?.command ?? '')));
  const touchedGit = bashEntries.some((entry) => /\bgit\b/i.test(String((entry.input as Record<string, unknown> | undefined)?.command ?? '')));
  const clauses: string[] = [];

  if (writeCount > 0) {
    clauses.push(`updated ${writeCount} file${writeCount === 1 ? '' : 's'}`);
  }
  if (ranTests) {
    clauses.push('ran tests');
  } else if (touchedGit) {
    clauses.push('checked git state');
  } else if (bashEntries.length > 0) {
    clauses.push(`ran ${bashEntries.length} command${bashEntries.length === 1 ? '' : 's'}`);
  }
  if (readCount > 0 && clauses.length < 2) {
    clauses.push(`read ${readCount} file${readCount === 1 ? '' : 's'}`);
  }
  if (grepCount > 0 && clauses.length < 2) {
    clauses.push(grepCount === 1 ? 'searched the codebase' : `searched ${grepCount} code paths`);
  }
  if (webCount > 0 && clauses.length < 2) {
    clauses.push(webCount === 1 ? 'looked up external context' : `looked up ${webCount} external sources`);
  }
  if (taskCount > 0 && clauses.length < 2) {
    clauses.push(`coordinated ${taskCount} task${taskCount === 1 ? '' : 's'}`);
  }

  const summary = clauses.length > 0
    ? clauses.slice(0, 2).join(' and ')
    : `used ${entries.length} tools`;
  const withCapital = summary.charAt(0).toUpperCase() + summary.slice(1);

  return failures > 0 ? `${withCapital} (${failures} failed)` : withCapital;
}

export class ConversationLoop {
  private messages: Message[] = [];
  private options: ConversationLoopOptions;
  private turnCount = 0;
  private readonly sessionManager = new SessionManager();
  // Cumulative cost counters — accumulate across multiple run() calls.
  private _totalInputTokens = 0;
  private _totalOutputTokens = 0;
  private _totalCostUsd = 0;
  // Tracks files read by the Read tool so Edit/Write can enforce read-before-edit.
  private fileReadTracker = {
    _readFiles: new Set<string>(),
    markRead(filePath: string) { this._readFiles.add(filePath); },
    hasBeenRead(filePath: string) { return this._readFiles.has(filePath); },
  };

  constructor(options: ConversationLoopOptions) {
    this.options = options;
    // Restore prior conversation history when resuming a session.
    // Filter out _transient messages so they are not replayed on resume.
    if (options.initialMessages && options.initialMessages.length > 0) {
      this.messages = options.initialMessages.filter(m => !(m as any)._transient);
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

  /** Build the base fields required by all hook events. */
  private hookBase(): Record<string, unknown> {
    return {
      session_id: this.options.sessionId,
      transcript_path: this.sessionManager.getTranscriptPath(this.options.cwd, this.options.sessionId),
      cwd: this.options.cwd,
      permission_mode: this.options.getAppState?.()?.permissionMode,
    };
  }

  private lastAssistantText(): string | undefined {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const message = this.messages[i];
      if (message.role !== 'assistant') continue;
      if (typeof message.content === 'string') {
        return message.content;
      }
      if (Array.isArray(message.content)) {
        const texts = message.content
          .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
          .map((block) => block.text)
          .filter(Boolean);
        if (texts.length > 0) {
          return texts.join('\n');
        }
      }
    }
    return undefined;
  }

  private applyHookUpdatedInput(target: unknown, updatedInput?: Record<string, unknown>): void {
    if (!updatedInput) return;
    if (!target || typeof target !== 'object' || Array.isArray(target)) return;
    Object.assign(target as Record<string, unknown>, updatedInput);
  }

  private appendHookAdditionalContext(result: string, context?: string): string {
    if (!context || context.trim().length === 0) return result;
    return result.length > 0
      ? `${result}\n\n[Hook context]\n${context}`
      : `[Hook context]\n${context}`;
  }

  private toolFlag(
    tool: ToolDefinition,
    flag: 'isReadOnly' | 'isConcurrencySafe',
    input: unknown,
    defaultValue: boolean,
  ): boolean {
    const raw = tool[flag];
    if (typeof raw === 'function') {
      try {
        return raw(input);
      } catch {
        return defaultValue;
      }
    }
    return typeof raw === 'boolean' ? raw : defaultValue;
  }

  private permissionMetadata(tool: ToolDefinition, input: unknown) {
    const readOnly = this.toolFlag(tool, 'isReadOnly', input, false);
    const capability = tool.capability
      ? {
          category: tool.capability.category,
          risk: tool.capability.risk,
          needsWorkspaceWrite: tool.capability.needsWorkspaceWrite,
        }
      : undefined;
    const tags = tool.capability?.tags ?? [];
    const source = tags.includes('mcp')
      ? 'mcp'
      : (tool.name === 'ToolSearch' ? 'dynamic' : 'builtin');
    const openWorld = tags.includes('network') || tags.includes('external');
    const destructive = tool.capability?.risk === 'high';
    const serverName = source === 'mcp'
      ? (() => {
          const parts = tool.name.split('__');
          return parts.length >= 3 ? parts[1] : undefined;
        })()
      : undefined;

    return {
      readOnly,
      destructive,
      openWorld,
      source,
      ...(serverName ? { serverName } : {}),
      ...(capability ? { capability } : {}),
    };
  }

  private interruptedResult(
    startTime: number,
    turnCount: number,
    totalCostUsd: number,
    usage: { input_tokens: number; output_tokens: number },
    permissionDenials: PermissionDenial[],
  ): SDKMessage {
    return {
      type: 'result',
      subtype: 'error_during_execution',
      duration_ms: Date.now() - startTime,
      duration_api_ms: 0,
      is_error: true,
      num_turns: turnCount,
      stop_reason: 'interrupted',
      total_cost_usd: totalCostUsd,
      usage,
      modelUsage: {},
      permission_denials: permissionDenials,
      errors: ['Interrupted'],
      uuid: randomUUID(),
      session_id: this.options.sessionId,
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
  async *run(userMessage: string | ContentBlock[]): AsyncGenerator<SDKMessage> {
    const sessionId = this.options.sessionId;
    const startTime = Date.now();
    // Per-run counters track only this invocation; instance-level counters
    // accumulate the full session totals.
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCostUsd = 0;
    const allPermissionDenials: PermissionDenial[] = [];
    let emptyResponseNudgeCount = 0;
    let maxTokensContinuationCount = 0;
    let contextErrorRetryCount = 0;

    // ── UserPromptSubmit hook ─────────────────────────────────────────
    // Allows hooks to inspect/reject/modify the user's prompt before processing.
    if (this.options.hookExecutor) {
      const hookResult = await this.options.hookExecutor.execute(
        'UserPromptSubmit',
        {
          ...this.hookBase(),
          hook_event_name: 'UserPromptSubmit',
          prompt: typeof userMessage === 'string' ? userMessage : JSON.stringify(userMessage),
        },
      );
      if (hookResult.continue === false) {
        yield {
          type: 'result',
          subtype: 'error_during_execution',
          duration_ms: 0,
          duration_api_ms: 0,
          is_error: true,
          num_turns: 0,
          stop_reason: 'hook_blocked',
          total_cost_usd: 0,
          usage: { input_tokens: 0, output_tokens: 0 },
          modelUsage: {},
          permission_denials: [],
          errors: [hookResult.decision ?? 'Blocked by UserPromptSubmit hook'],
          uuid: randomUUID(),
          session_id: sessionId,
        };
        return;
      }
    }
    // ── End UserPromptSubmit hook ──────────────────────────────────────

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

      // Hard message count ceiling: force compaction if messages exceed 500.
      if (this.messages.length > 500) {
        yield* this.compactWithEvents('auto');
      }

      // Check if context needs compaction
      const threshold = this.options.compactThreshold ?? 100000;
      if (this.estimateTokens() > threshold) {
        yield* this.compactWithEvents('auto');
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
        serverTools: this.options.serverTools,
        thinking: this.options.thinking,
        effort: this.options.effort,
        systemPrompt: this.options.systemPrompt,
        signal: this.options.abortSignal,
        responseFormat: this.options.responseFormat,
      };

      // Accumulate content blocks as the stream arrives.
      let assistantContent: AccumulatingBlock[] = [];
      // Tracks streaming tool_use blocks by id so interleaved deltas from
      // providers (e.g. multiple OpenAI tool calls in one response) do not
      // overwrite each other.
      const activeToolUses = new Map<string, { id: string; name: string; input: string }>();
      const toolUseOrder: string[] = [];
      let messageUsage: any = null;
      let stopReason: string | null = null;
      // Map from content block index to thinking signature, supporting interleaved
      // thinking blocks without overwriting each other.
      const pendingThinkingSignatures = new Map<number, string>();
      let contentBlockIndex = -1;

      try {
        for await (const event of this.chatWithRetry(this.messages, chatOptions)) {
          // Honour abort requests as promptly as possible.
          if (this.options.abortSignal?.aborted) {
            yield this.interruptedResult(
              startTime,
              this.turnCount,
              totalCostUsd,
              { input_tokens: totalInputTokens, output_tokens: totalOutputTokens },
              allPermissionDenials,
            );
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
            case 'content_block_start': {
              contentBlockIndex++;
              // Capture the signature from thinking blocks so we can attach it
              // to the accumulated thinking content later.
              if (event.content_block?.type === 'thinking' && event.content_block.signature) {
                pendingThinkingSignatures.set(contentBlockIndex, event.content_block.signature);
              }
              break;
            }

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
                const signature = pendingThinkingSignatures.get(contentBlockIndex) ?? '';
                pendingThinkingSignatures.delete(contentBlockIndex);
                thinkBlock = {
                  type: 'thinking',
                  thinking: '',
                  signature,
                  _closed: false,
                };
                assistantContent.push(thinkBlock);
              }
              (thinkBlock as any).thinking += event.thinking;
              break;
            }

            case 'content_block_stop': {
              // Close the most recent open text/thinking block so the next
              // content_block_start creates a fresh one (supports interleaved
              // thinking in Claude's extended thinking API).
              for (const b of assistantContent) {
                if ((b.type === 'text' || b.type === 'thinking') && !b._closed) {
                  b._closed = true;
                }
              }
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
              if (!activeToolUses.has(event.id)) {
                activeToolUses.set(event.id, { id: event.id, name: event.name, input: '' });
                toolUseOrder.push(event.id);
              } else {
                const existing = activeToolUses.get(event.id)!;
                existing.name = event.name;
              }
              break;
            }

            case 'tool_use_delta': {
              // Accumulate partial JSON for the specific tool_use id.
              const toolUse =
                activeToolUses.get(event.id) ??
                (() => {
                  const fallback = { id: event.id, name: '', input: '' };
                  activeToolUses.set(event.id, fallback);
                  toolUseOrder.push(event.id);
                  return fallback;
                })();
              toolUse.input += event.partial_json;
              break;
            }

            case 'tool_use_end': {
              const finishedToolUse = activeToolUses.get(event.id);
              if (finishedToolUse) {
                let parsedInput: Record<string, unknown> = {};
                try {
                  parsedInput = JSON.parse(finishedToolUse.input || '{}');
                } catch {
                  // Leave parsedInput as {} if JSON is malformed — the tool
                  // implementation should handle missing fields gracefully.
                }
                assistantContent.push({
                  type: 'tool_use',
                  id: finishedToolUse.id,
                  name: finishedToolUse.name,
                  input: parsedInput,
                });
                activeToolUses.delete(event.id);
              }
              break;
            }

            case 'message_delta': {
              // message_delta carries stop_reason and incremental usage
              // (including cache token counts). Capture here so max_tokens
              // continuation works even if message_end usage differs.
              if ((event as any).delta?.stop_reason) {
                stopReason = (event as any).delta.stop_reason;
              }
              if ((event as any).usage) {
                messageUsage = {
                  ...(messageUsage ?? {}),
                  ...normalizeTokenUsage((event as any).usage),
                };
              }
              break;
            }

            case 'message_end': {
              if (event.usage) {
                messageUsage = {
                  ...(messageUsage ?? {}),
                  ...normalizeTokenUsage(event.usage),
                };
              }
              if (!stopReason) {
                stopReason = (event.message as any)?.stop_reason ?? null;
              }
              break;
            }

            case 'server_tool_use': {
              // A server-side tool (e.g. Anthropic native web search) was invoked.
              // The server executes it and its result will appear in the same assistant
              // message as a `web_search_tool_result` block — no local execution needed.
              // Close any open text/thinking blocks so subsequent content starts fresh.
              for (const b of assistantContent) {
                if (b.type === 'text' || b.type === 'thinking') {
                  b._closed = true;
                }
              }
              // Record the server_tool_use block in assistant content so it's preserved
              // in message history and forwarded to the provider on the next turn.
              assistantContent.push({
                type: 'server_tool_use',
                id: (event as any).id,
                name: (event as any).name,
                input: (event as any).input ?? {},
              } as any);
              break;
            }

            case 'web_search_result': {
              // The web search result from a server-side tool invocation. The result
              // is already embedded in the assistant message by the provider — record
              // it in assistantContent so it flows through to message history intact.
              assistantContent.push({
                type: 'web_search_tool_result',
                tool_use_id: (event as any).tool_use_id,
                content: (event as any).content ?? [],
              } as any);
              break;
            }

            case 'error': {
              // Provider-level errors during streaming (429, 500, overloaded).
              // Throw so the outer catch block surfaces a proper error result
              // rather than producing a ghost empty success.
              const errorMsg = event.error?.message ?? event.error ?? 'Unknown streaming error';
              throw new Error(typeof errorMsg === 'string' ? errorMsg : JSON.stringify(errorMsg));
            }

            // Other event types (message_start, content_block_*, message_delta)
            // are forwarded via stream_event above but require no content accumulation.
          }
        }

        // Force-close any dangling tool_use if the stream was truncated mid-tool.
        for (const toolUseId of toolUseOrder) {
          const dangling = activeToolUses.get(toolUseId);
          if (!dangling) continue;
          let parsedInput: Record<string, unknown> = {};
          try { parsedInput = JSON.parse(dangling.input || '{}'); } catch { /* partial JSON */ }
          assistantContent.push({
            type: 'tool_use',
            id: dangling.id,
            name: dangling.name,
            input: parsedInput,
          });
          activeToolUses.delete(toolUseId);
        }
      } catch (error: unknown) {
        // Abort errors should stop the loop immediately and yield a clean result.
        if (
          (error instanceof DOMException && error.name === 'AbortError') ||
          this.options.abortSignal?.aborted
        ) {
          yield this.interruptedResult(
            startTime,
            this.turnCount,
            totalCostUsd,
            { input_tokens: totalInputTokens, output_tokens: totalOutputTokens },
            allPermissionDenials,
          );
          return;
        }

        const msg = error instanceof Error ? error.message : String(error);

        // If the error is a context-length exceeded error, try to compact and retry.
        const isContextError = /context.length|token.limit|too.many.tokens|request.too.large|max.context/i.test(msg)
          || (msg.includes('400') && /tokens?/i.test(msg));
        if (isContextError && this.messages.length > 4 && contextErrorRetryCount < 3) {
          contextErrorRetryCount++;
          yield* this.compactWithEvents('auto');
          this.turnCount--; // Don't count the failed attempt as a turn
          continue;
        }

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
      let _turnCostForStore = 0;
      if (this.options.costCalculator && messageUsage) {
        const turnCost = this.options.costCalculator(
          this.options.model,
          messageUsage.input_tokens ?? 0,
          messageUsage.output_tokens ?? 0,
          messageUsage.cache_creation_input_tokens ?? 0,
          messageUsage.cache_read_input_tokens ?? 0,
        );
        totalCostUsd += turnCost;
        this._totalCostUsd += turnCost;
        _turnCostForStore = turnCost;
      }
      if (this.options.setAppState && messageUsage) {
        const turnInput = messageUsage.input_tokens ?? 0;
        const turnOutput = messageUsage.output_tokens ?? 0;
        const turnCost = _turnCostForStore;
        this.options.setAppState(prev => ({
          ...prev,
          totalUsage: {
            inputTokens: prev.totalUsage.inputTokens + turnInput,
            outputTokens: prev.totalUsage.outputTokens + turnOutput,
            costUsd: prev.totalUsage.costUsd + turnCost,
          },
        }));
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
      // Only collect `tool_use` blocks for local execution — `server_tool_use` blocks
      // are already executed server-side and their results appear in the same message.
      // Also exclude tool_use blocks whose name matches a declared server tool —
      // some relays (e.g. DMXAPI) may return server-executed tools as regular
      // `tool_use` instead of `server_tool_use`.
      const serverToolNames = new Set(
        (this.options.serverTools ?? []).map((t) => t.name),
      );
      const toolUses = cleanContent.filter(
        (b) => b.type === 'tool_use' && !serverToolNames.has(b.name),
      );

      if (toolUses.length === 0) {
        // If the model hit the output token limit, automatically continue
        // rather than treating it as a final response. This matches Claude
        // Code's behaviour of seamlessly continuing truncated output.
        if (stopReason === 'max_tokens') {
          maxTokensContinuationCount++;
          // Safety valve: prevent infinite continuation loops. After 20
          // consecutive max_tokens hits, stop and return whatever we have.
          if (maxTokensContinuationCount > 20) {
            // Fall through to the normal "finished" path below.
          } else {
            // Inject a transient continuation prompt so the LLM picks up where
            // it left off. We push it to this.messages for the next API call but
            // mark it so it can be stripped from persistent transcripts.
            this.messages.push({
              role: 'user',
              content: this.createMaxTokensRecoveryPrompt(),
              // @ts-expect-error - transient marker, not part of the Message type
              _transient: true,
            });
            continue; // Loop back to call the LLM again
          }
        }

        // No tool calls — the model has finished. Extract the final text and
        // emit a success result.
        const resultText = cleanContent
          .filter((b) => b.type === 'text')
          .map((b: any) => b.text as string)
          .join('');

        // If the model returned an empty response right after processing tool
        // results (e.g. after a subagent Task completed), nudge it to provide
        // a final summary rather than ending the run silently.  Limit to one
        // retry to avoid infinite loops.
        if (!resultText.trim() && emptyResponseNudgeCount < 1 && this.messages.length >= 2) {
          const prevMsg = this.messages[this.messages.length - 2];
          const prevContent = Array.isArray(prevMsg?.content) ? prevMsg.content : [];
          const hadToolResult = prevContent.some(
            (b: any) => b.type === 'tool_result',
          );
          if (hadToolResult) {
            emptyResponseNudgeCount++;
            this.messages.push({
              role: 'user',
              content: 'Please provide your final response summarizing the results.',
              // @ts-expect-error - transient marker, not part of the Message type
              _transient: true,
            });
            continue;
          }
        }

        // ── Stop hook ───────────────────────────────────────────────────────
        if (this.options.hookExecutor) {
          try {
            await this.options.hookExecutor.execute('Stop', {
              ...this.hookBase(),
              hook_event_name: 'Stop',
              stop_hook_active: false,
              last_assistant_message: resultText || this.lastAssistantText(),
            });
          } catch (e) {
            if (e instanceof DOMException && e.name === 'AbortError') throw e;
            // Non-abort hook errors must not prevent the result from being yielded.
          }
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
          stop_reason: stopReason ?? 'end_turn',
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
      const permissionDenials: PermissionDenial[] = [];
      const toolSummaryEntries: ToolUseSummaryEntry[] = [];

      // Approved tools collected during Phase 1, preserving call order.
      type ApprovedEntry = { toolUse: ContentBlock & { id: string; name: string; input: any }; tool: ToolDefinition };
      const approvedTools: ApprovedEntry[] = [];

      // ── Phase 1: Serial permission checks ────────────────────────────────
      for (const toolUse of toolUses) {
        const tool = this.options.tools.get(toolUse.name);

        if (!tool) {
          const notFound = `Error: Tool '${toolUse.name}' not found`;
          toolSummaryEntries.push({
            toolName: toolUse.name,
            toolUseId: toolUse.id,
            input: toolUse.input,
            result: notFound,
            isError: true,
          });
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: notFound,
            is_error: true,
          });
          yield {
            type: 'tool_result' as const,
            tool_name: toolUse.name,
            tool_use_id: toolUse.id,
            result: notFound,
            is_error: true,
            uuid: randomUUID(),
            session_id: sessionId,
          };
          continue;
        }

        // ── Permission check ───────────────────────────────────────────────
        const { permissionEngine, permissionPrompter } = this.options;
        if (permissionEngine) {
          const permissionMetadata = this.permissionMetadata(tool, toolUse.input);
          const decision = await permissionEngine.evaluate({
            toolName: toolUse.name,
            input: toolUse.input,
            toolUseId: toolUse.id,
            metadata: permissionMetadata,
          });

          if (decision.behavior === 'deny') {
            const reason = decision.reason ?? 'permission denied';
            toolSummaryEntries.push({
              toolName: toolUse.name,
              toolUseId: toolUse.id,
              input: toolUse.input,
              result: `Permission denied: ${reason}`,
              isError: true,
            });
            permissionDenials.push({
              tool_name: toolUse.name,
              tool_use_id: toolUse.id,
              tool_input: normalizePermissionDenialInput(toolUse.input),
            });
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
            if (this.options.abortSignal?.aborted) {
              yield this.interruptedResult(
                startTime,
                this.turnCount,
                totalCostUsd,
                { input_tokens: totalInputTokens, output_tokens: totalOutputTokens },
                [...allPermissionDenials, ...permissionDenials],
              );
              return;
            }
            continue;
          }

          if (decision.behavior === 'ask') {
            let hookPermissionDecision: 'allow' | 'deny' | 'ask' | undefined;
            if (this.options.hookExecutor) {
              try {
                const hookResult = await this.options.hookExecutor.execute('PermissionRequest', {
                  ...this.hookBase(),
                  hook_event_name: 'PermissionRequest',
                  tool_name: toolUse.name,
                  tool_input: toolUse.input,
                  tool_use_id: toolUse.id,
                  stage: 'before_prompt',
                  reason: decision.reason,
                  metadata: permissionMetadata,
                }, toolUse.id);
                this.applyHookUpdatedInput(toolUse.input, hookResult.updatedInput);
                if (
                  hookResult.permissionDecision === 'allow'
                  || hookResult.permissionDecision === 'deny'
                  || hookResult.permissionDecision === 'ask'
                ) {
                  hookPermissionDecision = hookResult.permissionDecision;
                } else if (hookResult.decision === 'approve') {
                  hookPermissionDecision = 'allow';
                } else if (hookResult.decision === 'block' || hookResult.continue === false) {
                  hookPermissionDecision = 'deny';
                }
              } catch (e) {
                if (e instanceof DOMException && e.name === 'AbortError') throw e;
              }
            }

            if (hookPermissionDecision === 'deny') {
              const reason = 'permission denied by PermissionRequest hook';
              toolSummaryEntries.push({
                toolName: toolUse.name,
                toolUseId: toolUse.id,
                input: toolUse.input,
                result: `Permission denied: ${reason}`,
                isError: true,
              });
              permissionDenials.push({
                tool_name: toolUse.name,
                tool_use_id: toolUse.id,
                tool_input: normalizePermissionDenialInput(toolUse.input),
              });
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

            if (hookPermissionDecision === 'allow') {
              // Hook pre-approved the action; skip the interactive prompt.
            } else if (!permissionPrompter) {
              // No prompter available — deny by default when mode requires confirmation.
              const reason = decision.reason ?? 'permission required but no prompter configured';
              toolSummaryEntries.push({
                toolName: toolUse.name,
                toolUseId: toolUse.id,
                input: toolUse.input,
                result: `Permission denied: ${reason}`,
                isError: true,
              });
              permissionDenials.push({
                tool_name: toolUse.name,
                tool_use_id: toolUse.id,
                tool_input: normalizePermissionDenialInput(toolUse.input),
              });
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
            } else {
              const userDecision = await permissionPrompter.prompt({
                toolName: toolUse.name,
                input: toolUse.input,
                reason: decision.reason,
              });

              if (userDecision === 'deny') {
                const reason = 'user denied permission';
                toolSummaryEntries.push({
                  toolName: toolUse.name,
                  toolUseId: toolUse.id,
                  input: toolUse.input,
                  result: `Permission denied: ${reason}`,
                  isError: true,
                });
                permissionDenials.push({
                  tool_name: toolUse.name,
                  tool_use_id: toolUse.id,
                  tool_input: normalizePermissionDenialInput(toolUse.input),
                });
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
            }
            // 'allow' or 'always' — fall through to queue the tool.
          }
        }
        // ── End permission check ───────────────────────────────────────────

        if (this.options.hookExecutor) {
          try {
            const hookResult = await this.options.hookExecutor.execute('PreToolUse', {
              ...this.hookBase(),
              hook_event_name: 'PreToolUse',
              tool_name: toolUse.name,
              tool_input: toolUse.input,
              tool_use_id: toolUse.id,
            }, toolUse.id);
            this.applyHookUpdatedInput(toolUse.input, hookResult.updatedInput);
            if (hookResult.continue === false) {
              const reason = hookResult.reason ?? hookResult.decision ?? 'blocked by PreToolUse hook';
              toolSummaryEntries.push({
                toolName: toolUse.name,
                toolUseId: toolUse.id,
                input: toolUse.input,
                result: reason,
                isError: true,
              });
              toolResults.push({
                type: 'tool_result',
                tool_use_id: toolUse.id,
                content: reason,
                is_error: true,
              });
              yield {
                type: 'tool_result' as const,
                tool_name: toolUse.name,
                tool_use_id: toolUse.id,
                result: reason,
                is_error: true,
                uuid: randomUUID(),
                session_id: sessionId,
              };
              continue;
            }
          } catch (e) {
            if (e instanceof DOMException && e.name === 'AbortError') throw e;
          }
        }

        approvedTools.push({ toolUse: toolUse as ApprovedEntry['toolUse'], tool });
      }
      // ── End Phase 1 ───────────────────────────────────────────────────────

      if (this.options.abortSignal?.aborted) {
        yield this.interruptedResult(
          startTime,
          this.turnCount,
          totalCostUsd,
          { input_tokens: totalInputTokens, output_tokens: totalOutputTokens },
          [...allPermissionDenials, ...permissionDenials],
        );
        return;
      }

      // ── Phase 2: Execute via StreamingToolExecutor ─────────────────────────
      type ExecutionResult = {
        toolUse: ApprovedEntry['toolUse'];
        resultStr: string;
        isError: boolean;
        blocked: boolean;
        blockReason?: string;
        isImageResult?: boolean;
        additionalContext?: string;
      };

      const executor = new StreamingToolExecutor(
        this.options.tools,
        {
          cwd: this.options.cwd,
          abortSignal: this.options.abortSignal,
          sessionId: this.options.sessionId,
          fileReadTracker: this.fileReadTracker,
          getAppState: this.options.getAppState,
          setAppState: this.options.setAppState,
        },
        sessionId,
      );

      for (const { toolUse } of approvedTools) {
        executor.addTool({
          id: toolUse.id,
          name: toolUse.name,
          input: toolUse.input as Record<string, unknown>,
        });
      }

      // Collect results for Phase 3 processing
      const orderedResults: ExecutionResult[] = [];
      for await (const event of executor.getResults()) {
        if (event.type === 'tool_result') {
          // Find matching approved tool entry
          const approved = approvedTools.find(a => a.toolUse.id === event.tool_use_id);
          if (approved) {
            // Detect structured image results for special handling in Phase 3
            let isImageResult = false;
            if (!event.is_error) {
              try {
                const parsed = JSON.parse(event.result);
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
            }

            orderedResults.push({
              toolUse: approved.toolUse,
              resultStr: event.result,
              isError: event.is_error,
              blocked: false,
              isImageResult,
            });
          }
        }
      }
      // ── End Phase 2 ───────────────────────────────────────────────────────

      // ── Phase 3: Yield results in original call order ─────────────────────
      for (const { toolUse, resultStr, isError, blocked, isImageResult } of orderedResults) {
        let finalResultStr = resultStr;
        if (this.options.hookExecutor) {
          try {
            const hookEvent = isError ? 'PostToolUseFailure' : 'PostToolUse';
            const hookResult = await this.options.hookExecutor.execute(hookEvent, {
              ...this.hookBase(),
              hook_event_name: hookEvent,
              tool_name: toolUse.name,
              tool_input: toolUse.input,
              tool_use_id: toolUse.id,
              ...(isError
                ? { error: resultStr }
                : { tool_response: resultStr }),
            }, toolUse.id);
            finalResultStr = this.appendHookAdditionalContext(finalResultStr, hookResult.additionalContext);
          } catch (e) {
            if (e instanceof DOMException && e.name === 'AbortError') throw e;
          }
        }

        toolSummaryEntries.push({
          toolName: toolUse.name,
          toolUseId: toolUse.id,
          input: toolUse.input,
          result: finalResultStr,
          isError: blocked || isError,
        });

        if (blocked) {
          // Pre-hook blocked execution — surface as an error result.
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: finalResultStr,
            is_error: true,
          });
          yield {
            type: 'tool_result' as const,
            tool_name: toolUse.name,
            tool_use_id: toolUse.id,
            result: finalResultStr,
            is_error: true,
            uuid: randomUUID(),
            session_id: sessionId,
          };
          continue;
        }

        if (isError) {
          // Truncate large error messages (e.g. stack traces) to 10K chars.
          const truncatedError = resultStr.length > 10_000
            ? finalResultStr.slice(0, 10_000) + '\n[Error output truncated]'
            : finalResultStr;
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: `Error: ${truncatedError}`,
            is_error: true,
          });
          yield {
            type: 'tool_result' as const,
            tool_name: toolUse.name,
            tool_use_id: toolUse.id,
            result: finalResultStr.slice(0, 500),
            _fullResult: truncatedError,
            is_error: true,
            uuid: randomUUID(),
            session_id: sessionId,
          };
        } else if (isImageResult) {
          // Parse the structured image result and send it as actual image
          // content blocks so the LLM can visually inspect the image.
          const parsed = JSON.parse(finalResultStr) as {
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
            _fullResult: finalResultStr,
            is_error: false,
            uuid: randomUUID(),
            session_id: sessionId,
          };
        } else {
          // Truncate oversized tool results to 30K chars to prevent context
          // bloat.  This matches Claude Code's truncation threshold.
          const MAX_TOOL_RESULT = 30_000;
          const truncatedResult = finalResultStr.length > MAX_TOOL_RESULT
            ? finalResultStr.slice(0, MAX_TOOL_RESULT) + `\n\n[Output truncated: ${finalResultStr.length} chars total, showing first ${MAX_TOOL_RESULT}]`
            : finalResultStr;

          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: truncatedResult,
          });
          yield {
            type: 'tool_result' as const,
            tool_name: toolUse.name,
            tool_use_id: toolUse.id,
            result: finalResultStr.slice(0, 500),
            // Include the full result for transcript persistence so --resume
            // reconstructs the complete tool_result user message.
            _fullResult: truncatedResult,
            is_error: false,
            uuid: randomUUID(),
            session_id: sessionId,
          };
        }
      }
      // ── End Phase 3 ───────────────────────────────────────────────────────

      const toolUseSummary = buildToolUseSummary(
        toolSummaryEntries,
        (toolName) => this.options.tools.get(toolName),
      );
      if (toolUseSummary) {
        yield {
          type: 'tool_use_summary',
          summary: toolUseSummary,
          preceding_tool_use_ids: toolSummaryEntries.map((entry) => entry.toolUseId),
          uuid: randomUUID(),
          session_id: sessionId,
        };
      }

      // Accumulate permission denials across all turns for the final result.
      allPermissionDenials.push(...permissionDenials);

      // Feed the tool results back as a user message so the LLM can continue.
      this.messages.push({ role: 'user', content: toolResults });

      // Loop back to call the LLM again with the updated conversation history.
    }
  }

  /** Return a snapshot of the current conversation history, excluding transient messages. */
  getMessages(): Message[] {
    return this.messages.filter(m => !(m as any)._transient);
  }

  /** Return the number of LLM turns executed so far. */
  getTurnCount(): number {
    return this.turnCount;
  }

  /** Update the model used for subsequent LLM calls. */
  setModel(model: string): void {
    this.options.model = model;
  }

  /**
   * Reset conversation messages to initial state (or empty) so that a
   * fallback retry starts with a clean history rather than duplicating the
   * user prompt that was already appended in a failed run() call.
   */
  resetMessages(initialMessages?: Message[]): void {
    this.messages = initialMessages ? [...initialMessages] : [];
    this.turnCount = 0;
  }

  /** Update the thinking configuration. */
  setThinking(thinking: ThinkingConfig): void {
    this.options.thinking = thinking;
  }

  /** Update the system prompt used for subsequent LLM calls. */
  setSystemPrompt(systemPrompt?: string): void {
    this.options.systemPrompt = systemPrompt;
  }

  /** Update the effort level for subsequent LLM calls. */
  setEffort(effort: 'low' | 'medium' | 'high' | 'max'): void {
    this.options.effort = effort;
  }

  /** Replace the tool map (e.g. when entering/exiting plan mode). */
  setTools(tools: Map<string, ToolDefinition>): void {
    this.options.tools = tools;
  }

  /** Add a single tool to the live tool map (e.g. after ToolSearch selects one). */
  addTool(tool: ToolDefinition): void {
    this.options.tools.set(tool.name, tool);
  }

  /**
   * Update the permission mode on the underlying permission engine.
   * Has no effect if no permissionEngine was supplied at construction time.
   */
  setPermissionMode(mode: string): void {
    (this.options.permissionEngine as any)?.setMode?.(mode);
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
        for await (const event of this.options.provider.chat(messages, options)) {
          if (event.type === 'error') {
            const errMsg = (event as any).error?.message ?? (event as any).error ?? 'Unknown provider error';
            throw new Error(typeof errMsg === 'string' ? errMsg : JSON.stringify(errMsg));
          }
          yield event;
        }
        return;
      } catch (error: unknown) {
        // Don't retry if the user aborted.
        if (this.options.abortSignal?.aborted) throw error;

        const isRetryable = this.isRetryableError(error);
        if (!isRetryable || attempt === maxRetries) throw error;

        // Jitter: uniform random in [0, delay * 0.5]
        const jitter = Math.random() * delay * 0.5;
        await this.delayWithAbort(delay + jitter);
        delay = Math.min(delay * 2, 60_000);
      }
    }
  }

  private async delayWithAbort(ms: number): Promise<void> {
    const signal = this.options.abortSignal;
    if (!signal) {
      await new Promise<void>((resolve) => setTimeout(resolve, ms));
      return;
    }
    if (signal.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        reject(new DOMException('Aborted', 'AbortError'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  /**
   * Return true when the error is a transient condition that can be safely
   * retried (rate limits, server overload, network resets, timeouts).
   * Never retries abort/cancel errors from Ctrl+C.
   */
  private isRetryableError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;

    // Never retry abort-related errors
    if (error.name === 'AbortError') return false;
    const msg = error.message.toLowerCase();
    if (msg.includes('abort') || msg.includes('cancel')) return false;

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

  private createMaxTokensRecoveryPrompt(): string {
    return (
      'Output token limit hit. Resume directly with no apology and no recap. ' +
      'Continue from the exact point where the response stopped, and break the remaining work into smaller pieces if needed.'
    );
  }

  private async *compactWithEvents(
    trigger: 'manual' | 'auto',
  ): AsyncGenerator<SDKMessage, boolean> {
    const preTokens = this.estimateTokens();
    const sessionId = this.options.sessionId;

    yield {
      type: 'system',
      subtype: 'status',
      status: 'compacting',
      session_id: sessionId,
      uuid: randomUUID(),
    } as const;

    const preCount = this.messages.length;
    const compacted = await this.compactInternal(trigger);
    const removedCount = preCount - this.messages.length;

    if (compacted) {
      if (removedCount > 0) {
        yield {
          type: 'tombstone',
          originalMessageId: `compacted-${removedCount}-messages`,
          reason: 'compacted',
          uuid: randomUUID(),
          session_id: sessionId,
        } as SDKMessage;
      }

      yield {
        type: 'system',
        subtype: 'compact_boundary',
        compact_metadata: {
          trigger,
          pre_tokens: preTokens,
        },
        session_id: sessionId,
        uuid: randomUUID(),
      } as const;
    }

    yield {
      type: 'system',
      subtype: 'status',
      status: null,
      session_id: sessionId,
      uuid: randomUUID(),
    } as const;

    return compacted;
  }

  /** Compact conversation history by summarising older messages with the LLM. */
  async compact(): Promise<void> {
    await this.compactInternal('manual');
  }

  private async compactInternal(trigger: 'manual' | 'auto'): Promise<boolean> {
    if (this.messages.length <= 4) return false;

    // ── PreCompact hook ───────────────────────────────────────────────
    if (this.options.hookExecutor) {
      await this.options.hookExecutor.execute('PreCompact', {
        ...this.hookBase(),
        hook_event_name: 'PreCompact',
        trigger,
        custom_instructions: null,
      });
    }
    // ── End PreCompact hook ───────────────────────────────────────────

    // Find the best split point: keep enough recent messages to preserve
    // current working context.  We look for a clean turn boundary (a user
    // message that is NOT a tool_result) and keep at least the last 3 turns
    // (6 messages) but up to 5 turns (10 messages) if the conversation is
    // long enough.
    const targetKeep = Math.min(
      Math.max(6, Math.ceil(this.messages.length * 0.3)),
      10,
    );
    let keepFrom = this.messages.length - targetKeep;

    // Walk forward to find a clean turn boundary — a user message that is
    // not a tool_result response.  User messages with string content or
    // array content that does NOT start with a tool_result block qualify.
    while (keepFrom < this.messages.length - 2) {
      const msg = this.messages[keepFrom];
      if (msg.role === 'user') {
        const isToolResult = Array.isArray(msg.content) &&
          msg.content.length > 0 &&
          (msg.content[0] as any)?.type === 'tool_result';
        if (!isToolResult) break;
      }
      keepFrom++;
    }

    // If we couldn't find a good boundary, fall back to keeping last 6.
    if (keepFrom >= this.messages.length - 2) {
      keepFrom = Math.max(0, this.messages.length - 6);
    }

    if (keepFrom <= 0) return false; // Nothing to compact.

    const toSummarize = this.messages.slice(0, keepFrom).filter(m => !(m as any)._transient);
    const toKeep = this.messages.slice(keepFrom);

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
    return true;
  }
}
