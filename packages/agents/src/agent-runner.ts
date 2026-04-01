import { ConversationLoop } from '@open-agent/core';
import type { AgentDefinition } from '@open-agent/core';
import { createStore, createDefaultAppState } from '@open-agent/state';
import type { AppState } from '@open-agent/state';
import type { LLMProvider } from '@open-agent/providers';
import type { ToolDefinition } from '@open-agent/tools';
import { randomUUID } from 'crypto';
import { join } from 'path';
import { TeamManager } from './team-manager.js';

/** Lightweight event emitted by subagent for parent visibility. */
export interface SubagentStreamEvent {
  type: 'tool_start' | 'tool_result' | 'launched' | 'completed' | 'failed' | 'shutdown';
  protocol?: 'task_notification_v1';
  toolName?: string;
  toolUseId?: string;
  input?: Record<string, unknown>;
  ok?: boolean;
  output?: string;
  error?: string;
  /** Agent ID for lifecycle events (launched/completed/failed/shutdown) */
  agentId?: string;
  /** Stable task ID used by SDK task protocol messages. */
  taskId?: string;
  /** Task description for lifecycle events */
  description?: string;
  /** Duration in milliseconds (completed/failed/shutdown events) */
  durationMs?: number;
  /** Completion timestamp for lifecycle notifications. */
  completedAt?: string;
  teamName?: string;
  /** Total tool use count (completed events) */
  totalToolUseCount?: number;
  /** High-level notification status for lifecycle events. */
  status?: 'completed' | 'failed' | 'stopped';
  /** Background output file when available. */
  outputFile?: string;
  /** Concise lifecycle summary for upstream renderers. */
  summary?: string;
  /** Usage snapshot for task progress / completion surfaces. */
  usage?: {
    total_tokens: number;
    tool_uses: number;
    duration_ms: number;
  };
  /** Last tool used, when applicable. */
  lastToolName?: string;
}

export interface AgentRunnerOptions {
  definition: AgentDefinition;
  provider: LLMProvider;
  tools: Map<string, ToolDefinition>;
  cwd: string;
  agentId?: string;
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
  /** Abort signal used to interrupt the conversation loop. */
  abortSignal?: AbortSignal;
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

const SUBAGENT_SYSTEM_CONTRACT = `You are a subagent working on behalf of another OpenAgent agent.

Important operating rules:
- The user cannot see your raw tool calls or intermediate reasoning. Only your final result is relayed upstream.
- You cannot ask the user follow-up questions directly. Use the prompt you were given and make the best grounded decision you can from the available context.
- Do not mention missing conversation context unless it materially blocks the task. Infer the most practical path from the files, tools, and instructions you have.
- Be concrete in your final report: cite files, checks, and decisions. Avoid vague summaries.
- If you were asked to research, return findings and next steps. If you were asked to implement, report what changed and how you verified it.
- Treat every prompt from the parent agent as authoritative and self-contained. Do not assume the user can clarify missing context later.
- If you are part of a multi-worker effort, leave high-signal handoff notes in the shared scratchpad instead of relying on the user-facing chat for coordination.
- Verification means proving the result works, not merely confirming that code exists.`;

interface SubagentSystemPromptOptions {
  teamName?: string;
  scratchpadDir?: string;
  availableTools?: string[];
}

export function buildSubagentSystemPrompt(
  definitionPrompt: string | undefined,
  cwd: string,
  options: SubagentSystemPromptOptions = {},
): string {
  const toolList = (options.availableTools ?? []).slice().sort();
  const coordinationLines: string[] = [];

  if (toolList.length > 0) {
    coordinationLines.push(`Available tools for this run: ${toolList.join(', ')}`);
    coordinationLines.push('Different agent types may expose only a subset of the full tool pool. Do not assume unavailable tools exist.');
  }

  if (options.teamName) {
    coordinationLines.push(`Team context: ${options.teamName}`);
  }

  if (options.scratchpadDir) {
    coordinationLines.push(`Scratchpad directory: ${options.scratchpadDir}`);
    coordinationLines.push('Use the scratchpad for durable notes, synthesized findings, and worker handoffs. Keep it concise and high-signal.');
  }

  const coordinationSection = coordinationLines.length > 0
    ? `\n\nCoordination context:\n${coordinationLines.map((line) => `- ${line}`).join('\n')}`
    : '';

  if (definitionPrompt) {
    return `${SUBAGENT_SYSTEM_CONTRACT}\n\n${definitionPrompt}${coordinationSection}\n\nCurrent working directory: ${cwd}`;
  }
  return `${SUBAGENT_SYSTEM_CONTRACT}\n\nYou are a specialized agent. Complete the given task.${coordinationSection}\n\nCurrent working directory: ${cwd}`;
}

export class AgentRunner {
  private agentId: string;
  private options: AgentRunnerOptions;

  constructor(options: AgentRunnerOptions) {
    this.agentId = options.agentId ?? randomUUID();
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

    const teamManager = (this.options.teamName && this.options.agentName)
      ? new TeamManager()
      : null;
    const scratchpadDir = this.options.teamName
      ? (teamManager ?? new TeamManager()).getScratchpadDir(this.options.teamName)
      : join(effectiveCwd, '.open-agent', 'scratchpad');
    const systemPrompt = buildSubagentSystemPrompt(def.prompt, effectiveCwd, {
      teamName: this.options.teamName,
      scratchpadDir,
      availableTools: [...tools.keys()],
    });

    const resolvedModel = this.resolveModel(this.options.model ?? def.model);
    const subagentSessionId = `subagent-${this.agentId}`;

    const appStore = createStore<AppState>(createDefaultAppState({
      sessionId: subagentSessionId,
      cwd: effectiveCwd,
      model: resolvedModel,
      permissionMode: 'default',
      tools,
      thinkingConfig: { type: 'adaptive' },
      verbose: false,
    }));

    const loop = new ConversationLoop({
      provider: this.options.provider,
      tools,
      model: resolvedModel,
      systemPrompt,
      maxTurns: this.options.maxTurns ?? def.maxTurns ?? 30,
      thinking: { type: 'adaptive' },
      effort: 'high',
      cwd: effectiveCwd,
      sessionId: subagentSessionId,
      initialMessages: this.options.initialMessages,
      abortSignal: this.options.abortSignal,
      getAppState: () => appStore.getState(),
      setAppState: (updater) => appStore.setState(updater),
    });

    let resultText = '';
    let isError = false;
    let numTurns = 0;
    let toolUseCount = 0;
    let resultUsage: any = {};

    // Outer loop: allows re-entering the conversation after receiving inbox messages.
    let currentPrompt: string = prompt;
    let shutdownRequested = false;
    // pendingInboxInjection: inbox messages collected mid-run that need to be
    // injected as the next prompt after the current run completes.
    let pendingInboxInjection: string | null = null;

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
                      protocol: 'task_notification_v1',
                      agentId: this.agentId,
                      taskId: this.agentId,
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
                protocol: 'task_notification_v1',
                agentId: this.agentId,
                taskId: this.agentId,
                toolName: (msg as any).tool_name,
                toolUseId: (msg as any).tool_use_id,
                ok: !(msg as any).is_error,
                output: typeof (msg as any).result === 'string' ? (msg as any).result : undefined,
                error: (msg as any).is_error ? (msg as any).result : undefined,
                lastToolName: (msg as any).tool_name,
                usage: {
                  total_tokens: 0,
                  tool_uses: toolUseCount + 1,
                  duration_ms: Date.now() - startTime,
                },
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

          // ── 每轮结束后立即检查 inbox ──────────────────────────────────────
          // Check inbox on every result (turn completion), not just at outer-loop end.
          // This lets the agent react to team messages with lower latency.
          if (teamManager && this.options.teamName && this.options.agentName && !isError) {
            const inboxMessages = teamManager.readInbox(this.options.teamName, this.options.agentName);
            if (inboxMessages.length > 0) {
              const shutdownMsg = inboxMessages.find(m => m.type === 'shutdown_request');
              if (shutdownMsg) {
                // Acknowledge shutdown and signal outer loop to exit.
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
                pendingInboxInjection = null;
              } else {
                // Collect non-shutdown messages to inject as the next prompt.
                pendingInboxInjection = inboxMessages
                  .map(m => `[Team message from ${m.from}]: ${m.content}`)
                  .join('\n\n');
              }
            }
          }
        }
      }

      // After each run completes, process any pending inbox injection.
      if (shutdownRequested) {
        break;
      }

      if (pendingInboxInjection) {
        currentPrompt = pendingInboxInjection;
        pendingInboxInjection = null;
        continue;
      }

      // If there's an error, or no team context, or no inbox messages, exit.
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
