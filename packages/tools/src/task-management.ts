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

export interface BackgroundAgentInfo {
  status: 'running' | 'completed' | 'failed';
  output_file: string;
  result?: string;
}

export interface TaskManagementDeps {
  getBackgroundAgent?: (agentId: string) => BackgroundAgentInfo | null;
  stopBackgroundAgent?: (agentId: string) => boolean;
}

export function createTaskOutputTool(deps?: TaskManagementDeps): ToolDefinition {
  return {
    name: 'TaskOutput',
    description: 'Retrieves output from a running or completed task (background shell command or background agent).',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'The task ID to get output from' },
        block: {
          type: 'boolean',
          default: true,
          description: 'Whether to wait for task completion before returning',
        },
        timeout: {
          type: 'number',
          default: 30000,
          description: 'Max wait time in milliseconds',
          maximum: 600000,
          minimum: 0,
        },
      },
      required: ['task_id'],
    },
    async execute(input: any, _ctx: ToolContext): Promise<string> {
      const taskId = input.task_id as string;
      const shouldBlock: boolean = input.block ?? true;
      const timeoutMs: number = Math.min(input.timeout ?? 30000, 600000);

      // First check Bash background tasks
      const bashTask = backgroundTasks.get(taskId);
      if (bashTask) {
        if (shouldBlock && bashTask.status === 'running') {
          const deadline = Date.now() + timeoutMs;
          while (bashTask.status === 'running' && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
        }

        return JSON.stringify({
          task_id: taskId,
          type: 'bash',
          status: bashTask.status,
          output: bashTask.output,
          durationMs: Date.now() - bashTask.startTime,
        });
      }

      // Then check background agents
      if (deps?.getBackgroundAgent) {
        const agentInfo = deps.getBackgroundAgent(taskId);
        if (agentInfo) {
          if (shouldBlock && agentInfo.status === 'running') {
            const deadline = Date.now() + timeoutMs;
            while (Date.now() < deadline) {
              const current = deps.getBackgroundAgent!(taskId);
              if (!current || current.status !== 'running') break;
              await new Promise((resolve) => setTimeout(resolve, 1000));
            }
            // Fetch final state after waiting
            const finalInfo = deps.getBackgroundAgent(taskId);
            if (finalInfo) {
              return JSON.stringify({
                task_id: taskId,
                type: 'agent',
                status: finalInfo.status,
                output_file: finalInfo.output_file,
                result: finalInfo.result,
              });
            }
          }

          return JSON.stringify({
            task_id: taskId,
            type: 'agent',
            status: agentInfo.status,
            output_file: agentInfo.output_file,
            result: agentInfo.result,
          });
        }
      }

      return `Error: No task found with ID "${taskId}". The task may have expired or the ID is incorrect.`;
    },
  };
}

export function createTaskStopTool(deps?: TaskManagementDeps): ToolDefinition {
  return {
    name: 'TaskStop',
    description: 'Stops a running background task (shell command or agent) by its ID.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'The ID of the background task to stop',
        },
      },
      required: ['task_id'],
    },
    async execute(input: any, _ctx: ToolContext): Promise<string> {
      const taskId = input.task_id as string;

      // Try Bash background task first
      const bashTask = backgroundTasks.get(taskId);
      if (bashTask) {
        if (bashTask.process && bashTask.status === 'running') {
          bashTask.process.kill();
          bashTask.status = 'completed';
          bashTask.output += '\n[Task stopped by user]';
          return JSON.stringify({ success: true, task_id: taskId, type: 'bash' });
        }
        return JSON.stringify({ success: false, task_id: taskId, type: 'bash', reason: 'Task is not running' });
      }

      // Try background agent
      if (deps?.stopBackgroundAgent) {
        const stopped = deps.stopBackgroundAgent(taskId);
        if (stopped) {
          return JSON.stringify({ success: true, task_id: taskId, type: 'agent' });
        }
        // Agent existed but couldn't be stopped (not running)
        if (deps.getBackgroundAgent?.(taskId)) {
          return JSON.stringify({ success: false, task_id: taskId, type: 'agent', reason: 'Agent is not running' });
        }
      }

      return `Error: No task found with ID "${taskId}". The task may have already completed or the ID is incorrect.`;
    },
  };
}
