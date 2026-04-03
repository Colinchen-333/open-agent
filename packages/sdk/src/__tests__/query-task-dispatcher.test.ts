import { describe, expect, it } from 'bun:test';
import { randomUUID } from 'crypto';
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
        (item) => item.status === 'running' && item.activeAssignments.length === 0,
      );
      expect(idleDispatcher.lastDispatchAt).toBeTruthy();
      expect(idleDispatcher.activeAssignments).toEqual([]);

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
        (item) => item.status === 'running' && item.activeAssignments.length === 1,
      );
      expect(activeDispatcher.activeTaskIds).toEqual([task.id]);
      expect(activeDispatcher.activeAssignments).toHaveLength(1);
      expect(activeDispatcher.activeAssignments[0]?.taskId).toBe(task.id);
      expect(activeDispatcher.activeAssignments[0]?.workerId).toBe(activeDispatcher.activeWorkerIds[0]);
      expect(activeDispatcher.activeAssignments[0]?.claimedAt).toBeTruthy();
      expect(activeDispatcher.activeAssignments[0]?.lastHeartbeatAt).toBeTruthy();
      expect(activeDispatcher.activeAssignments[0]?.leaseExpiresAt).toBeTruthy();
      expect(activeDispatcher.activeAssignments[0]?.attempts).toBe(1);

      const inspectedDispatcher = await q.getTaskDispatcher(dispatcher.dispatcherId);
      expect(inspectedDispatcher?.dispatcherId).toBe(dispatcher.dispatcherId);
      expect(inspectedDispatcher?.activeAssignments).toEqual(activeDispatcher.activeAssignments);

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
        activeAssignments: [],
      });

      q.close();
    } finally {
      temp.cleanup();
    }
  });

  it('inspects active assignments and can force them back to pending', async () => {
    const temp = makeTempHome('open-agent-sdk-task-dispatcher-requeue-');
    const teamName = `dispatcher-team-${Date.now()}`;
    const controlledFailure = makeControlledFailureProvider();

    try {
      const q = query('dispatcher requeue', {
        cwd: temp.cwd,
        model: 'mock-model',
        provider: controlledFailure.provider,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
      } as any);

      await q.createTeam({ name: teamName, setActive: true });
      const task = await q.createTask({
        teamName,
        subject: 'Recover stuck assignment',
        description: 'Force the active assignment back to pending.',
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
        (item) => item.status === 'running' && item.activeAssignments.length === 1,
      );
      const assignment = activeDispatcher.activeAssignments[0]!;
      expect(assignment.taskId).toBe(task.id);
      expect(assignment.workerId).toBeTruthy();
      expect(assignment.claimedAt).toBeTruthy();
      expect(assignment.leaseExpiresAt).toBeTruthy();

      await expect(q.stopTaskDispatcher(dispatcher.dispatcherId)).resolves.toMatchObject({
        success: true,
        dispatcher: { status: 'draining' },
      });

      const requeued = await q.requeueTaskDispatcherAssignment({
        dispatcherId: dispatcher.dispatcherId,
        taskId: task.id,
      });
      expect(requeued.success).toBe(true);
      expect(requeued.workerStop?.success).toBe(true);
      expect(requeued.task?.status).toBe('pending');
      expect(requeued.task?.lease).toBeUndefined();
      expect(requeued.dispatcher?.status).toBe('stopped');
      expect(requeued.dispatcher?.activeAssignments).toEqual([]);

      const persistedTask = await waitForTask(
        q,
        task.id,
        teamName,
        (item) => item.status === 'pending' && !item.owner && !item.lease,
      );
      expect(persistedTask.status).toBe('pending');

      await expect(q.getTaskDispatcher(dispatcher.dispatcherId)).resolves.toMatchObject({
        dispatcherId: dispatcher.dispatcherId,
        status: 'stopped',
        activeAssignments: [],
      });

      q.close();
    } finally {
      temp.cleanup();
    }
  });

  it('rebuilds dispatcher ledger from durable storage and reports structured health findings', async () => {
    const temp = makeTempHome('open-agent-sdk-task-dispatcher-health-');
    const teamName = `dispatcher-team-${Date.now()}`;
    const sessionId = randomUUID();
    const controlledFailure = makeControlledFailureProvider();

    try {
      const writer = query('dispatcher health writer', {
        cwd: temp.cwd,
        model: 'mock-model',
        provider: controlledFailure.provider,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        sessionId,
      } as any);

      await writer.createTeam({ name: teamName, setActive: true });
      const task = await writer.createTask({
        teamName,
        subject: 'Persist dispatcher diagnostics',
        description: 'Keep assignment state in transcript for later inspection.',
        priority: 1,
      });

      const dispatcher = await writer.startTaskDispatcher({
        dispatcherId: `dispatcher-${Date.now()}`,
        owner: 'dispatcher-owner',
        teamName,
        pollIntervalMs: 25,
        leaseMs: 500,
      });

      const liveDispatcher = await waitForDispatcher(
        writer,
        dispatcher.dispatcherId,
        (item) => item.status === 'running' && item.activeAssignments.length === 1,
      );
      expect(liveDispatcher.source).toBe('live');

      await expect(writer.stopTaskDispatcher(dispatcher.dispatcherId)).resolves.toMatchObject({
        success: true,
        dispatcher: { status: 'draining' },
      });
      const drainingDispatcher = await waitForDispatcher(
        writer,
        dispatcher.dispatcherId,
        (item) => item.status === 'draining' && item.activeAssignments.length === 1,
      );

      const reader = query('dispatcher health reader', {
        cwd: temp.cwd,
        model: 'mock-model',
        provider: makeCompletingWorkerProvider(),
        sessionId,
      } as any);

      const recovered = await reader.getTaskDispatcher(dispatcher.dispatcherId);
      expect(recovered?.source).toBe('ledger');
      expect(recovered?.status).toBe('draining');
      expect(recovered?.activeAssignments).toHaveLength(1);
      expect(recovered?.activeAssignments[0]?.taskId).toBe(task.id);
      expect((await reader.listTaskDispatchers()).some((item) =>
        item.dispatcherId === dispatcher.dispatcherId && item.source === 'ledger',
      )).toBe(true);

      const health = await reader.inspectTaskDispatcherHealth(dispatcher.dispatcherId, {
        now: new Date(Date.parse(drainingDispatcher.updatedAt) + 60_000),
        heartbeatGraceMs: 1,
        drainingTimeoutMs: 1,
      });
      expect(health?.healthy).toBe(false);
      expect(health?.source).toBe('ledger');
      expect(health?.summary).toEqual(expect.objectContaining({
        totalFindings: 3,
        errorCount: 1,
        warningCount: 2,
      }));
      expect(health?.summary.affectedTaskIds).toEqual([task.id]);
      expect(health?.summary.affectedWorkerIds).toHaveLength(1);
      expect(health?.findings.map((item) => item.code)).toEqual(expect.arrayContaining([
        'lease_expired',
        'stuck_assignment',
        'draining_timeout',
      ]));
      expect(health?.followUps.some((item) =>
        item.scaffold.action?.tool === 'TaskDispatcher'
        && item.scaffold.action.arguments['action'] === 'requeue',
      )).toBe(true);
      expect(health?.followUps.some((item) =>
        item.scaffold.action?.tool === 'TaskDispatcher'
        && item.scaffold.action.arguments['action'] === 'start',
      )).toBe(true);
      await expect(reader.getTaskDispatcherDiagnosis(dispatcher.dispatcherId)).resolves.toMatchObject({
        dispatcherId: dispatcher.dispatcherId,
        healthy: false,
      });
      await expect(reader.listTaskDispatcherDiagnoses({ teamName })).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({
          dispatcherId: dispatcher.dispatcherId,
          healthy: false,
        }),
      ]));

      reader.close();
      writer.close();
    } finally {
      controlledFailure.releaseFailure();
      temp.cleanup();
    }
  });

  it('builds a unified orchestration control-plane snapshot from task, worker, and dispatcher state', async () => {
    const temp = makeTempHome('open-agent-sdk-orchestration-control-plane-');
    const teamName = `dispatcher-team-${Date.now()}`;
    const controlledFailure = makeControlledFailureProvider();

    try {
      const q = query('orchestration snapshot', {
        cwd: temp.cwd,
        model: 'mock-model',
        provider: controlledFailure.provider,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
      } as any);

      await q.createTeam({ name: teamName, setActive: true });
      const task = await q.createTask({
        teamName,
        subject: 'Snapshot task',
        description: 'Validate unified orchestration control plane.',
        priority: 3,
      });
      const dispatcher = await q.startTaskDispatcher({
        dispatcherId: `dispatcher-${Date.now()}`,
        owner: 'dispatcher-owner',
        teamName,
        pollIntervalMs: 25,
        leaseMs: 500,
      });

      const runningDispatcher = await waitForDispatcher(
        q,
        dispatcher.dispatcherId,
        (item) => item.status === 'running' && item.activeAssignments.length === 1,
      );
      const workerId = runningDispatcher.activeAssignments[0]!.workerId;

      const snapshot = await q.readOrchestrationControlPlane({ teamName });
      expect(snapshot.activeTeamName).toBe(teamName);
      expect(snapshot.tasks).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: task.id, teamName }),
      ]));
      expect(snapshot.workers).toEqual(expect.arrayContaining([
        expect.objectContaining({ workerId, teamName }),
      ]));
      expect(snapshot.dispatchers).toEqual(expect.arrayContaining([
        expect.objectContaining({ dispatcherId: dispatcher.dispatcherId, teamName }),
      ]));

      const report = await q.inspectTaskDispatcherHealth(dispatcher.dispatcherId, {
        now: new Date(Date.now() + 2_000),
      });
      expect(report).not.toBeNull();

      const snapshotWithDiagnosis = await q.readOrchestrationControlPlane({ teamName });
      expect(snapshotWithDiagnosis.dispatcherDiagnoses).toEqual(expect.arrayContaining([
        expect.objectContaining({ dispatcherId: dispatcher.dispatcherId }),
      ]));

      q.close();
    } finally {
      controlledFailure.releaseFailure();
      temp.cleanup();
    }
  });
});
