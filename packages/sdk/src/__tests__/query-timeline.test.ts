import { describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import type { ChatOptions, LLMProvider, Message, StreamEvent } from '@open-agent/providers';
import type { Query, WorkerRecord, SDKTimelineItem } from '../types.js';
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

      const dispatchedItem = await readTimelineItem(iterator, (item) =>
        item.kind === 'task_dispatcher'
        && item.orchestrationEvent?.dispatcherId === dispatcher.dispatcherId
        && item.orchestrationEvent?.dispatcherEvent?.type === 'dispatched',
      );
      expect(dispatchedItem?.orchestrationEvent?.dispatcherEvent?.workerId).toBeTruthy();
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

      await iterator.return?.();
      q.close();
    } finally {
      temp.cleanup();
    }
  });
});
