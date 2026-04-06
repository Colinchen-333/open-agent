import { withToolDefaults } from './tool-defaults.js';
import type { ToolDefinition } from './types.js';

// ---------------------------------------------------------------------------
// In-process cron job store (module-level singleton).
// Replaced per process; does not survive restarts.  The actual scheduling /
// firing logic lives outside this file (in ConversationLoop or a future
// CronScheduler class).  These tools manage the job registry only.
// ---------------------------------------------------------------------------

export interface CronJob {
  id: string;
  /** 5-field cron expression, e.g. "every-5-minutes * * * *" */
  cron: string;
  /** The prompt to enqueue at each fire time */
  prompt: string;
  /** When false the job is deleted after firing once */
  recurring: boolean;
  createdAt: number;
}

// Exported so tests and ConversationLoop can inspect / mutate directly.
export const cronJobStore = new Map<string, CronJob>();
let _nextId = 1;

/** Reset the store — intended for tests only. */
export function _resetCronStore(): void {
  cronJobStore.clear();
  _nextId = 1;
}

// ---------------------------------------------------------------------------
// CronCreate
// ---------------------------------------------------------------------------

export function createCronCreateTool(): ToolDefinition {
  return withToolDefaults({
    name: 'CronCreate',
    description:
      'Schedule a prompt to run on a cron schedule. Returns a job ID that can be ' +
      'used with CronDelete to cancel the job.',
    inputSchema: {
      type: 'object',
      properties: {
        cron: {
          type: 'string',
          description: 'Cron expression (5-field UTC, e.g. "*/5 * * * *")',
        },
        prompt: {
          type: 'string',
          description: 'The prompt to enqueue at each scheduled fire time',
        },
        recurring: {
          type: 'boolean',
          description: 'true for a recurring job, false for one-shot (default: true)',
        },
      },
      required: ['cron', 'prompt'],
    },
    capability: { category: 'task', risk: 'medium' },
    shouldDefer: true,
    async execute(input: { cron: string; prompt: string; recurring?: boolean }) {
      const id = `cron-${_nextId++}`;
      const job: CronJob = {
        id,
        cron: input.cron,
        prompt: input.prompt,
        recurring: input.recurring !== false,
        createdAt: Date.now(),
      };
      cronJobStore.set(id, job);
      return {
        id,
        cron: job.cron,
        prompt: job.prompt,
        recurring: job.recurring,
        createdAt: job.createdAt,
        message: `Scheduled job ${id} with cron "${job.cron}".`,
      };
    },
  });
}

// ---------------------------------------------------------------------------
// CronList
// ---------------------------------------------------------------------------

export function createCronListTool(): ToolDefinition {
  return withToolDefaults({
    name: 'CronList',
    description: 'List all currently scheduled cron jobs.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    capability: { category: 'task', risk: 'low' },
    annotations: { readOnly: true },
    shouldDefer: true,
    async execute() {
      const jobs = [...cronJobStore.values()];
      return {
        count: jobs.length,
        jobs,
      };
    },
  });
}

// ---------------------------------------------------------------------------
// CronDelete
// ---------------------------------------------------------------------------

export function createCronDeleteTool(): ToolDefinition {
  return withToolDefaults({
    name: 'CronDelete',
    description: 'Cancel a scheduled cron job by its ID.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Job ID to cancel (as returned by CronCreate)',
        },
      },
      required: ['id'],
    },
    capability: { category: 'task', risk: 'low' },
    shouldDefer: true,
    async execute(input: { id: string }) {
      const existed = cronJobStore.delete(input.id);
      return {
        deleted: existed,
        id: input.id,
        message: existed
          ? `Job ${input.id} cancelled.`
          : `Job ${input.id} not found.`,
      };
    },
  });
}
