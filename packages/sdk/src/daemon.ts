/**
 * Daemon primitives — scheduled task watcher, missed task notification,
 * and remote control bridge connection.
 * @internal
 */

import type {
  CronTask,
  CronJitterConfig,
  ScheduledTaskEvent,
  ScheduledTasksHandle,
  ConnectRemoteControlOptions,
  RemoteControlHandle,
} from './sdk-types-complete.js';
import { readFileSync, watchFile, unwatchFile } from 'fs';
import { join } from 'path';

const SCHEDULED_TASKS_FILE = 'scheduled_tasks.json';

function loadTasks(dir: string): CronTask[] {
  try {
    const path = join(dir, '.claude', SCHEDULED_TASKS_FILE);
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return [];
  }
}

function shouldFire(task: CronTask, now: number, jitter?: CronJitterConfig): boolean {
  // Simple cron check — for full implementation use a cron parser
  // This checks if enough time has passed since creation
  const age = now - task.createdAt;
  if (!task.recurring) {
    // One-shot: fire if created more than 1 minute ago and not yet fired
    const maxDelay = jitter?.oneShotMaxMs ?? 60_000;
    return age > 0 && age < maxDelay;
  }
  // Recurring: simplified — in production, parse the cron expression
  return age > 0;
}

/**
 * Watch scheduled_tasks.json and yield events as tasks fire.
 * @internal
 */
export function watchScheduledTasks(opts: {
  dir: string;
  signal: AbortSignal;
  getJitterConfig?: () => CronJitterConfig;
}): ScheduledTasksHandle {
  let nextFireTime: number | null = null;
  const firedIds = new Set<string>();

  async function* generateEvents(): AsyncGenerator<ScheduledTaskEvent> {
    // Initial load — check for missed tasks
    const initial = loadTasks(opts.dir);
    const now = Date.now();
    const missed = initial.filter(
      (t) =>
        !t.recurring &&
        now - t.createdAt > (opts.getJitterConfig?.()?.oneShotMaxMs ?? 60_000),
    );
    if (missed.length > 0) {
      yield { type: 'missed', tasks: missed };
    }

    // Watch for changes
    const tasksPath = join(opts.dir, '.claude', SCHEDULED_TASKS_FILE);
    let resolve: (() => void) | null = null;
    const onChange = () => {
      resolve?.();
    };

    try {
      watchFile(tasksPath, { interval: 5000 }, onChange);
    } catch {
      // File may not exist yet — that is OK
    }

    while (!opts.signal.aborted) {
      const tasks = loadTasks(opts.dir);
      const jitter = opts.getJitterConfig?.();
      const currentTime = Date.now();

      for (const task of tasks) {
        if (firedIds.has(task.id)) continue;
        if (shouldFire(task, currentTime, jitter)) {
          firedIds.add(task.id);
          yield { type: 'fire', task };
        }
      }

      // Calculate next fire time
      const unfired = tasks.filter((t) => !firedIds.has(t.id));
      nextFireTime =
        unfired.length > 0
          ? Math.min(...unfired.map((t) => t.createdAt + 60_000))
          : null;

      // Wait for file change or abort
      await new Promise<void>((r) => {
        resolve = r;
        const onAbort = () => r();
        opts.signal.addEventListener('abort', onAbort, { once: true });
        setTimeout(r, 10_000); // poll every 10s as fallback
      });
    }

    try {
      unwatchFile(tasksPath, onChange);
    } catch {
      // Best-effort cleanup
    }
  }

  return {
    events: generateEvents,
    getNextFireTime: () => nextFireTime,
  };
}

/**
 * Format missed tasks into a user-facing notification.
 * @internal
 */
export function buildMissedTaskNotification(missed: CronTask[]): string {
  if (missed.length === 0) return '';
  const lines = [
    `${missed.length} scheduled task${missed.length > 1 ? 's' : ''} missed while offline:`,
    '',
    ...missed.map(
      (t, i) =>
        `  ${i + 1}. [${t.id}] ${t.prompt.slice(0, 100)}${t.prompt.length > 100 ? '...' : ''}`,
    ),
    '',
    'Would you like me to execute these now? (Use AskUserQuestion to confirm each)',
  ];
  return lines.join('\n');
}

/**
 * Connect to a claude.ai remote control bridge.
 * Stub — full implementation requires WebSocket + OAuth.
 * @internal
 */
export async function connectRemoteControl(
  _options: ConnectRemoteControlOptions,
): Promise<RemoteControlHandle> {
  // Stub implementation — the real version needs WebSocket connection to claude.ai
  throw new Error(
    'connectRemoteControl requires a claude.ai WebSocket bridge connection. ' +
      'This is a stub — implement the full bridge in a dedicated module.',
  );
}
