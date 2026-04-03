import { describe, expect, it } from 'bun:test';
import { randomUUID } from 'crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { dirname, join } from 'path';
import { SessionManager } from '@open-agent/core';
import type { ChatOptions, LLMProvider, Message, StreamEvent } from '@open-agent/providers';
import type { Query, WorkerRecord, SDKTimelineItem, TaskDispatcherRecord } from '../types.js';
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

function makeStaticProvider(): LLMProvider {
  return {
    name: 'mock-timeline-static-provider',
    async *chat(_messages: Message[], _options: ChatOptions): AsyncGenerator<StreamEvent> {
      yield { type: 'text_delta', text: 'unused' };
      yield { type: 'message_end', message: {}, usage: { input_tokens: 10, output_tokens: 20 } };
    },
    async listModels() {
      return [{ value: 'mock-model', displayName: 'Mock Model', description: 'Timeline test model' }];
    },
  };
}

function makeBackgroundProvider(): LLMProvider {
  return {
    name: 'mock-timeline-background-provider',
    async *chat(_messages: Message[], options: ChatOptions): AsyncGenerator<StreamEvent> {
      await new Promise<void>((resolve) => {
        if (options.signal?.aborted) {
          resolve();
          return;
        }
        options.signal?.addEventListener('abort', () => resolve(), { once: true });
      });

      throw new Error('background worker aborted for timeline test');
    },
    async listModels() {
      return [{ value: 'mock-model', displayName: 'Mock Model', description: 'Timeline test model' }];
    },
  };
}

function writeWorkerSession(
  session: {
    agentId: string;
    agentType: string;
    state: WorkerRecord['status'];
    startedAt: string;
    model: string;
    numTurns: number;
    durationMs: number;
    parentSessionId: string;
    name?: string;
    teamName?: string;
    completedAt?: string;
    result?: string;
    error?: string;
  },
): string {
  const dir = join(homedir(), '.open-agent', 'agent-sessions', session.agentId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'state.json'), JSON.stringify(session, null, 2));
  return dir;
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

async function waitForDispatcher(
  q: Query,
  dispatcherId: string,
  predicate: (dispatcher: TaskDispatcherRecord) => boolean,
): Promise<TaskDispatcherRecord> {
  const timeoutAt = Date.now() + 2_000;
  while (Date.now() < timeoutAt) {
    const dispatcher = (await q.listTaskDispatchers()).find((item) => item.dispatcherId === dispatcherId);
    if (dispatcher && predicate(dispatcher)) {
      return dispatcher;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for dispatcher ${dispatcherId}`);
}

async function waitForTimelineItems(
  q: Query,
  options: Parameters<Query['readTimelineInbox']>[0],
  predicate: (items: SDKTimelineItem[]) => boolean,
): Promise<SDKTimelineItem[]> {
  const timeoutAt = Date.now() + 2_000;
  while (Date.now() < timeoutAt) {
    const items = await q.readTimelineInbox(options);
    if (predicate(items)) {
      return items;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for timeline items');
}

async function readTimelineItem(
  iterator: AsyncIterator<SDKTimelineItem>,
  predicate: (item: SDKTimelineItem) => boolean,
): Promise<SDKTimelineItem | undefined> {
  const timeoutAt = Date.now() + 2_000;
  while (Date.now() < timeoutAt) {
    const next = await iterator.next();
    if (next.done) return undefined;
    if (predicate(next.value)) {
      return next.value;
    }
  }
  return undefined;
}

describe('query() timeline control plane', () => {
  it('reads a merged snapshot of team inbox messages and task notifications', async () => {
    const temp = makeTempHome('open-agent-sdk-timeline-snapshot-');
    const teamName = `alpha-team-${Date.now()}`;
    const workerId = `worker-${Date.now()}`;
    let workerDir = '';

    try {
      const q = query('timeline snapshot', {
        cwd: temp.cwd,
        model: 'mock-model',
        provider: makeStaticProvider(),
      });

      await q.createTeam({ name: teamName, setActive: true });
      await q.sendTeamMessage({
        type: 'message',
        recipient: 'alice',
        content: 'Review the worker result.',
      });

      const sessionInfo = await q.sessionInfo();
      workerDir = writeWorkerSession({
        agentId: workerId,
        agentType: 'worker',
        state: 'completed',
        parentSessionId: sessionInfo!.id,
        teamName,
        name: 'alice',
        startedAt: '2026-04-01T10:00:00.000Z',
        completedAt: '2026-04-01T10:05:00.000Z',
        model: 'mock-model',
        numTurns: 3,
        durationMs: 300_000,
        result: 'implemented timeline snapshot support',
      });

      const timeline = await q.readTimelineInbox({
        teamName,
        memberName: 'alice',
        consume: false,
      });

      expect(timeline.some((item) => item.kind === 'team_message' && item.teamMessage?.content === 'Review the worker result.')).toBe(true);
      const teamMessage = timeline.find((item) => item.kind === 'team_message');
      expect(teamMessage?.timelineId).toBeTruthy();
      expect(teamMessage?.cursor).toBe(teamMessage?.timelineId);
      expect(teamMessage?.teamMessage?.messageId).toBe(teamMessage?.timelineId);
      const taskNotification = timeline.find((item) =>
        item.kind === 'task_notification' && item.taskNotification?.taskId === workerId,
      );
      expect(taskNotification?.timelineId).toBeTruthy();
      expect(taskNotification?.taskNotification?.teamName).toBe(teamName);
      expect(taskNotification?.taskNotification?.followUps.some((item) => item.scaffold.kind === 'resume_worker')).toBe(true);

      expect(
        await q.acknowledgeTeamInbox({
          teamName,
          memberName: 'alice',
          messageIds: [teamMessage!.teamMessage!.messageId!],
        }),
      ).toEqual({ acknowledged: 1 });
      const unreadOnly = await q.readTimelineInbox({
        teamName,
        memberName: 'alice',
        consume: false,
        unreadOnly: true,
      });
      expect(unreadOnly.some((item) => item.kind === 'team_message')).toBe(false);
      q.close();
    } finally {
      if (workerDir) {
        rmSync(workerDir, { recursive: true, force: true });
      }
      temp.cleanup();
    }
  });

  it('reads persisted dispatcher orchestration items from timeline snapshot mode', async () => {
    const temp = makeTempHome('open-agent-sdk-timeline-dispatcher-snapshot-');
    const teamName = `alpha-team-${Date.now()}`;
    const sessionId = randomUUID();
    const sessionMgr = new SessionManager();

    try {
      const q = query('timeline dispatcher snapshot', {
        cwd: temp.cwd,
        model: 'mock-model',
        provider: makeStaticProvider(),
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        sessionId,
      });

      await q.createTeam({ name: teamName, setActive: true });
      await q.createTask({
        teamName,
        subject: 'Persist dispatcher replay',
        description: 'Store dispatcher lifecycle in transcript.',
        priority: 10,
      });

      const dispatcher = await q.startTaskDispatcher({
        dispatcherId: `dispatcher-${Date.now()}`,
        owner: 'dispatcher-owner',
        teamName,
        pollIntervalMs: 25,
      });

      await waitForDispatcher(
        q,
        dispatcher.dispatcherId,
        (item) => item.status === 'running' && item.activeTaskIds.length === 0 && Boolean(item.lastDispatchAt),
      );
      await q.stopTaskDispatcher(dispatcher.dispatcherId);
      await waitForDispatcher(q, dispatcher.dispatcherId, (item) => item.status === 'stopped');
      q.close();

      const transcriptDir = dirname(sessionMgr.getTranscriptPath(temp.cwd, sessionId));
      rmSync(join(transcriptDir, `${sessionId}.jsonl`), { force: true });
      rmSync(join(transcriptDir, `${sessionId}.dispatchers.json`), { force: true });
      rmSync(join(transcriptDir, `${sessionId}.orchestration-timeline.json`), { force: true });

      const reader = query('timeline dispatcher snapshot reader', {
        cwd: temp.cwd,
        model: 'mock-model',
        provider: makeStaticProvider(),
        sessionId,
      });

      const timeline = await reader.readTimelineInbox({
        teamName,
        includeTeamMessages: false,
        includeOrchestration: true,
        includeTaskNotifications: false,
      });
      const dispatcherItems = timeline.filter((item) =>
        item.kind === 'task_dispatcher'
        && item.orchestrationEvent?.dispatcherId === dispatcher.dispatcherId,
      );
      const dispatcherTimelineIds = dispatcherItems
        .map((item) => item.timelineId)
        .filter((value): value is string => typeof value === 'string');

      expect(dispatcherItems.some((item) => item.orchestrationEvent?.dispatcherEvent?.type === 'started')).toBe(true);
      expect(dispatcherItems.some((item) => item.orchestrationEvent?.dispatcherEvent?.type === 'dispatched')).toBe(true);
      expect(dispatcherItems.some((item) => item.orchestrationEvent?.dispatcherEvent?.type === 'task_completed')).toBe(true);
      expect(dispatcherItems.some((item) => item.orchestrationEvent?.dispatcherEvent?.type === 'stopped')).toBe(true);
      expect(dispatcherItems.every((item) => item.timelineId?.includes(dispatcher.dispatcherId))).toBe(true);
      expect(new Set(dispatcherTimelineIds).size).toBe(dispatcherTimelineIds.length);

      const dispatchedItem = dispatcherItems.find((item) =>
        item.orchestrationEvent?.dispatcherEvent?.type === 'dispatched'
      );
      expect(dispatchedItem?.orchestrationEvent?.dispatcherEvent?.followUps.some((item) =>
        item.scaffold.action?.tool === 'TaskDispatcher'
        && item.scaffold.action.arguments['action'] === 'requeue'
      )).toBe(true);

      const stoppedItem = dispatcherItems.find((item) =>
        item.orchestrationEvent?.dispatcherEvent?.type === 'stopped'
      );
      expect(stoppedItem?.orchestrationEvent?.dispatcherEvent?.followUps).toHaveLength(1);
      expect(stoppedItem?.orchestrationEvent?.dispatcherEvent?.followUps[0]?.scaffold.action?.tool).toBe('TaskDispatcher');
      expect(stoppedItem?.orchestrationEvent?.dispatcherEvent?.followUps[0]?.scaffold.action?.arguments['action']).toBe('start');

      const restarted = await reader.executeFollowUp(
        stoppedItem!.orchestrationEvent!.dispatcherEvent!.followUps[0]!,
      );
      expect(restarted.kind).toBe('task_dispatcher');
      expect(restarted.dispatcher?.dispatcherId).toBe(dispatcher.dispatcherId);
      await waitForDispatcher(
        reader,
        dispatcher.dispatcherId,
        (item) => item.status === 'running',
      );
      await reader.stopTaskDispatcher(dispatcher.dispatcherId);
      await waitForDispatcher(reader, dispatcher.dispatcherId, (item) => item.status === 'stopped');
      reader.close();
    } finally {
      temp.cleanup();
    }
  });

  it('streams team messages, worker events, and task notifications through subscribeTimeline()', async () => {
    const temp = makeTempHome('open-agent-sdk-timeline-live-');
    const teamName = `alpha-team-${Date.now()}`;

    try {
      const q = query('timeline live', {
        cwd: temp.cwd,
        model: 'mock-model',
        provider: makeBackgroundProvider(),
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
      });

      await q.createTeam({ name: teamName, setActive: true });
      const iterator = q.subscribeTimeline({
        teamName,
        memberName: 'alice',
        pollIntervalMs: 25,
      })[Symbol.asyncIterator]();

      await q.sendTeamMessage({
        type: 'message',
        recipient: 'alice',
        content: 'Start the worker and report back.',
      });
      const teamItem = await readTimelineItem(iterator, (item) =>
        item.kind === 'team_message'
        && item.teamMessage?.content === 'Start the worker and report back.',
      );
      expect(teamItem?.kind).toBe('team_message');

      const worker = await q.launchWorker({
        prompt: 'Wait until stopped.',
      });
      const launchedItem = await readTimelineItem(iterator, (item) =>
        item.kind === 'worker_lifecycle'
        && item.workerId === worker.workerId
        && item.orchestrationEvent?.raw.type === 'launched',
      );
      expect(launchedItem?.kind).toBe('worker_lifecycle');

      expect(await q.stopWorker(worker.workerId)).toEqual({ success: true });
      await waitForWorkerStatus(q, worker.workerId, 'shutdown');

      const notificationItem = await readTimelineItem(iterator, (item) =>
        item.kind === 'task_notification'
        && item.workerId === worker.workerId
        && item.taskNotification?.status === 'stopped',
      );
      expect(notificationItem?.kind).toBe('task_notification');
      expect(notificationItem?.taskNotification?.teamName).toBe(teamName);
      expect(notificationItem?.taskNotification?.followUps.some((item) => item.scaffold.kind === 'stopped_worker_followup')).toBe(true);

      const resumed = await q.executeFollowUp(notificationItem!.taskNotification!.followUps[0]!);
      expect(resumed.kind).toBe('worker');
      expect(resumed.worker?.workerId).toBe(worker.workerId);
      expect(await q.stopWorker(resumed.worker!.workerId)).toEqual({ success: true });
      await waitForWorkerStatus(q, resumed.worker!.workerId, 'shutdown');

      await iterator.return?.();
      q.close();
    } finally {
      temp.cleanup();
    }
  });

  it('surfaces dispatcher lifecycle items through subscribeTimeline()', async () => {
    const temp = makeTempHome('open-agent-sdk-timeline-dispatcher-');
    const teamName = `alpha-team-${Date.now()}`;

    try {
      const q = query('timeline dispatcher', {
        cwd: temp.cwd,
        model: 'mock-model',
        provider: makeStaticProvider(),
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
      });

      await q.createTeam({ name: teamName, setActive: true });
      await q.createTask({
        teamName,
        subject: 'Expose dispatcher lifecycle',
        description: 'Timeline should show dispatcher events.',
        priority: 10,
      });

      const iterator = q.subscribeTimeline({
        teamName,
        pollIntervalMs: 25,
        includeTaskNotifications: false,
      })[Symbol.asyncIterator]();

      const dispatcher = await q.startTaskDispatcher({
        dispatcherId: `dispatcher-${Date.now()}`,
        owner: 'dispatcher-owner',
        teamName,
        pollIntervalMs: 25,
      });

      const startedItem = await readTimelineItem(iterator, (item) =>
        item.kind === 'task_dispatcher'
        && item.orchestrationEvent?.dispatcherId === dispatcher.dispatcherId
        && item.orchestrationEvent?.dispatcherEvent?.type === 'started',
      );
      expect(startedItem?.timelineId).toContain(dispatcher.dispatcherId);
      expect(startedItem?.orchestrationEvent?.dispatcherEvent?.followUps).toHaveLength(1);
      expect(startedItem?.orchestrationEvent?.dispatcherEvent?.followUps[0]?.scaffold.action?.tool).toBe('TaskDispatcher');
      expect(startedItem?.orchestrationEvent?.dispatcherEvent?.followUps[0]?.scaffold.action?.arguments['action']).toBe('stop');

      const dispatchedItem = await readTimelineItem(iterator, (item) =>
        item.kind === 'task_dispatcher'
        && item.orchestrationEvent?.dispatcherId === dispatcher.dispatcherId
        && item.orchestrationEvent?.dispatcherEvent?.type === 'dispatched',
      );
      expect(dispatchedItem?.orchestrationEvent?.dispatcherEvent?.workerId).toBeTruthy();
      expect(dispatchedItem?.orchestrationEvent?.dispatcherEvent?.activeAssignments).toHaveLength(1);
      expect(dispatchedItem?.orchestrationEvent?.dispatcherEvent?.activeAssignments[0]?.taskId).toBe(
        dispatchedItem?.orchestrationEvent?.dispatcherEvent?.taskId,
      );
      expect(dispatchedItem?.orchestrationEvent?.dispatcherEvent?.followUps.some((item) =>
        item.scaffold.action?.tool === 'TaskDispatcher'
        && item.scaffold.action.arguments['action'] === 'requeue'
      )).toBe(true);
      expect(dispatchedItem?.taskNotification).toBeUndefined();

      await expect(q.stopTaskDispatcher(dispatcher.dispatcherId)).resolves.toMatchObject({
        success: true,
      });

      const stoppedItem = await readTimelineItem(iterator, (item) =>
        item.kind === 'task_dispatcher'
        && item.orchestrationEvent?.dispatcherId === dispatcher.dispatcherId
        && item.orchestrationEvent?.dispatcherEvent?.type === 'stopped',
      );
      expect(stoppedItem?.orchestrationEvent?.dispatcherEvent?.status).toBe('stopped');
      expect(stoppedItem?.orchestrationEvent?.dispatcherEvent?.activeAssignments).toEqual([]);
      expect(stoppedItem?.orchestrationEvent?.dispatcherEvent?.followUps).toHaveLength(1);
      expect(stoppedItem?.orchestrationEvent?.dispatcherEvent?.followUps[0]?.scaffold.action?.tool).toBe('TaskDispatcher');
      expect(stoppedItem?.orchestrationEvent?.dispatcherEvent?.followUps[0]?.scaffold.action?.arguments['action']).toBe('start');

      await iterator.return?.();
      q.close();
    } finally {
      temp.cleanup();
    }
  });

  it('dedupes task notifications between live timeline store and snapshot rebuild', async () => {
    const temp = makeTempHome('open-agent-sdk-timeline-task-notification-dedupe-');
    const teamName = `alpha-team-${Date.now()}`;

    try {
      const q = query('timeline task notification dedupe', {
        cwd: temp.cwd,
        model: 'mock-model',
        provider: makeBackgroundProvider(),
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
      });

      await q.createTeam({ name: teamName, setActive: true });
      const worker = await q.launchWorker({
        prompt: 'Wait until stopped.',
        teamName,
      });
      expect(await q.stopWorker(worker.workerId)).toEqual({ success: true });
      await waitForWorkerStatus(q, worker.workerId, 'shutdown');

      const timeline = await q.readTimelineInbox({
        teamName,
        includeTeamMessages: false,
        includeTaskNotifications: true,
      });
      const notifications = timeline.filter((item) =>
        item.kind === 'task_notification'
        && item.workerId === worker.workerId,
      );

      expect(notifications).toHaveLength(1);
      expect(notifications[0]?.taskNotification?.status).toBe('stopped');
      q.close();
    } finally {
      temp.cleanup();
    }
  });

  it('reads live worker lifecycle items back from timeline snapshot mode', async () => {
    const temp = makeTempHome('open-agent-sdk-timeline-worker-lifecycle-snapshot-');
    const teamName = `alpha-team-${Date.now()}`;

    try {
      const q = query('timeline worker lifecycle snapshot', {
        cwd: temp.cwd,
        model: 'mock-model',
        provider: makeBackgroundProvider(),
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
      });

      await q.createTeam({ name: teamName, setActive: true });
      const worker = await q.launchWorker({
        prompt: 'Wait until stopped.',
        teamName,
      });
      expect(await q.stopWorker(worker.workerId)).toEqual({ success: true });
      await waitForWorkerStatus(q, worker.workerId, 'shutdown');

      const timeline = await waitForTimelineItems(
        q,
        {
          teamName,
          includeTeamMessages: false,
          includeOrchestration: true,
          includeTaskNotifications: false,
        },
        (items) => {
          const lifecycleItems = items.filter((item) =>
            item.kind === 'worker_lifecycle'
            && item.workerId === worker.workerId,
          );
          return lifecycleItems.some((item) => item.orchestrationEvent?.lifecycle === 'launched')
            && lifecycleItems.some((item) => item.orchestrationEvent?.lifecycle === 'shutdown');
        },
      );
      const lifecycleItems = timeline.filter((item) =>
        item.kind === 'worker_lifecycle'
        && item.workerId === worker.workerId,
      );

      expect(lifecycleItems.some((item) => item.orchestrationEvent?.lifecycle === 'launched')).toBe(true);
      expect(lifecycleItems.some((item) => item.orchestrationEvent?.lifecycle === 'shutdown')).toBe(true);
      q.close();
    } finally {
      temp.cleanup();
    }
  });

  it('rebuilds worker lifecycle and task notifications from timeline ledger after cold restart', async () => {
    const temp = makeTempHome('open-agent-sdk-timeline-orchestration-ledger-');
    const teamName = `alpha-team-${Date.now()}`;
    const sessionId = randomUUID();
    const sessionMgr = new SessionManager();

    try {
      const writer = query('timeline orchestration ledger writer', {
        cwd: temp.cwd,
        model: 'mock-model',
        provider: makeBackgroundProvider(),
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        sessionId,
      });

      await writer.createTeam({ name: teamName, setActive: true });
      const worker = await writer.launchWorker({
        prompt: 'Wait until stopped.',
        teamName,
      });
      expect(await writer.stopWorker(worker.workerId)).toEqual({ success: true });
      await waitForWorkerStatus(writer, worker.workerId, 'shutdown');
      writer.close();

      rmSync(join(process.env.HOME!, '.open-agent', 'agent-sessions'), { recursive: true, force: true });
      const transcriptDir = dirname(sessionMgr.getTranscriptPath(temp.cwd, sessionId));
      rmSync(join(transcriptDir, `${sessionId}.jsonl`), { force: true });
      rmSync(join(transcriptDir, `${sessionId}.workers.json`), { force: true });
      rmSync(join(transcriptDir, `${sessionId}.orchestration-timeline.json`), { force: true });

      const reader = query('timeline orchestration ledger reader', {
        cwd: temp.cwd,
        model: 'mock-model',
        provider: makeBackgroundProvider(),
        sessionId,
      });

      const timeline = await waitForTimelineItems(
        reader,
        {
          teamName,
          includeTeamMessages: false,
          includeOrchestration: true,
          includeTaskNotifications: true,
        },
        (items) => {
          const lifecycleItems = items.filter((item) =>
            item.kind === 'worker_lifecycle' && item.workerId === worker.workerId,
          );
          const notificationItems = items.filter((item) =>
            item.kind === 'task_notification' && item.workerId === worker.workerId,
          );
          return lifecycleItems.some((item) => item.orchestrationEvent?.lifecycle === 'launched')
            && lifecycleItems.some((item) => item.orchestrationEvent?.lifecycle === 'shutdown')
            && notificationItems.some((item) => item.taskNotification?.status === 'stopped');
        },
      );

      const lifecycleItems = timeline.filter((item) =>
        item.kind === 'worker_lifecycle' && item.workerId === worker.workerId,
      );
      const notificationItems = timeline.filter((item) =>
        item.kind === 'task_notification' && item.workerId === worker.workerId,
      );

      expect(lifecycleItems.some((item) => item.orchestrationEvent?.lifecycle === 'launched')).toBe(true);
      expect(lifecycleItems.some((item) => item.orchestrationEvent?.lifecycle === 'shutdown')).toBe(true);
      expect(notificationItems).toHaveLength(1);
      expect(notificationItems[0]?.taskNotification?.status).toBe('stopped');
      reader.close();
    } finally {
      temp.cleanup();
    }
  });
});
