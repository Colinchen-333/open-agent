import { ConversationLoop } from '@open-agent/core';
import type { AgentDefinition } from '@open-agent/core';
import type { LLMProvider } from '@open-agent/providers';
import type { ToolDefinition } from '@open-agent/tools';
import { randomUUID } from 'crypto';

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
}

export interface AgentResult {
  agentId: string;
  result: string;
  isError: boolean;
  numTurns: number;
  durationMs: number;
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

    for await (const msg of loop.run(prompt)) {
      // Persist each message to transcript if callback provided
      if (this.options.onMessage) {
        this.options.onMessage(msg);
      }
      if (msg.type === 'result') {
        if ('result' in msg) {
          resultText = (msg as any).result ?? '';
        }
        isError = msg.is_error;
        numTurns = msg.num_turns;
      }
    }

    const agentResult: AgentResult = {
      agentId: this.agentId,
      result: resultText,
      isError,
      numTurns,
      durationMs: Date.now() - startTime,
    };

    return agentResult;
  }

  private resolveModel(model?: string): string {
    // Map shorthand to full model names
    switch (model) {
      case 'sonnet': return 'claude-sonnet-4-6';
      case 'opus': return 'claude-opus-4-6';
      case 'haiku': return 'claude-haiku-4-5-20251001';
      default:
        if (model && model.length > 0) return model;
        return this.options.provider.name === 'anthropic' ? 'claude-sonnet-4-6' : 'gpt-4o';
    }
  }

  getAgentId(): string {
    return this.agentId;
  }
}
