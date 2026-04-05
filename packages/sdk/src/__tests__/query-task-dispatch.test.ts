import { describe, expect, it } from 'bun:test';
import type { ChatOptions, LLMProvider, Message, StreamEvent } from '@open-agent/providers';
import type { Query, WorkerRecord } from '../types.js';
import { query } from '../query.js';
import { makeLockedTempHome as makeTempHome } from './temp-home.js';

function makeBackgroundWorkerProvider(): LLMProvider {
  return {
    name: 'mock-task-dispatch-provider',
    async *chat(_messages: Message[], options: ChatOptions): AsyncGenerator<StreamEvent> {
      await new Promise<void>((resolve) => {
        if (options.signal?.aborted) {
          resolve();
          return;
        }
        options.signal?.addEventListener('abort', () => resolve(), { once: true });
      });

      throw new Error('task dispatch worker aborted for test');
    },
    async listModels() {
      return [{ value: 'mock-model', displayName: 'Mock Model', description: 'Task dispatch test model' }];
    },
  };
}

async function waitForWorkerStatus(
  q: Query,
  workerId: string,
  expectedStatus: WorkerRecord['status'],
): Promise<void> {
  const timeoutAt = Date.now() + 2_000;
  while (Date.now() < timeoutAt) {
    const worker = await q.getWorker(workerId);
    if (worker?.status === expectedStatus) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('query() task dispatch control plane', () => {
  it('claims the next task and launches a worker through one SDK call', async () => {
    const temp = makeTempHome('open-agent-sdk-task-dispatch-');
    const teamName = `alpha-team-${Date.now()}`;

    try {
      const q = query('dispatch task worker', {
        cwd: temp.cwd,
        model: 'mock-model',
        provider: makeBackgroundWorkerProvider(),
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
      } as any);

      await q.createTeam({ name: teamName, setActive: true });
      const createdTask = await q.createTask({
        teamName,
        subject: 'Investigate parser crash',
        description: 'Reproduce the parser crash, isolate the root cause, and land a fix.',
        activeForm: 'Investigating parser crash',
        priority: 5,
      });

      const dispatched = await q.dispatchNextTask({
        owner: 'worker-1',
        teamName,
      });

      expect(dispatched).not.toBeNull();
      expect(dispatched?.task.id).toBe(createdTask.id);
      expect(dispatched?.task.status).toBe('in_progress');
      expect(dispatched?.task.owner).toBe('worker-1');
      expect(dispatched?.task.lease?.owner).toBe('worker-1');
      expect(dispatched?.worker.workerType).toBe('worker');
      expect(dispatched?.worker.teamName).toBe(teamName);
      expect(dispatched?.worker.name).toBe('Investigate parser crash');

      const persistedTask = await q.getTask(createdTask.id, { teamName });
      expect(persistedTask?.status).toBe('in_progress');
      expect(persistedTask?.lease?.owner).toBe('worker-1');

      expect(await q.stopWorker(dispatched!.worker.workerId)).toEqual({ success: true });
      await waitForWorkerStatus(q, dispatched!.worker.workerId, 'shutdown');
      await q.releaseTask(createdTask.id, 'worker-1', { teamName, status: 'completed' });

      const completedTask = await q.getTask(createdTask.id, { teamName });
      expect(completedTask?.status).toBe('completed');
      q.close();
    } finally {
      temp.cleanup();
    }
  });

  it('returns null when there is no claimable task to dispatch', async () => {
    const temp = makeTempHome('open-agent-sdk-task-dispatch-empty-');
    const teamName = `alpha-team-${Date.now()}`;

    try {
      const q = query('dispatch without task', {
        cwd: temp.cwd,
        model: 'mock-model',
        provider: makeBackgroundWorkerProvider(),
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
      } as any);

      await q.createTeam({ name: teamName, setActive: true });
      await expect(q.dispatchNextTask({ owner: 'worker-2', teamName })).resolves.toBeNull();
      q.close();
    } finally {
      temp.cleanup();
    }
  });
});
