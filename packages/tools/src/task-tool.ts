import type { ToolDefinition, ToolContext } from './types.js';

// Avoid circular dependency: runner factory is injected via deps
export interface TaskToolDeps {
  runSubagent: (params: {
    prompt: string;
    subagentType: string;
    name?: string;
    model?: string;
    cwd: string;
  }) => Promise<{ agentId: string; result: string; isError: boolean; numTurns: number; durationMs: number }>;
}

export function createTaskTool(deps: TaskToolDeps): ToolDefinition {
  return {
    name: 'Task',
    description: 'Launch a new agent to handle complex, multi-step tasks autonomously. Specify subagent_type to choose the agent type and prompt to describe the task.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'The task for the agent to perform',
        },
        subagent_type: {
          type: 'string',
          description: 'The type of specialized agent: Explore, Plan, code-writer, architecture-logic-reviewer, general-purpose',
        },
        description: {
          type: 'string',
          description: 'A short (3-5 word) description of the task',
        },
        name: {
          type: 'string',
          description: 'Optional name for the spawned agent',
        },
        model: {
          type: 'string',
          description: 'Optional model to use: sonnet, opus, haiku',
          enum: ['sonnet', 'opus', 'haiku'],
        },
      },
      required: ['prompt', 'subagent_type'],
    },
    async execute(input: any, context: ToolContext): Promise<string> {
      const { prompt, subagent_type, name, model } = input;

      if (!prompt || !subagent_type) {
        return 'Error: prompt and subagent_type are required';
      }

      try {
        const result = await deps.runSubagent({
          prompt,
          subagentType: subagent_type,
          name,
          model,
          cwd: context.cwd,
        });

        if (result.isError) {
          return `Agent ${result.agentId} encountered an error after ${result.numTurns} turns (${result.durationMs}ms):\n${result.result}`;
        }

        return `${result.result}\n\nagentId: ${result.agentId} (for resuming)\n<usage>total_tokens: unknown\ntool_uses: ${result.numTurns}\nduration_ms: ${result.durationMs}</usage>`;
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return `Error launching subagent: ${msg}`;
      }
    },
  };
}
