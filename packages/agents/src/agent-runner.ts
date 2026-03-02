import { ConversationLoop } from '@open-agent/core';
import type { AgentDefinition } from '@open-agent/core';
import type { LLMProvider } from '@open-agent/providers';
import type { ToolDefinition } from '@open-agent/tools';
import { randomUUID } from 'crypto';
import { TeamManager } from './team-manager.js';

/** Lightweight event emitted by subagent for parent visibility. */
export interface SubagentStreamEvent {
  type: 'tool_start' | 'tool_result' | 'launched' | 'completed' | 'failed';
  toolName?: string;
  toolUseId?: string;
  input?: Record<string, unknown>;
  ok?: boolean;
  output?: string;
  error?: string;
  /** Agent ID for lifecycle events (launched/completed/failed) */
  agentId?: string;
  /** Task description for lifecycle events */
  description?: string;
  /** Duration in milliseconds (completed/failed events) */
  durationMs?: number;
  /** Total tool use count (completed events) */
  totalToolUseCount?: number;
}

export interface AgentRunnerOptions {
  definition: AgentDefinition;
  provider: LLMProvider;
  tools: Map<string, ToolDefinition>;
  cwd: string;
  parentSessionId?: string;
  maxTurns?: number;
  mode?: string;
  /** Runtime model override — takes precedence over definition.model */
  model?: string;
  initialMessages?: import('@open-agent/providers').Message[];
  /** When set, all tool executions use this path as cwd instead of options.cwd */
  worktreePath?: string;
  /** Callback to persist each message to a transcript file */
  onMessage?: (message: unknown) => void;
  /** Callback to stream tool events to the parent agent for real-time visibility. */
  onEvent?: (event: SubagentStreamEvent) => void;
  /** Team name for inbox polling — when set with agentName, enables team message injection */
  teamName?: string;
  /** Agent name for inbox polling — identifies which inbox to read */
  agentName?: string;
}

export interface AgentUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number | null;
  cache_read_input_tokens: number | null;
  server_tool_use: { web_search_requests: number; web_fetch_requests: number } | null;
  service_tier: ('standard' | 'priority' | 'batch') | null;
  cache_creation: { ephemeral_1h_input_tokens: number; ephemeral_5m_input_tokens: number } | null;
}

export interface AgentResult {
  agentId: string;
  result: string;
  isError: boolean;
  numTurns: number;
  durationMs: number;
  totalToolUseCount: number;
  totalTokens: number;
  usage: AgentUsage;
  /** Set when the agent ran inside a worktree and changes were detected */
  worktreePath?: string;
  worktreeBranch?: string;
  hasWorktreeChanges?: boolean;
}

export class AgentRunner {
  private agentId: string;
  private options: AgentRunnerOptions;

  constructor(options: AgentRunnerOptions) {
    this.agentId = randomUUID();
    this.options = options;
  }

  async run(prompt: string): Promise<AgentResult> {
    const startTime = Date.now();
    const def = this.options.definition;

    // Filter tools based on agent definition
    let tools = new Map(this.options.tools);

    if (def.tools && def.tools.length > 0) {
      // Only keep allowed tools
      const allowed = new Set(def.tools);
      for (const name of tools.keys()) {
        if (!allowed.has(name)) tools.delete(name);
      }
    }

    if (def.disallowedTools) {
      for (const name of def.disallowedTools) {
        tools.delete(name);
      }
    }

    // Remove Task tool from subagents to prevent infinite recursion
    // (unless explicitly allowed in def.tools)
    if (!def.tools?.includes('Task')) {
      tools.delete('Task');
    }

    // When running inside a worktree, use its path as cwd so all tool calls
    // (Bash, Read, Write, etc.) operate on the isolated branch.
    const effectiveCwd = this.options.worktreePath ?? this.options.cwd;

    const systemPrompt = def.prompt
      ? `${def.prompt}\n\nCurrent working directory: ${effectiveCwd}`
      : `You are a specialized agent. Complete the given task. Working directory: ${effectiveCwd}`;

    const loop = new ConversationLoop({
      provider: this.options.provider,
      tools,
      model: this.resolveModel(this.options.model ?? def.model),
      systemPrompt,
      maxTurns: this.options.maxTurns ?? def.maxTurns ?? 30,
      thinking: { type: 'adaptive' },
      effort: 'high',
      cwd: effectiveCwd,
      sessionId: `subagent-${this.agentId}`,
      initialMessages: this.options.initialMessages,
    });

    let resultText = '';
    let isError = false;
    let numTurns = 0;
    let toolUseCount = 0;
    let resultUsage: any = {};

    const teamManager = (this.options.teamName && this.options.agentName)
      ? new TeamManager()
      : null;

    // Outer loop: allows re-entering the conversation after receiving inbox messages.
    let currentPrompt: string = prompt;
    let shutdownRequested = false;

    while (true) {
      for await (const msg of loop.run(currentPrompt)) {
        if (this.options.onMessage) {
          this.options.onMessage(msg);
        }

        // Emit tool events for parent visibility
        if (this.options.onEvent) {
          try {
            if (msg.type === 'assistant') {
              const content = (msg as any).message?.content;
              if (Array.isArray(content)) {
                for (const block of content) {
                  if (block.type === 'tool_use') {
                    this.options.onEvent({
                      type: 'tool_start',
                      toolName: block.name,
                      toolUseId: block.id,
                      input: typeof block.input === 'object' && block.input ? block.input : undefined,
                    });
                  }
                }
              }
            }
            if (msg.type === 'tool_result') {
              this.options.onEvent({
                type: 'tool_result',
                toolName: (msg as any).tool_name,
                toolUseId: (msg as any).tool_use_id,
                ok: !(msg as any).is_error,
                output: typeof (msg as any).result === 'string' ? (msg as any).result : undefined,
                error: (msg as any).is_error ? (msg as any).result : undefined,
              });
            }
          } catch { /* onEvent callback error must not interrupt subagent execution */ }
        }

        if (msg.type === 'tool_result') {
          toolUseCount++;
        }
        if (msg.type === 'result') {
          if ('result' in msg) {
            resultText = (msg as any).result ?? '';
          }
          isError = msg.is_error;
          numTurns = msg.num_turns;
          resultUsage = (msg as any).usage ?? {};
        }
      }

      // After each run completes, check inbox for team messages if in a team context.
      if (teamManager && this.options.teamName && this.options.agentName && !isError) {
        const inboxMessages = teamManager.readInbox(this.options.teamName, this.options.agentName);

        if (inboxMessages.length === 0) {
          // No pending messages — exit the outer loop normally.
          break;
        }

        // Check for shutdown_request first.
        const shutdownMsg = inboxMessages.find(m => m.type === 'shutdown_request');
        if (shutdownMsg) {
          // Send shutdown_response acknowledging the request.
          teamManager.sendMessage(this.options.teamName, {
            type: 'shutdown_response' as any,
            from: this.options.agentName,
            to: shutdownMsg.from,
            content: `Agent "${this.options.agentName}" acknowledges shutdown request.`,
            summary: `${this.options.agentName} shutting down`,
            timestamp: new Date().toISOString(),
            requestId: shutdownMsg.requestId,
            approve: true,
          });
          shutdownRequested = true;
          break;
        }

        // Compose inbox messages into a single user turn for the next loop run.
        const injectedContent = inboxMessages
          .map(m => `[Team message from ${m.from}]: ${m.content}`)
          .join('\n\n');

        currentPrompt = injectedContent;
        // Continue the outer loop with the injected content as next prompt.
        continue;
      }

      // If there's an error, or no team context, exit the outer loop.
      break;
    }

    const inputTokens = resultUsage.input_tokens ?? 0;
    const outputTokens = resultUsage.output_tokens ?? 0;

    const agentResult: AgentResult = {
      agentId: this.agentId,
      result: resultText,
      isError,
      numTurns,
      durationMs: Date.now() - startTime,
      totalToolUseCount: toolUseCount,
      totalTokens: inputTokens + outputTokens,
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_creation_input_tokens: resultUsage.cache_creation_input_tokens ?? null,
        cache_read_input_tokens: resultUsage.cache_read_input_tokens ?? null,
        server_tool_use: resultUsage.server_tool_use ?? null,
        service_tier: resultUsage.service_tier ?? null,
        cache_creation: resultUsage.cache_creation ?? null,
      },
    };

    return agentResult;
  }

  private resolveModel(model?: string): string {
    // Map shorthand to full model names (Claude shortcuts)
    switch (model) {
      case 'sonnet': return 'claude-sonnet-4-6';
      case 'opus': return 'claude-opus-4-6';
      case 'haiku': return 'claude-haiku-4-5-20251001';
      default:
        // Use the model as-is (supports any provider's model names).
        // Fallback to provider-appropriate defaults only as last resort.
        if (model && model.length > 0) return model;
        return this.options.provider.name === 'anthropic'
          ? 'claude-sonnet-4-6'
          : this.options.provider.name === 'ollama'
            ? 'llama3'
            : 'gpt-4o';
    }
  }

  getAgentId(): string {
    return this.agentId;
  }
}
