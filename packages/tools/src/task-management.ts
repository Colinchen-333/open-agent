import { existsSync, readFileSync } from 'fs';
import { buildTaskOrchestrationTemplates } from '@open-agent/core';
import type { ToolDefinition, ToolContext } from './types.js';
import {
  getBackgroundTask,
  getBackgroundTaskRegistry,
  updateBackgroundTask,
  type BackgroundTaskRecord,
} from './background-registry.js';
import { isPidRunning } from './background-task-store.js';

export function getBackgroundTasks(): Map<string, BackgroundTaskRecord> {
  return getBackgroundTaskRegistry();
}

export interface BackgroundAgentInfo {
  status: 'running' | 'completed' | 'failed' | 'stopped';
  output_file: string;
  result?: string;
  summary?: string;
  team_name?: string;
  description?: string;
  usage?: {
    total_tokens: number;
    tool_uses: number;
    duration_ms: number;
  };
}

export interface TaskManagementDeps {
  getBackgroundAgent?: (agentId: string) => BackgroundAgentInfo | null;
  stopBackgroundAgent?: (agentId: string) => boolean;
}

function summarizeResult(text?: string): string {
  const raw = typeof text === 'string' ? text.trim() : '';
  if (!raw) return 'Background task has no summary yet.';
  return raw.length > 200 ? `${raw.slice(0, 200)}…` : raw;
}

function readBackgroundOutput(output: string, outputFile?: string): string {
  if (output.trim().length > 0) {
    return output;
  }
  if (outputFile && existsSync(outputFile)) {
    try {
      return readFileSync(outputFile, 'utf-8');
    } catch {
      return output;
    }
  }
  return output;
}

function buildAgentTaskEvent(taskId: string, info: BackgroundAgentInfo): Record<string, unknown> {
  if (info.status === 'running') {
    return {
      type: 'system',
      subtype: 'task_progress',
      task_id: taskId,
      ...(info.team_name ? { team_name: info.team_name } : {}),
      description: info.description ?? 'Background agent is still running.',
      usage: info.usage ?? {
        total_tokens: 0,
        tool_uses: 0,
        duration_ms: 0,
      },
    };
  }

  const orchestrationTemplates = buildTaskOrchestrationTemplates({
    taskId,
    status: info.status === 'stopped' ? 'stopped' : info.status,
    description: info.description,
    summary: info.summary,
    result: info.result,
  });

  return {
    type: 'system',
    subtype: 'task_notification',
    task_id: taskId,
    status: info.status === 'stopped' ? 'stopped' : info.status,
    ...(info.team_name ? { team_name: info.team_name } : {}),
    output_file: info.output_file,
    summary: info.summary ?? summarizeResult(info.result),
    orchestration_templates: orchestrationTemplates,
    ...(info.usage ? { usage: info.usage } : {}),
  };
}

export function createTaskOutputTool(deps?: TaskManagementDeps): ToolDefinition {
  return {
    name: 'TaskOutput',
    description: 'Retrieves output from a running or completed task (background shell command or background agent).',
    isReadOnly: true,
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
      const bashTask = getBackgroundTask(taskId);
      if (bashTask) {
        if (bashTask.status === 'running' && bashTask.pid && !isPidRunning(bashTask.pid)) {
          updateBackgroundTask(taskId, {
            status: 'completed',
            completed_time: Date.now(),
          });
        }

        if (shouldBlock && bashTask.status === 'running') {
          const deadline = Date.now() + timeoutMs;
          while (Date.now() < deadline) {
            const current = getBackgroundTask(taskId);
            if (!current || current.status !== 'running') break;
            if (current.pid && !isPidRunning(current.pid)) {
              updateBackgroundTask(taskId, {
                status: 'completed',
                completed_time: Date.now(),
              });
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
        }

        const latest = getBackgroundTask(taskId) ?? bashTask;
        return JSON.stringify({
          task_id: taskId,
          type: 'bash',
          status: latest.status,
          state: latest.status,
          output: readBackgroundOutput(latest.output, latest.output_file),
          durationMs: Date.now() - latest.start_time,
          ...(latest.output_file ? { output_file: latest.output_file } : {}),
          ...(latest.pid ? { pid: latest.pid } : {}),
          metadata: {
            task_id: latest.task_id,
            status: latest.status,
            start_time: latest.start_time,
            command: latest.command,
            summary: latest.summary,
            session_id: latest.session_id,
          },
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
                state: finalInfo.status,
                output_file: finalInfo.output_file,
                result: finalInfo.result,
                ...(finalInfo.team_name ? { team_name: finalInfo.team_name } : {}),
                ...(finalInfo.summary ? { summary: finalInfo.summary } : {}),
                ...(finalInfo.usage ? { usage: finalInfo.usage } : {}),
                ...(finalInfo.result ? { content: [{ type: 'text', text: finalInfo.result }] } : {}),
                ...(finalInfo.status === 'running'
                  ? {}
                  : {
                      orchestration_templates: buildTaskOrchestrationTemplates({
                        taskId,
                        status: finalInfo.status === 'stopped' ? 'stopped' : finalInfo.status,
                        description: finalInfo.description,
                        summary: finalInfo.summary,
                        result: finalInfo.result,
                      }),
                    }),
                task_event: buildAgentTaskEvent(taskId, finalInfo),
              });
            }
          }

          return JSON.stringify({
            task_id: taskId,
            type: 'agent',
            status: agentInfo.status,
            state: agentInfo.status,
            output_file: agentInfo.output_file,
            result: agentInfo.result,
            ...(agentInfo.team_name ? { team_name: agentInfo.team_name } : {}),
            ...(agentInfo.summary ? { summary: agentInfo.summary } : {}),
            ...(agentInfo.usage ? { usage: agentInfo.usage } : {}),
            ...(agentInfo.result ? { content: [{ type: 'text', text: agentInfo.result }] } : {}),
            ...(agentInfo.status === 'running'
              ? {}
              : {
                  orchestration_templates: buildTaskOrchestrationTemplates({
                    taskId,
                    status: agentInfo.status === 'stopped' ? 'stopped' : agentInfo.status,
                    description: agentInfo.description,
                    summary: agentInfo.summary,
                    result: agentInfo.result,
                  }),
                }),
            task_event: buildAgentTaskEvent(taskId, agentInfo),
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
      const bashTask = getBackgroundTask(taskId);
      if (bashTask) {
        if (bashTask.status === 'running' && (bashTask.process || bashTask.pid)) {
          if (bashTask.process) {
            bashTask.process.kill();
          } else if (bashTask.pid) {
            process.kill(bashTask.pid, 'SIGTERM');
          }
          updateBackgroundTask(taskId, {
            status: 'stopped',
            output: `${bashTask.output}\n[Task stopped by user]`,
            summary: `Stopped: ${bashTask.summary}`,
            completed_time: Date.now(),
          });
          return JSON.stringify({ success: true, task_id: taskId, type: 'bash', status: 'stopped', state: 'stopped' });
        }
        return JSON.stringify({ success: false, task_id: taskId, type: 'bash', reason: 'Task is not running' });
      }

      // Try background agent
      if (deps?.stopBackgroundAgent) {
        const stopped = deps.stopBackgroundAgent(taskId);
        if (stopped) {
          return JSON.stringify({ success: true, task_id: taskId, type: 'agent', status: 'stopped', state: 'stopped' });
        }
        // Agent existed but couldn't be stopped (not running)
        if (deps.getBackgroundAgent?.(taskId)) {
          return JSON.stringify({ success: false, task_id: taskId, type: 'agent', status: 'stopped', state: 'stopped', reason: 'Agent is not running' });
        }
      }

      return `Error: No task found with ID "${taskId}". The task may have already completed or the ID is incorrect.`;
    },
  };
}
