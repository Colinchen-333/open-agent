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
}

export interface AgentResult {
  agentId: string;
  result: string;
  isError: boolean;
  numTurns: number;
  durationMs: number;
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

    const systemPrompt = def.prompt
      ? `${def.prompt}\n\nCurrent working directory: ${this.options.cwd}`
      : `You are a specialized agent. Complete the given task. Working directory: ${this.options.cwd}`;

    const loop = new ConversationLoop({
      provider: this.options.provider,
      tools,
      model: this.resolveModel(def.model),
      systemPrompt,
      maxTurns: def.maxTurns ?? 30,
      thinking: { type: 'adaptive' },
      effort: 'high',
      cwd: this.options.cwd,
      sessionId: `subagent-${this.agentId}`,
    });

    let resultText = '';
    let isError = false;
    let numTurns = 0;

    for await (const msg of loop.run(prompt)) {
      if (msg.type === 'result') {
        if ('result' in msg) {
          resultText = (msg as any).result ?? '';
        }
        isError = msg.is_error;
        numTurns = msg.num_turns;
      }
    }

    return {
      agentId: this.agentId,
      result: resultText,
      isError,
      numTurns,
      durationMs: Date.now() - startTime,
    };
  }

  private resolveModel(model?: string): string {
    // Map shorthand to full model names
    switch (model) {
      case 'sonnet': return 'claude-sonnet-4-6';
      case 'opus': return 'claude-opus-4-6';
      case 'haiku': return 'claude-haiku-4-5-20251001';
      default: return this.options.provider.name === 'anthropic' ? 'claude-sonnet-4-6' : 'gpt-4o';
    }
  }

  getAgentId(): string {
    return this.agentId;
  }
}
