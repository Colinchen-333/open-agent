import { describe, expect, it } from 'bun:test';
import { randomUUID } from 'crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { SessionManager } from '@open-agent/core';
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
          options.signal?.addEventListener('abort', () => resolve(), { once: true });
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

function makeControlledCompletionProvider(): {
  provider: LLMProvider;
  releaseNext(): void;
  waitForStarted(count: number): Promise<void>;
} {
  let startedCount = 0;
  const startedWaiters: Array<{ count: number; resolve: () => void }> = [];
  const releases: Array<() => void> = [];

  const flushStartedWaiters = () => {
    for (let i = startedWaiters.length - 1; i >= 0; i -= 1) {
      if (startedCount >= startedWaiters[i].count) {
        const waiter = startedWaiters.splice(i, 1)[0];
        waiter?.resolve();
      }
    }
  };

  return {
    provider: {
      name: 'mock-task-dispatcher-controlled-complete-provider',
      async *chat(_messages: Message[], options: ChatOptions): AsyncGenerator<StreamEvent> {
        startedCount += 1;
        flushStartedWaiters();
        await new Promise<void>((resolve) => {
          releases.push(resolve);
          if (options.signal?.aborted) {
            resolve();
            return;
          }
          options.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        yield { type: 'text_delta', text: 'done' };
        yield { type: 'message_end', message: {}, usage: { input_tokens: 5, output_tokens: 8 } };
      },
      async listModels() {
        return [{ value: 'mock-model', displayName: 'Mock Model', description: 'Task dispatcher controlled completion model' }];
      },
    },
    releaseNext() {
      const release = releases.shift();
      release?.();
    },
    waitForStarted(count: number) {
      if (startedCount >= count) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        startedWaiters.push({ count, resolve });
      });
    },
  };
}

async function waitForTask(
  q: Query,
  taskId: string,
  teamName: string,
  predicate: (task: TaskRecord) => boolean,
): Promise<TaskRecord> {
  const timeoutAt = Date.now() + 8_000;
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

async function waitForOrchestrationSnapshot(
  q: Query,
  teamName: string,
  predicate: (snapshot: Awaited<ReturnType<Query['readOrchestrationControlPlane']>>) => boolean,
): Promise<Awaited<ReturnType<Query['readOrchestrationControlPlane']>>> {
  const timeoutAt = Date.now() + 4_000;
  while (Date.now() < timeoutAt) {
    const snapshot = await q.readOrchestrationControlPlane({ teamName });
    if (predicate(snapshot)) {
      return snapshot;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for orchestration snapshot for team ${teamName}`);
}

async function waitForSchedulerSnapshot(
  q: Query,
  teamName: string,
  predicate: (scheduler: Awaited<ReturnType<Query['readOrchestrationControlPlane']>>['scheduler']) => boolean,
): Promise<Awaited<ReturnType<Query['readOrchestrationControlPlane']>>['scheduler']> {
  const snapshot = await waitForOrchestrationSnapshot(q, teamName, (candidate) => predicate(candidate.scheduler));
  return snapshot.scheduler;
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

  it('shares a global worker budget across multiple dispatchers in the same query', async () => {
    const temp = makeTempHome('open-agent-sdk-task-dispatcher-budget-');
    const controlled = makeControlledCompletionProvider();
    const teamAlpha = `dispatcher-team-alpha-${Date.now()}`;
    const teamBeta = `dispatcher-team-beta-${Date.now()}`;

    try {
      const q = query('dispatcher shared worker budget', {
        cwd: temp.cwd,
        model: 'mock-model',
        provider: controlled.provider,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        globalDispatcherWorkerBudget: 1,
      } as any);

      await q.createTeam({ name: teamAlpha });
      await q.createTeam({ name: teamBeta, setActive: true });
      const alphaTask = await q.createTask({
        teamName: teamAlpha,
        subject: 'Alpha task',
        description: 'Alpha work',
      });
      const betaTask = await q.createTask({
        teamName: teamBeta,
        subject: 'Beta task',
        description: 'Beta work',
      });

      const alphaDispatcher = await q.startTaskDispatcher({
        dispatcherId: `dispatcher-alpha-${Date.now()}`,
        owner: 'dispatcher-owner',
        teamName: teamAlpha,
        pollIntervalMs: 25,
        leaseMs: 500,
      });
      const betaDispatcher = await q.startTaskDispatcher({
        dispatcherId: `dispatcher-beta-${Date.now()}`,
        owner: 'dispatcher-owner',
        teamName: teamBeta,
        pollIntervalMs: 25,
        leaseMs: 500,
      });

      await controlled.waitForStarted(1);

      const saturated = await (async () => {
        const timeoutAt = Date.now() + 4_000;
        while (Date.now() < timeoutAt) {
          const snapshot = await q.readOrchestrationControlPlane();
          if (
            snapshot.summary.activeAssignmentCount === 1
            && snapshot.summary.availableDispatcherWorkerBudget === 0
            && snapshot.summary.globalBudgetBlockedDispatcherCount === 2
          ) {
            return snapshot;
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw new Error('Timed out waiting for shared worker budget saturation');
      })();
      expect(saturated.summary.globalDispatcherWorkerBudget).toBe(1);
      expect(saturated.summary.availableDispatcherWorkerBudget).toBe(0);
      expect(saturated.summary.globalBudgetBlockedDispatcherCount).toBe(2);
      expect(saturated.summary.teamBudgetBlockedDispatcherCount).toBe(0);
      expect(saturated.scheduler.queue).toHaveLength(1);
      expect(saturated.scheduler.queue[0]).toEqual(expect.objectContaining({
        schedulerState: 'waiting_for_global_worker_budget',
        nextTurn: true,
      }));

      const alphaState = saturated.dispatchers.find((item) => item.dispatcherId === alphaDispatcher.dispatcherId);
      const betaState = saturated.dispatchers.find((item) => item.dispatcherId === betaDispatcher.dispatcherId);
      expect((alphaState?.activeAssignments.length ?? 0) + (betaState?.activeAssignments.length ?? 0)).toBe(1);
      expect(alphaState?.schedulerState).toBe('waiting_for_global_worker_budget');
      expect(betaState?.schedulerState).toBe('waiting_for_global_worker_budget');

      controlled.releaseNext();
      await controlled.waitForStarted(2);
      controlled.releaseNext();

      const completedAlpha = await waitForTask(q, alphaTask.id, teamAlpha, (task) => task.status === 'completed');
      const completedBeta = await waitForTask(q, betaTask.id, teamBeta, (task) => task.status === 'completed');
      expect(completedAlpha.owner).toBe('dispatcher-owner');
      expect(completedBeta.owner).toBe('dispatcher-owner');

      await expect(q.stopTaskDispatcher(alphaDispatcher.dispatcherId)).resolves.toMatchObject({
        success: true,
      });
      await expect(q.stopTaskDispatcher(betaDispatcher.dispatcherId)).resolves.toMatchObject({
        success: true,
      });
      q.close();
    } finally {
      temp.cleanup();
    }
  });

  it('rotates the next shared worker slot to the next dispatcher under budget pressure', async () => {
    const temp = makeTempHome('open-agent-sdk-task-dispatcher-fairness-');
    const controlled = makeControlledCompletionProvider();
    const teamAlpha = `dispatcher-fair-alpha-${Date.now()}`;
    const teamBeta = `dispatcher-fair-beta-${Date.now()}`;

    try {
      const q = query('dispatcher shared worker fairness', {
        cwd: temp.cwd,
        model: 'mock-model',
        provider: controlled.provider,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        globalDispatcherWorkerBudget: 1,
      } as any);

      await q.createTeam({ name: teamAlpha });
      await q.createTeam({ name: teamBeta, setActive: true });
      const alphaTask1 = await q.createTask({
        teamName: teamAlpha,
        subject: 'Alpha task 1',
        description: 'Alpha work 1',
        priority: 20,
      });
      const alphaTask2 = await q.createTask({
        teamName: teamAlpha,
        subject: 'Alpha task 2',
        description: 'Alpha work 2',
        priority: 10,
      });
      const betaTask = await q.createTask({
        teamName: teamBeta,
        subject: 'Beta task',
        description: 'Beta work',
        priority: 15,
      });

      const alphaDispatcher = await q.startTaskDispatcher({
        dispatcherId: `dispatcher-fair-alpha-${Date.now()}`,
        owner: 'dispatcher-owner',
        teamName: teamAlpha,
        pollIntervalMs: 25,
        leaseMs: 500,
      });
      const betaDispatcher = await q.startTaskDispatcher({
        dispatcherId: `dispatcher-fair-beta-${Date.now()}`,
        owner: 'dispatcher-owner',
        teamName: teamBeta,
        pollIntervalMs: 25,
        leaseMs: 500,
      });

      await waitForTask(q, alphaTask1.id, teamAlpha, (task) => task.status === 'in_progress');
      controlled.releaseNext();

      await controlled.waitForStarted(2);
      const betaInProgress = await waitForTask(q, betaTask.id, teamBeta, (task) => task.status === 'in_progress');
      const alphaSecondStillPending = await q.getTask(alphaTask2.id, { teamName: teamAlpha });
      expect(betaInProgress.owner).toBe('dispatcher-owner');
      expect(alphaSecondStillPending?.status).toBe('pending');

      controlled.releaseNext();
      await controlled.waitForStarted(3);
      controlled.releaseNext();

      const completedAlpha1 = await waitForTask(q, alphaTask1.id, teamAlpha, (task) => task.status === 'completed');
      const completedAlpha2 = await waitForTask(q, alphaTask2.id, teamAlpha, (task) => task.status === 'completed');
      const completedBeta = await waitForTask(q, betaTask.id, teamBeta, (task) => task.status === 'completed');
      expect(completedAlpha1.owner).toBe('dispatcher-owner');
      expect(completedAlpha2.owner).toBe('dispatcher-owner');
      expect(completedBeta.owner).toBe('dispatcher-owner');

      await expect(q.stopTaskDispatcher(alphaDispatcher.dispatcherId)).resolves.toMatchObject({ success: true });
      await expect(q.stopTaskDispatcher(betaDispatcher.dispatcherId)).resolves.toMatchObject({ success: true });
      q.close();
    } finally {
      temp.cleanup();
    }
  });

  it('enforces per-team dispatcher worker budgets on top of the shared pool', async () => {
    const temp = makeTempHome('open-agent-sdk-task-dispatcher-team-budget-');
    const controlled = makeControlledCompletionProvider();
    const teamAlpha = `dispatcher-team-budget-alpha-${Date.now()}`;
    const teamBeta = `dispatcher-team-budget-beta-${Date.now()}`;

    try {
      const q = query('dispatcher per-team worker budget', {
        cwd: temp.cwd,
        model: 'mock-model',
        provider: controlled.provider,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        globalDispatcherWorkerBudget: 2,
        teamDispatcherWorkerBudgets: {
          [teamAlpha]: 1,
          [teamBeta]: 1,
        },
      } as any);

      await q.createTeam({ name: teamAlpha });
      await q.createTeam({ name: teamBeta, setActive: true });
      const alphaTask1 = await q.createTask({
        teamName: teamAlpha,
        subject: 'Alpha task 1',
        description: 'Alpha work 1',
        priority: 20,
      });
      const alphaTask2 = await q.createTask({
        teamName: teamAlpha,
        subject: 'Alpha task 2',
        description: 'Alpha work 2',
        priority: 10,
      });
      const betaTask = await q.createTask({
        teamName: teamBeta,
        subject: 'Beta task',
        description: 'Beta work',
        priority: 15,
      });

      const alphaDispatcher = await q.startTaskDispatcher({
        dispatcherId: `dispatcher-team-budget-alpha-${Date.now()}`,
        owner: 'dispatcher-owner',
        teamName: teamAlpha,
        pollIntervalMs: 25,
        leaseMs: 500,
        maxConcurrentWorkers: 2,
      });
      const betaDispatcher = await q.startTaskDispatcher({
        dispatcherId: `dispatcher-team-budget-beta-${Date.now()}`,
        owner: 'dispatcher-owner',
        teamName: teamBeta,
        pollIntervalMs: 25,
        leaseMs: 500,
        maxConcurrentWorkers: 2,
      });

      await controlled.waitForStarted(2);
      const saturated = await (async () => {
        const timeoutAt = Date.now() + 4_000;
        while (Date.now() < timeoutAt) {
          const snapshot = await q.readOrchestrationControlPlane();
          if (snapshot.summary.activeAssignmentCount === 2 && snapshot.summary.teamBudgetBlockedDispatcherCount === 2) {
            return snapshot;
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw new Error('Timed out waiting for per-team worker budget saturation');
      })();
      expect(saturated.summary.globalDispatcherWorkerBudget).toBe(2);
      expect(saturated.summary.availableDispatcherWorkerBudget).toBe(0);
      expect(saturated.summary.teamDispatcherWorkerBudgets).toEqual({
        [teamAlpha]: 1,
        [teamBeta]: 1,
      });
      expect(saturated.summary.availableTeamDispatcherWorkerBudgets).toEqual({
        [teamAlpha]: 0,
        [teamBeta]: 0,
      });
      expect(saturated.summary.globalBudgetBlockedDispatcherCount).toBe(0);
      expect(saturated.summary.teamBudgetBlockedDispatcherCount).toBe(2);

      const alphaState = saturated.dispatchers.find((item) => item.dispatcherId === alphaDispatcher.dispatcherId);
      const betaState = saturated.dispatchers.find((item) => item.dispatcherId === betaDispatcher.dispatcherId);
      expect(alphaState?.activeAssignments).toHaveLength(1);
      expect(betaState?.activeAssignments).toHaveLength(1);
      expect(alphaState?.schedulerState).toBe('waiting_for_team_worker_budget');
      expect(betaState?.schedulerState).toBe('waiting_for_team_worker_budget');

      const alphaSecondStillPending = await q.getTask(alphaTask2.id, { teamName: teamAlpha });
      expect(alphaSecondStillPending?.status).toBe('pending');
      const alphaQuotaHealth = await q.inspectTaskDispatcherHealth(alphaDispatcher.dispatcherId);
      expect(alphaQuotaHealth?.findings.map((item) => item.code)).toContain('team_quota_saturated');

      controlled.releaseNext();
      await controlled.waitForStarted(3);
      controlled.releaseNext();
      controlled.releaseNext();
      q.close();
    } finally {
      temp.cleanup();
    }
  }, 15_000);

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
      expect(snapshot.summary).toEqual(expect.objectContaining({
        taskCount: 1,
        inProgressTaskCount: 1,
        leasedTaskCount: 1,
        workerCount: 1,
        runningWorkerCount: 1,
        dispatcherCount: 1,
        liveDispatcherCount: 1,
        runningDispatcherCount: 1,
        activeAssignmentCount: 1,
      }));
      expect(snapshot.tasks).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: task.id, teamName }),
      ]));
      expect(snapshot.workers).toEqual(expect.arrayContaining([
        expect.objectContaining({ workerId, teamName }),
      ]));
      expect(snapshot.dispatchers).toEqual(expect.arrayContaining([
        expect.objectContaining({ dispatcherId: dispatcher.dispatcherId, teamName }),
      ]));
      expect(snapshot.scheduler).toEqual(expect.objectContaining({
        fairnessCursor: null,
      }));

      const report = await q.inspectTaskDispatcherHealth(dispatcher.dispatcherId, {
        now: new Date(Date.now() + 2_000),
      });
      expect(report).not.toBeNull();

      const snapshotWithDiagnosis = await q.readOrchestrationControlPlane({ teamName });
      expect(snapshotWithDiagnosis.summary).toEqual(expect.objectContaining({
        unhealthyDispatcherCount: 1,
      }));
      expect(snapshotWithDiagnosis.summary.dispatcherErrorCount).toBeGreaterThan(0);
      expect(snapshotWithDiagnosis.summary.dispatcherWarningCount).toBeGreaterThan(0);
      expect(snapshotWithDiagnosis.dispatcherDiagnoses).toEqual(expect.arrayContaining([
        expect.objectContaining({ dispatcherId: dispatcher.dispatcherId }),
      ]));

      q.close();
    } finally {
      controlledFailure.releaseFailure();
      temp.cleanup();
    }
  });

  it('rebuilds orchestration snapshot from durable task and worker ledgers after cold restart', async () => {
    const temp = makeTempHome('open-agent-sdk-orchestration-ledger-');
    const teamName = `dispatcher-team-${Date.now()}`;
    const sessionId = randomUUID();
    const sessionMgr = new SessionManager();

    try {
      const writer = query('orchestration ledger writer', {
        cwd: temp.cwd,
        model: 'mock-model',
        provider: makeCompletingWorkerProvider(),
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        sessionId,
      } as any);

      await writer.createTeam({ name: teamName, setActive: true });
      const task = await writer.createTask({
        teamName,
        subject: 'Ledger-backed task',
        description: 'Persist orchestration records for cold recovery.',
        priority: 9,
      });
      const dispatcher = await writer.startTaskDispatcher({
        dispatcherId: `dispatcher-${Date.now()}`,
        owner: 'dispatcher-owner',
        teamName,
        pollIntervalMs: 25,
        leaseMs: 500,
      });

      const warmSnapshot = await waitForOrchestrationSnapshot(
        writer,
        teamName,
        (snapshot) =>
          snapshot.dispatchers.some((item) => item.dispatcherId === dispatcher.dispatcherId)
          && snapshot.workers.length > 0,
      );
      const workerId = warmSnapshot.workers[0]?.workerId;
      expect(workerId).toBeTruthy();

      writer.close();

      rmSync(join(process.env.HOME!, '.open-agent', 'tasks', teamName), { recursive: true, force: true });
      rmSync(join(process.env.HOME!, '.open-agent', 'agent-sessions'), { recursive: true, force: true });

      const transcriptDir = dirname(sessionMgr.getTranscriptPath(temp.cwd, sessionId));
      expect(() => rmSync(join(transcriptDir, `${sessionId}.jsonl`), { force: true })).not.toThrow();
      expect(() => rmSync(join(transcriptDir, `${sessionId}.tasks.json`), { force: true })).not.toThrow();
      expect(() => rmSync(join(transcriptDir, `${sessionId}.workers.json`), { force: true })).not.toThrow();
      expect(() => rmSync(join(transcriptDir, `${sessionId}.dispatchers.json`), { force: true })).not.toThrow();

      const reader = query('orchestration ledger reader', {
        cwd: temp.cwd,
        model: 'mock-model',
        provider: makeCompletingWorkerProvider(),
        sessionId,
      } as any);

      const recovered = await reader.readOrchestrationControlPlane({ teamName });
      expect(recovered.summary).toEqual(expect.objectContaining({
        taskCount: 1,
        workerCount: 1,
        dispatcherCount: 1,
      }));
      expect(recovered.tasks).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: task.id, teamName }),
      ]));
      expect(recovered.workers).toEqual(expect.arrayContaining([
        expect.objectContaining({ workerId, teamName }),
      ]));
      expect(recovered.dispatchers).toEqual(expect.arrayContaining([
        expect.objectContaining({ dispatcherId: dispatcher.dispatcherId, teamName }),
      ]));
      expect(recovered.scheduler).toEqual(expect.objectContaining({
        fairnessCursor: dispatcher.dispatcherId,
      }));
      expect(recovered.scheduler.queue).toEqual(expect.arrayContaining([
        expect.objectContaining({
          dispatcherId: dispatcher.dispatcherId,
          teamName,
          nextTurn: true,
        }),
      ]));

      reader.close();
    } finally {
      temp.cleanup();
    }
  });

  it('reports task_missing and assignment_drift findings for corrupted active assignments', async () => {
    const temp = makeTempHome('open-agent-sdk-task-dispatcher-drift-');
    const teamName = `dispatcher-team-${Date.now()}`;
    const controlledFailure = makeControlledFailureProvider();

    try {
      const q = query('dispatcher drift diagnosis', {
        cwd: temp.cwd,
        model: 'mock-model',
        provider: controlledFailure.provider,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
      } as any);

      await q.createTeam({ name: teamName, setActive: true });
      const task = await q.createTask({
        teamName,
        subject: 'Drifted assignment',
        description: 'Corrupt the leased task while the assignment is still active.',
        priority: 10,
      });
      const dispatcher = await q.startTaskDispatcher({
        dispatcherId: `dispatcher-${Date.now()}`,
        owner: 'dispatcher-owner',
        teamName,
        pollIntervalMs: 25,
        leaseMs: 500,
      });

      await waitForDispatcher(
        q,
        dispatcher.dispatcherId,
        (item) => item.status === 'running' && item.activeAssignments.length === 1,
      );

      await q.updateTask({
        taskId: task.id,
        teamName,
        status: 'pending',
      });

      const driftReport = await q.inspectTaskDispatcherHealth(dispatcher.dispatcherId);
      expect(driftReport?.findings.map((item) => item.code)).toEqual(expect.arrayContaining([
        'assignment_drift',
      ]));

      await q.updateTask({
        taskId: task.id,
        teamName,
        status: 'deleted',
      });

      const missingReport = await q.inspectTaskDispatcherHealth(dispatcher.dispatcherId);
      expect(missingReport?.findings.map((item) => item.code)).toEqual(expect.arrayContaining([
        'task_missing',
      ]));
      expect(missingReport?.followUps.some((item) =>
        item.scaffold.action?.tool === 'TaskDispatcher'
        && item.scaffold.action.arguments['action'] === 'requeue',
      )).toBe(true);

      await q.stopTaskDispatcher(dispatcher.dispatcherId);
      q.close();
    } finally {
      controlledFailure.releaseFailure();
      temp.cleanup();
    }
  });

  it('resumes a stopped dispatcher from durable state and restarts live dispatching', async () => {
    const temp = makeTempHome('open-agent-sdk-task-dispatcher-resume-');
    const teamName = `dispatcher-team-${Date.now()}`;
    const sessionId = randomUUID();

    try {
      const writer = query('dispatcher resume writer', {
        cwd: temp.cwd,
        model: 'mock-model',
        provider: makeCompletingWorkerProvider(),
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        sessionId,
      } as any);

      await writer.createTeam({ name: teamName, setActive: true });
      const firstTask = await writer.createTask({
        teamName,
        subject: 'First pass',
        description: 'Complete before resume.',
        priority: 10,
      });

      const dispatcher = await writer.startTaskDispatcher({
        dispatcherId: `dispatcher-${Date.now()}`,
        owner: 'dispatcher-owner',
        teamName,
        pollIntervalMs: 25,
        leaseMs: 500,
        name: 'resume-dispatcher',
        prompt: 'Continue processing queued tasks.',
        mode: 'plan',
      });

      await waitForTask(
        writer,
        firstTask.id,
        teamName,
        (item) => item.status === 'completed',
      );
      await waitForDispatcher(
        writer,
        dispatcher.dispatcherId,
        (item) => item.status === 'running' && item.activeAssignments.length === 0,
      );
      await writer.stopTaskDispatcher(dispatcher.dispatcherId);
      await waitForDispatcher(
        writer,
        dispatcher.dispatcherId,
        (item) => item.status === 'stopped',
      );

      const secondTask = await writer.createTask({
        teamName,
        subject: 'Second pass',
        description: 'Complete after dispatcher resume.',
        priority: 5,
      });

      writer.close();

      const reader = query('dispatcher resume reader', {
        cwd: temp.cwd,
        model: 'mock-model',
        provider: makeCompletingWorkerProvider(),
        sessionId,
      } as any);

      const resumed = await reader.resumeTaskDispatcher(dispatcher.dispatcherId);
      expect(resumed).toMatchObject({
        dispatcherId: dispatcher.dispatcherId,
        status: 'running',
        source: 'live',
        name: 'resume-dispatcher',
        prompt: 'Continue processing queued tasks.',
        mode: 'plan',
      });

      await waitForTask(
        reader,
        secondTask.id,
        teamName,
        (item) => item.status === 'completed',
      );

      await reader.stopTaskDispatcher(dispatcher.dispatcherId);
      reader.close();
    } finally {
      temp.cleanup();
    }
  });

  it('auto-recovers running dispatchers from durable state on a fresh query handle', async () => {
    const temp = makeTempHome('open-agent-sdk-task-dispatcher-auto-recover-');
    const teamName = `dispatcher-team-${Date.now()}`;
    const sessionId = randomUUID();
    const sessionMgr = new SessionManager();

    try {
      const writer = query('dispatcher auto recovery writer', {
        cwd: temp.cwd,
        model: 'mock-model',
        provider: makeCompletingWorkerProvider(),
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        sessionId,
      } as any);

      await writer.createTeam({ name: teamName, setActive: true });
      const dispatcher = await writer.startTaskDispatcher({
        dispatcherId: `dispatcher-${Date.now()}`,
        owner: 'dispatcher-owner',
        teamName,
        pollIntervalMs: 25,
        leaseMs: 500,
        prompt: 'Process recovered queued tasks.',
      });
      await waitForDispatcher(
        writer,
        dispatcher.dispatcherId,
        (item) => item.status === 'running' && item.activeAssignments.length === 0,
      );
      await writer.stopTaskDispatcher(dispatcher.dispatcherId);
      await waitForDispatcher(
        writer,
        dispatcher.dispatcherId,
        (item) => item.status === 'stopped',
      );

      const task = await writer.createTask({
        teamName,
        subject: 'Recovered auto task',
        description: 'Should be picked up by auto-recovered dispatcher.',
        priority: 7,
      });
      writer.close();

      const transcriptDir = dirname(sessionMgr.getTranscriptPath(temp.cwd, sessionId));
      const orchestrationPath = join(transcriptDir, `${sessionId}.orchestration.json`);
      const orchestration = JSON.parse(readFileSync(orchestrationPath, 'utf-8')) as {
        dispatchers: Array<Record<string, unknown>>;
      };
      orchestration.dispatchers = orchestration.dispatchers.map((record) =>
        record.dispatcherId === dispatcher.dispatcherId
          ? {
              ...record,
              status: 'running',
              updatedAt: new Date().toISOString(),
              stoppedAt: undefined,
            }
          : record,
      );
      writeFileSync(orchestrationPath, JSON.stringify(orchestration, null, 2));

      const reader = query('dispatcher auto recovery reader', {
        cwd: temp.cwd,
        model: 'mock-model',
        provider: makeCompletingWorkerProvider(),
        sessionId,
      } as any);

      const recoveredDispatcher = await waitForDispatcher(
        reader,
        dispatcher.dispatcherId,
        (item) => item.source === 'live' && item.status === 'running',
      );
      expect(recoveredDispatcher.prompt).toBe('Process recovered queued tasks.');
      const scheduler = await waitForSchedulerSnapshot(
        reader,
        teamName,
        (item) => item.ownerSessionId === sessionId && typeof item.ownerQueryInstanceId === 'string' && item.ownerQueryInstanceId.length > 0,
      );
      expect(scheduler.ownerQueryInstanceId).toBeTruthy();
      expect(scheduler.ownerScope).toBe('local');

      await waitForTask(
        reader,
        task.id,
        teamName,
        (item) => item.status === 'completed',
      );

      await reader.stopTaskDispatcher(dispatcher.dispatcherId);
      reader.close();
    } finally {
      temp.cleanup();
    }
  });

  it('blocks a secondary live dispatcher until scheduler ownership is handed off', async () => {
    const temp = makeTempHome('open-agent-sdk-task-scheduler-handoff-');
    const primaryTeamName = `dispatcher-team-primary-${Date.now()}`;
    const blockedTeamName = `dispatcher-team-blocked-${Date.now()}`;
    const sessionId = randomUUID();

    try {
      const primary = query('scheduler handoff primary', {
        cwd: temp.cwd,
        model: 'mock-model',
        provider: makeCompletingWorkerProvider(),
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        sessionId,
      } as any);

      await primary.createTeam({ name: primaryTeamName, setActive: true });
      const primaryDispatcher = await primary.startTaskDispatcher({
        dispatcherId: `dispatcher-primary-${Date.now()}`,
        owner: 'dispatcher-owner',
        teamName: primaryTeamName,
        pollIntervalMs: 25,
        leaseMs: 500,
      });

      await waitForDispatcher(
        primary,
        primaryDispatcher.dispatcherId,
        (item) => item.status === 'running' && item.schedulerState === 'idle',
      );
      const primaryScheduler = await waitForSchedulerSnapshot(
        primary,
        primaryTeamName,
        (item) => item.ownerScope === 'local' && typeof item.ownerQueryInstanceId === 'string',
      );
      expect(primaryScheduler.ownerScope).toBe('local');

      const secondary = query('scheduler handoff secondary', {
        cwd: temp.cwd,
        model: 'mock-model',
        provider: makeCompletingWorkerProvider(),
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        sessionId,
      } as any);

      await secondary.createTeam({ name: blockedTeamName, setActive: true });
      const blockedTask = await secondary.createTask({
        teamName: blockedTeamName,
        subject: 'Blocked by scheduler owner',
        description: 'Should wait until the primary query releases ownership.',
        priority: 11,
      });
      const secondaryDispatcher = await secondary.startTaskDispatcher({
        dispatcherId: `dispatcher-secondary-${Date.now()}`,
        owner: 'dispatcher-owner',
        teamName: blockedTeamName,
        pollIntervalMs: 25,
        leaseMs: 500,
      });

      const blockedSecondary = await waitForDispatcher(
        secondary,
        secondaryDispatcher.dispatcherId,
        (item) => item.status === 'running' && item.schedulerState === 'waiting_for_scheduler_owner',
      );
      expect(blockedSecondary.lastBlockedReason).toBe('scheduler_owner');
      const blockedSnapshot = await waitForOrchestrationSnapshot(
        secondary,
        blockedTeamName,
        (snapshot) => snapshot.summary.ownershipBlockedDispatcherCount >= 1 && snapshot.scheduler.ownerScope === 'remote',
      );
      expect(blockedSnapshot.scheduler.ownerQueryInstanceId).toBe(primaryScheduler.ownerQueryInstanceId);
      expect((await secondary.getTask(blockedTask.id, { teamName: blockedTeamName }))?.status).toBe('pending');

      primary.close();

      await waitForTask(
        secondary,
        blockedTask.id,
        blockedTeamName,
        (item) => item.status === 'completed',
      );
      const handedOffScheduler = await waitForSchedulerSnapshot(
        secondary,
        blockedTeamName,
        (item) => item.ownerScope === 'local' && item.ownerQueryInstanceId !== primaryScheduler.ownerQueryInstanceId,
      );
      expect(handedOffScheduler.ownerScope).toBe('local');

      await secondary.stopTaskDispatcher(secondaryDispatcher.dispatcherId);
      secondary.close();
    } finally {
      temp.cleanup();
    }
  });

  it('shares the worker budget across fresh queries in the same workspace', async () => {
    const temp = makeTempHome('open-agent-sdk-task-dispatcher-cross-query-budget-');
    const controlled = makeControlledCompletionProvider();
    const primaryTeamName = `dispatcher-cross-query-primary-${Date.now()}`;
    const secondaryTeamName = `dispatcher-cross-query-secondary-${Date.now()}`;

    try {
      const primary = query('dispatcher cross-query budget primary', {
        cwd: temp.cwd,
        model: 'mock-model',
        provider: controlled.provider,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        sessionId: randomUUID(),
        globalDispatcherWorkerBudget: 1,
      } as any);

      await primary.createTeam({ name: primaryTeamName, setActive: true });
      const primaryTask = await primary.createTask({
        teamName: primaryTeamName,
        subject: 'Primary task',
        description: 'Occupies the shared workspace worker slot.',
      });
      const primaryDispatcher = await primary.startTaskDispatcher({
        dispatcherId: `dispatcher-cross-query-primary-${Date.now()}`,
        owner: 'dispatcher-owner',
        teamName: primaryTeamName,
        pollIntervalMs: 25,
        leaseMs: 500,
      });

      await controlled.waitForStarted(1);
      await waitForTask(primary, primaryTask.id, primaryTeamName, (task) => task.status === 'in_progress');

      const secondary = query('dispatcher cross-query budget secondary', {
        cwd: temp.cwd,
        model: 'mock-model',
        provider: controlled.provider,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        sessionId: randomUUID(),
        globalDispatcherWorkerBudget: 1,
      } as any);

      await secondary.createTeam({ name: secondaryTeamName, setActive: true });
      const secondaryTask = await secondary.createTask({
        teamName: secondaryTeamName,
        subject: 'Secondary task',
        description: 'Must wait for the shared workspace worker slot.',
      });
      const secondaryDispatcher = await secondary.startTaskDispatcher({
        dispatcherId: `dispatcher-cross-query-secondary-${Date.now()}`,
        owner: 'dispatcher-owner',
        teamName: secondaryTeamName,
        pollIntervalMs: 25,
        leaseMs: 500,
      });

      const blockedSecondary = await waitForDispatcher(
        secondary,
        secondaryDispatcher.dispatcherId,
        (item) => item.status === 'running' && item.schedulerState === 'waiting_for_global_worker_budget',
      );
      expect(blockedSecondary.lastBlockedReason).toBe('global_worker_budget');
      const secondarySnapshot = await waitForOrchestrationSnapshot(
        secondary,
        secondaryTeamName,
        (snapshot) =>
          snapshot.summary.globalDispatcherWorkerBudget === 1
          && snapshot.summary.availableDispatcherWorkerBudget === 0
          && snapshot.summary.globalBudgetBlockedDispatcherCount >= 1,
      );
      expect(secondarySnapshot.scheduler.globalWorkerBudget).toBe(1);
      expect((await secondary.getTask(secondaryTask.id, { teamName: secondaryTeamName }))?.status).toBe('pending');

      controlled.releaseNext();
      await controlled.waitForStarted(2);
      await waitForTask(secondary, secondaryTask.id, secondaryTeamName, (task) => task.status === 'in_progress');
      controlled.releaseNext();

      await waitForTask(primary, primaryTask.id, primaryTeamName, (task) => task.status === 'completed');
      await waitForTask(secondary, secondaryTask.id, secondaryTeamName, (task) => task.status === 'completed');

      await primary.stopTaskDispatcher(primaryDispatcher.dispatcherId);
      await secondary.stopTaskDispatcher(secondaryDispatcher.dispatcherId);
      primary.close();
      secondary.close();
    } finally {
      temp.cleanup();
    }
  });

  it('prevents a second fresh query from auto-recovering a dispatcher already owned by another live query', async () => {
    const temp = makeTempHome('open-agent-sdk-task-dispatcher-ownership-');
    const teamName = `dispatcher-team-${Date.now()}`;
    const sessionId = randomUUID();
    const sessionMgr = new SessionManager();

    try {
      const writer = query('dispatcher ownership writer', {
        cwd: temp.cwd,
        model: 'mock-model',
        provider: makeCompletingWorkerProvider(),
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        sessionId,
      } as any);

      await writer.createTeam({ name: teamName, setActive: true });
      const dispatcher = await writer.startTaskDispatcher({
        dispatcherId: `dispatcher-${Date.now()}`,
        owner: 'dispatcher-owner',
        teamName,
        pollIntervalMs: 25,
        leaseMs: 500,
        prompt: 'Only one query should own this dispatcher at a time.',
      });
      await waitForDispatcher(
        writer,
        dispatcher.dispatcherId,
        (item) => item.status === 'running' && item.activeAssignments.length === 0,
      );
      await writer.stopTaskDispatcher(dispatcher.dispatcherId);
      await waitForDispatcher(
        writer,
        dispatcher.dispatcherId,
        (item) => item.status === 'stopped',
      );
      writer.close();

      const transcriptDir = dirname(sessionMgr.getTranscriptPath(temp.cwd, sessionId));
      const orchestrationPath = join(transcriptDir, `${sessionId}.orchestration.json`);
      const orchestration = JSON.parse(readFileSync(orchestrationPath, 'utf-8')) as {
        dispatchers: Array<Record<string, unknown>>;
      };
      orchestration.dispatchers = orchestration.dispatchers.map((record) =>
        record.dispatcherId === dispatcher.dispatcherId
          ? {
              ...record,
              status: 'running',
              updatedAt: new Date().toISOString(),
              stoppedAt: undefined,
            }
          : record,
      );
      writeFileSync(orchestrationPath, JSON.stringify(orchestration, null, 2));

      const primary = query('dispatcher ownership primary', {
        cwd: temp.cwd,
        model: 'mock-model',
        provider: makeCompletingWorkerProvider(),
        sessionId,
      } as any);
      const primaryRecovered = await waitForDispatcher(
        primary,
        dispatcher.dispatcherId,
        (item) => item.source === 'live' && item.status === 'running',
      );
      expect(primaryRecovered.prompt).toBe('Only one query should own this dispatcher at a time.');
      const primaryScheduler = await waitForSchedulerSnapshot(
        primary,
        teamName,
        (item) => item.ownerSessionId === sessionId && typeof item.ownerQueryInstanceId === 'string' && item.ownerQueryInstanceId.length > 0,
      );
      expect(primaryScheduler.ownerScope).toBe('local');

      const secondary = query('dispatcher ownership secondary', {
        cwd: temp.cwd,
        model: 'mock-model',
        provider: makeCompletingWorkerProvider(),
        sessionId,
      } as any);

      await expect(secondary.getTaskDispatcher(dispatcher.dispatcherId)).resolves.toMatchObject({
        dispatcherId: dispatcher.dispatcherId,
        source: 'ledger',
        status: 'running',
      });
      await expect(secondary.resumeTaskDispatcher(dispatcher.dispatcherId)).resolves.toMatchObject({
        dispatcherId: dispatcher.dispatcherId,
        source: 'ledger',
        status: 'running',
      });
      const secondaryBeforeHandoff = await waitForSchedulerSnapshot(
        secondary,
        teamName,
        (item) => item.ownerSessionId === sessionId && item.ownerQueryInstanceId === primaryScheduler.ownerQueryInstanceId,
      );
      expect(secondaryBeforeHandoff.ownerQueryInstanceId).toBe(primaryScheduler.ownerQueryInstanceId);
      expect(secondaryBeforeHandoff.ownerScope).toBe('remote');

      primary.close();

      const handedOff = await secondary.resumeTaskDispatcher(dispatcher.dispatcherId);
      expect(handedOff).toMatchObject({
        dispatcherId: dispatcher.dispatcherId,
        source: 'live',
        status: 'running',
      });
      const secondaryAfterHandoff = await waitForSchedulerSnapshot(
        secondary,
        teamName,
        (item) =>
          item.ownerSessionId === sessionId
          && typeof item.ownerQueryInstanceId === 'string'
          && item.ownerQueryInstanceId.length > 0
          && item.ownerQueryInstanceId !== primaryScheduler.ownerQueryInstanceId,
      );
      expect(secondaryAfterHandoff.ownerQueryInstanceId).not.toBe(primaryScheduler.ownerQueryInstanceId);
      expect(secondaryAfterHandoff.ownerScope).toBe('local');

      await secondary.stopTaskDispatcher(dispatcher.dispatcherId);
      secondary.close();
    } finally {
      temp.cleanup();
    }
  });
});
