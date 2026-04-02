import { describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ChatOptions, LLMProvider, Message, StreamEvent } from '@open-agent/providers';
import type { Query, TaskDispatcherRecord, TaskRecord } from '../types.js';
import { query } from '../query.js';

function makeTempHome(prefix: string): { cwd: string; cleanup(): void } {
  const cwd = mkdtempSync(join(tmpdir(), prefix));
  const home = join(cwd, 'home');
  mkdirSync(home, { recursive: true });
  const originalHome = process.env.HOME;
  process.env.HOME = home;

  return {
    cwd,
    cleanup() {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      rmSync(cwd, { recursive: true, force: true });
    },
  };
}

function makeCompletingWorkerProvider(): LLMProvider {
  return {
    name: 'mock-task-dispatcher-complete-provider',
    async *chat(_messages: Message[], _options: ChatOptions): AsyncGenerator<StreamEvent> {
      yield { type: 'text_delta', text: 'working' };
      yield { type: 'message_end', message: {}, usage: { input_tokens: 5, output_tokens: 8 } };
    },
    async listModels() {
      return [{ value: 'mock-model', displayName: 'Mock Model', description: 'Task dispatcher complete test model' }];
    },
  };
}

function makeControlledFailureProvider(): { provider: LLMProvider; releaseFailure(): void } {
  let releaseFailure = () => {};

  return {
    provider: {
      name: 'mock-task-dispatcher-failure-provider',
      async *chat(_messages: Message[], options: ChatOptions): AsyncGenerator<StreamEvent> {
        await new Promise<void>((resolve) => {
          releaseFailure = resolve;
          if (options.signal?.aborted) {
            resolve();
            return;
          }
          options.signal?.addEventListener('abort', resolve, { once: true });
        });

        throw new Error('dispatcher worker failed for test');
      },
      async listModels() {
        return [{ value: 'mock-model', displayName: 'Mock Model', description: 'Task dispatcher failure test model' }];
      },
    },
    releaseFailure() {
      releaseFailure();
    },
  };
}

async function waitForTask(
  q: Query,
  taskId: string,
  teamName: string,
  predicate: (task: TaskRecord) => boolean,
): Promise<TaskRecord> {
  const timeoutAt = Date.now() + 4_000;
  while (Date.now() < timeoutAt) {
    const task = await q.getTask(taskId, { teamName });
    if (task && predicate(task)) {
      return task;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for task ${taskId}`);
}

async function waitForDispatcher(
  q: Query,
  dispatcherId: string,
  predicate: (dispatcher: TaskDispatcherRecord) => boolean,
): Promise<TaskDispatcherRecord> {
  const timeoutAt = Date.now() + 4_000;
  while (Date.now() < timeoutAt) {
    const dispatcher = (await q.listTaskDispatchers()).find((item) => item.dispatcherId === dispatcherId);
    if (dispatcher && predicate(dispatcher)) {
      return dispatcher;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for dispatcher ${dispatcherId}`);
}

describe('query() task dispatcher control plane', () => {
  it('continuously dispatches queued tasks and releases them on worker completion', async () => {
    const temp = makeTempHome('open-agent-sdk-task-dispatcher-');
    const teamName = `dispatcher-team-${Date.now()}`;

    try {
      const q = query('dispatcher loop', {
        cwd: temp.cwd,
        model: 'mock-model',
        provider: makeCompletingWorkerProvider(),
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
      } as any);

      await q.createTeam({ name: teamName, setActive: true });
      const firstTask = await q.createTask({
        teamName,
        subject: 'First queued task',
        description: 'Finish the first task',
        priority: 10,
      });
      const secondTask = await q.createTask({
        teamName,
        subject: 'Second queued task',
        description: 'Finish the second task',
        priority: 5,
      });

      const dispatcher = await q.startTaskDispatcher({
        dispatcherId: `dispatcher-${Date.now()}`,
        owner: 'dispatcher-owner',
        teamName,
        pollIntervalMs: 25,
        leaseMs: 500,
      });
      expect(dispatcher.status).toBe('running');

      const completedFirst = await waitForTask(q, firstTask.id, teamName, (task) => task.status === 'completed');
      const completedSecond = await waitForTask(q, secondTask.id, teamName, (task) => task.status === 'completed');
      expect(completedFirst.owner).toBe('dispatcher-owner');
      expect(completedSecond.owner).toBe('dispatcher-owner');

      const idleDispatcher = await waitForDispatcher(
        q,
        dispatcher.dispatcherId,
        (item) => item.status === 'running' && item.activeTaskIds.length === 0,
      );
      expect(idleDispatcher.lastDispatchAt).toBeTruthy();

      await expect(q.stopTaskDispatcher(dispatcher.dispatcherId)).resolves.toMatchObject({
        success: true,
        dispatcher: { status: 'stopped' },
      });
      q.close();
    } finally {
      temp.cleanup();
    }
  });

  it('drains active workers and returns failed tasks to pending when the dispatcher stops', async () => {
    const temp = makeTempHome('open-agent-sdk-task-dispatcher-failure-');
    const teamName = `dispatcher-team-${Date.now()}`;
    const controlledFailure = makeControlledFailureProvider();

    try {
      const q = query('dispatcher draining', {
        cwd: temp.cwd,
        model: 'mock-model',
        provider: controlledFailure.provider,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
      } as any);

      await q.createTeam({ name: teamName, setActive: true });
      const task = await q.createTask({
        teamName,
        subject: 'Recover failed task',
        description: 'This task should return to pending after failure.',
        priority: 1,
      });

      const dispatcher = await q.startTaskDispatcher({
        dispatcherId: `dispatcher-${Date.now()}`,
        owner: 'dispatcher-owner',
        teamName,
        pollIntervalMs: 25,
        leaseMs: 500,
      });

      const activeDispatcher = await waitForDispatcher(
        q,
        dispatcher.dispatcherId,
        (item) => item.status === 'running' && item.activeWorkerIds.length === 1,
      );
      expect(activeDispatcher.activeTaskIds).toEqual([task.id]);

      await expect(q.stopTaskDispatcher(dispatcher.dispatcherId)).resolves.toMatchObject({
        success: true,
        dispatcher: { status: 'draining' },
      });

      controlledFailure.releaseFailure();

      const pendingTask = await waitForTask(
        q,
        task.id,
        teamName,
        (item) => item.status === 'pending' && !item.owner && !item.lease,
      );
      expect(pendingTask.status).toBe('pending');

      await expect(
        waitForDispatcher(q, dispatcher.dispatcherId, (item) => item.status === 'stopped'),
      ).resolves.toMatchObject({
        activeTaskIds: [],
        activeWorkerIds: [],
      });

      q.close();
    } finally {
      temp.cleanup();
    }
  });
});
