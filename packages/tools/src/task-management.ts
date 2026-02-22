import type { ToolDefinition, ToolContext } from './types.js';

interface BackgroundTask {
  process?: any;
  output: string;
  status: 'running' | 'completed' | 'error';
  startTime: number;
}

// Module-level map shared across all tool instances
const backgroundTasks = new Map<string, BackgroundTask>();

export function getBackgroundTasks(): Map<string, BackgroundTask> {
  return backgroundTasks;
}

export function createTaskOutputTool(): ToolDefinition {
  return {
    name: 'TaskOutput',
    description: 'Retrieve output from a running or completed background task.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'The task ID to get output from' },
        block: {
          type: 'boolean',
          default: true,
          description: 'Whether to wait for task completion',
        },
        timeout: {
          type: 'number',
          default: 30000,
          description: 'Max wait time in milliseconds',
        },
      },
      required: ['task_id', 'block', 'timeout'],
    },
    async execute(input: any, _ctx: ToolContext) {
      const task = backgroundTasks.get(input.task_id as string);
      if (!task) {
        return `Error: No task found with ID ${input.task_id}`;
      }

      if (input.block && task.status === 'running') {
        const deadline = Date.now() + ((input.timeout as number) ?? 30000);
        while (task.status === 'running' && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }

      return {
        task_id: input.task_id,
        status: task.status,
        output: task.output,
        durationMs: Date.now() - task.startTime,
      };
    },
  };
}

export function createTaskStopTool(): ToolDefinition {
  return {
    name: 'TaskStop',
    description: 'Stop a running background task.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'The task ID to stop' },
        shell_id: {
          type: 'string',
          description: 'Deprecated: use task_id instead',
        },
      },
    },
    async execute(input: any, _ctx: ToolContext) {
      const taskId: string = (input.task_id ?? input.shell_id) as string;
      const task = backgroundTasks.get(taskId);
      if (!task) {
        return `Error: No task found with ID ${taskId}`;
      }

      if (task.process && task.status === 'running') {
        task.process.kill();
        task.status = 'completed';
        task.output += '\n[Task stopped by user]';
      }

      return { success: true, task_id: taskId };
    },
  };
}
