import type { ToolDefinition, ToolContext } from './types.js';

// Avoid circular dependency: runner factory is injected via deps
export interface TaskToolDeps {
  runSubagent: (params: {
    prompt: string;
    subagentType: string;
    name?: string;
    model?: string;
    cwd?: string;
    maxTurns?: number;
    mode?: string;
    isolation?: string;
    runInBackground?: boolean;
    resume?: string;
    teamName?: string;
  }) => Promise<string>;

  // Background agent management
  getBackgroundAgent?: (agentId: string) => {
    status: 'running' | 'completed' | 'failed';
    output_file: string;
    result?: string;
  } | null;
}

export function createTaskTool(deps: TaskToolDeps): ToolDefinition {
  return {
    name: 'Task',
    description: 'Launch a new agent to handle complex, multi-step tasks autonomously. Specify subagent_type to choose the agent type and prompt to describe the task.',
    inputSchema: {
      type: 'object',
      properties: {
        description: {
          type: 'string',
          description: 'A short (3-5 word) description of the task',
        },
        prompt: {
          type: 'string',
          description: 'The task for the agent to perform',
        },
        subagent_type: {
          type: 'string',
          description: 'The type of specialized agent to use',
        },
        isolation: {
          type: 'string',
          enum: ['worktree'],
          description: 'Isolation mode. "worktree" creates a temporary git worktree.',
        },
        run_in_background: {
          type: 'boolean',
          description: 'Set to true to run this agent in the background.',
        },
        max_turns: {
          type: 'integer',
          description: 'Maximum number of agentic turns before stopping.',
          exclusiveMinimum: 0,
        },
        mode: {
          type: 'string',
          enum: ['acceptEdits', 'bypassPermissions', 'default', 'dontAsk', 'plan'],
          description: 'Permission mode for spawned teammate.',
        },
        model: {
          type: 'string',
          enum: ['sonnet', 'opus', 'haiku'],
          description: 'Optional model to use for this agent.',
        },
        name: {
          type: 'string',
          description: 'Name for the spawned agent',
        },
        resume: {
          type: 'string',
          description: 'Optional agent ID to resume from.',
        },
        team_name: {
          type: 'string',
          description: 'Team name for spawning.',
        },
      },
      required: ['description', 'prompt', 'subagent_type'],
      additionalProperties: false,
    },
    async execute(input: any, ctx: ToolContext): Promise<string> {
      const {
        description,
        prompt,
        subagent_type,
        isolation,
        run_in_background,
        max_turns,
        mode,
        model,
        name,
        resume,
        team_name,
      } = input;

      try {
        // runSubagent handles all logic (foreground/background/worktree)
        // and returns the final formatted JSON string directly.
        return await deps.runSubagent({
          prompt,
          subagentType: subagent_type,
          name,
          model,
          cwd: ctx.cwd,
          maxTurns: max_turns,
          mode,
          isolation,
          runInBackground: run_in_background,
          resume,
          teamName: team_name,
        });
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return `Error launching subagent (${description}): ${msg}`;
      }
    },
  };
}
