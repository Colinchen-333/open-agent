import { describe, it, expect } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { ChatOptions, LLMProvider, Message, StreamEvent } from '@open-agent/providers';
import type { Query, WorkerRecord } from '../types.js';
import { makeLockedTempHome as makeTempHome } from './temp-home.js';

const { query } = await import('../query.js');

function writeWorkerSession(
  cwd: string,
  session: {
    agentId: string;
    agentType: string;
    state: WorkerRecord['status'];
    startedAt: string;
    model: string;
    numTurns: number;
    durationMs: number;
    name?: string;
    teamName?: string;
    parentToolUseId?: string;
    parentSessionId?: string;
    completedAt?: string;
    outputFile?: string;
    totalToolUseCount?: number;
    totalTokens?: number;
    result?: string;
    error?: string;
  },
): string {
  const dir = join(cwd, '.open-agent', 'agent-sessions', session.agentId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'state.json'), JSON.stringify(session, null, 2));
  return dir;
}

function toolUseResponse(
  toolId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
): StreamEvent[] {
  return [
    { type: 'tool_use_start', id: toolId, name: toolName },
    { type: 'tool_use_delta', id: toolId, partial_json: JSON.stringify(toolInput) },
    { type: 'tool_use_end', id: toolId },
    { type: 'message_end', message: {}, usage: { input_tokens: 10, output_tokens: 20 } },
  ];
}

function textResponse(text: string): StreamEvent[] {
  return [
    { type: 'text_delta', text },
    { type: 'message_end', message: {}, usage: { input_tokens: 10, output_tokens: 20 } },
  ];
}

function makeStaticProvider(responses: StreamEvent[][]): LLMProvider {
  let callIndex = 0;

  return {
    name: 'mock-worker-provider',
    async *chat(_messages: Message[], _options: ChatOptions): AsyncGenerator<StreamEvent> {
      const events = responses[Math.min(callIndex, responses.length - 1)] ?? [];
      callIndex += 1;
      for (const event of events) {
        yield event;
      }
    },
    async listModels() {
      return [{ value: 'mock-model', displayName: 'Mock Model', description: 'Worker lifecycle test model' }];
    },
  };
}

function makeBackgroundWorkerProvider(teamName: string): LLMProvider {
  let parentCallCount = 0;

  return {
    name: 'mock-background-worker-provider',
    async *chat(_messages: Message[], options: ChatOptions): AsyncGenerator<StreamEvent> {
      const isSubagent =
        typeof options.systemPrompt === 'string'
        && options.systemPrompt.includes('You are a subagent working on behalf of another OpenAgent agent.');

      if (!isSubagent) {
        parentCallCount += 1;
        if (parentCallCount === 1) {
          yield* toolUseResponse('task-parent-bg', 'Task', {
            description: 'Launch background worker',
            prompt: 'Wait until stopped.',
            subagent_type: 'worker',
            name: 'alice',
            team_name: teamName,
            run_in_background: true,
          });
          return;
        }
        yield* textResponse('parent complete');
        return;
      }

      await new Promise<void>((resolve) => {
        if (options.signal?.aborted) {
          resolve();
          return;
        }
        options.signal?.addEventListener('abort', () => resolve(), { once: true });
      });

      throw new Error('background worker aborted for test');
    },
    async listModels() {
      return [{ value: 'mock-model', displayName: 'Mock Model', description: 'Background worker test model' }];
    },
  };
}

function makeDirectLaunchProvider(): LLMProvider {
  return {
    name: 'mock-direct-launch-provider',
    async *chat(_messages: Message[], options: ChatOptions): AsyncGenerator<StreamEvent> {
      await new Promise<void>((resolve) => {
        if (options.signal?.aborted) {
          resolve();
          return;
        }
        options.signal?.addEventListener('abort', () => resolve(), { once: true });
      });

      throw new Error('direct worker aborted for test');
    },
    async listModels() {
      return [{ value: 'mock-model', displayName: 'Mock Model', description: 'Direct worker control test model' }];
    },
  };
}

async function collectMessages(gen: AsyncGenerator<any>): Promise<any[]> {
  const messages: any[] = [];
  for await (const message of gen) {
    messages.push(message);
  }
  return messages;
}

async function waitForWorkerStatus(
  q: Query,
  workerId: string,
  expectedStatus: WorkerRecord['status'],
): Promise<WorkerRecord | null> {
  const timeoutAt = Date.now() + 2_000;
  while (Date.now() < timeoutAt) {
    const worker = await q.getWorker(workerId);
    if (worker?.status === expectedStatus) {
      return worker;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return q.getWorker(workerId);
}

async function readEventOfType(
  iterator: AsyncIterator<any>,
  expectedType: string,
): Promise<any> {
  const timeoutAt = Date.now() + 2_000;
  while (Date.now() < timeoutAt) {
    const next = await iterator.next();
    if (next.done) return undefined;
    if (next.value?.raw?.type === expectedType) {
      return next.value;
    }
  }
  return undefined;
}

describe('query() worker lifecycle control plane', () => {
  it('lists and retrieves persisted worker sessions', async () => {
    const temp = makeTempHome('open-agent-sdk-worker-list-');
    const alphaWorkerId = `worker-alpha-${Date.now()}`;
    const betaWorkerId = `worker-beta-${Date.now()}`;
    const alphaTeamName = `alpha-team-${Date.now()}`;
    const betaTeamName = `beta-team-${Date.now()}`;
    const cleanupDirs: string[] = [];

    try {
      cleanupDirs.push(writeWorkerSession(temp.cwd, {
        agentId: alphaWorkerId,
        agentType: 'worker',
        name: 'alpha',
        state: 'completed',
        teamName: alphaTeamName,
        parentToolUseId: 'task-alpha',
        parentSessionId: 'session-alpha',
        startedAt: '2026-04-01T10:00:00.000Z',
        completedAt: '2026-04-01T10:05:00.000Z',
        model: 'mock-model',
        numTurns: 3,
        durationMs: 300_000,
        totalToolUseCount: 2,
        totalTokens: 120,
        result: 'completed alpha worker',
      }));
      cleanupDirs.push(writeWorkerSession(temp.cwd, {
        agentId: betaWorkerId,
        agentType: 'verifier',
        name: 'beta',
        state: 'failed',
        teamName: betaTeamName,
        parentToolUseId: 'task-beta',
        parentSessionId: 'session-beta',
        startedAt: '2026-04-01T11:00:00.000Z',
        completedAt: '2026-04-01T11:02:00.000Z',
        model: 'mock-model',
        numTurns: 2,
        durationMs: 120_000,
        error: 'verification failed',
      }));

      const q = query('inspect workers', {
        cwd: temp.cwd,
        model: 'mock-model',
        provider: makeStaticProvider([textResponse('unused')]),
      });

      const workers = await q.listWorkers();
      expect(workers.some((worker) => worker.workerId === alphaWorkerId)).toBe(true);
      expect(workers.some((worker) => worker.workerId === betaWorkerId)).toBe(true);

      const alphaWorkers = await q.listWorkers({ teamName: alphaTeamName });
      expect(alphaWorkers).toHaveLength(1);
      expect(alphaWorkers[0]?.workerId).toBe(alphaWorkerId);

      const worker = await q.getWorker(alphaWorkerId);
      expect(worker?.workerType).toBe('worker');
      expect(worker?.parentToolCallId).toBe('task-alpha');
      expect(worker?.parentSessionId).toBe('session-alpha');
      expect(worker?.summary).toContain('completed alpha worker');

      await expect(q.getWorker('missing-worker')).resolves.toBeNull();
      q.close();
    } finally {
      for (const dir of cleanupDirs) {
        rmSync(dir, { recursive: true, force: true });
      }
      temp.cleanup();
    }
  });

  it('stops a live background worker in the current runtime', async () => {
    const temp = makeTempHome('open-agent-sdk-worker-stop-');
    const teamName = `alpha-team-${Date.now()}`;

    try {
      const q = query('launch background worker directly', {
        cwd: temp.cwd,
        model: 'mock-model',
        provider: makeDirectLaunchProvider(),
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
      });
      await q.createTeam({ name: teamName, setActive: true });
      const launched = await q.launchWorker({
        prompt: 'Wait until stopped.',
        name: 'alice',
        teamName,
      });

      const workers = await q.listWorkers({ teamName });
      expect(workers).toHaveLength(1);
      expect(workers[0]!.workerId).toBe(launched.workerId);
      expect(['spawning', 'running']).toContain(workers[0]!.status);

      const stopped = await q.stopWorker(workers[0]!.workerId);
      expect(stopped).toEqual({ success: true });

      const worker = await waitForWorkerStatus(q, workers[0]!.workerId, 'shutdown');
      expect(worker?.status).toBe('shutdown');
      expect(worker?.teamName).toBe(teamName);

      await expect(q.stopWorker('missing-worker')).resolves.toEqual({ success: false });
      q.close();
    } finally {
      temp.cleanup();
    }
  });

  it('builds Claude Code style follow-up suggestions for finished workers', async () => {
    const temp = makeTempHome('open-agent-sdk-worker-followups-');
    const completedWorkerId = `worker-completed-${Date.now()}`;
    const failedWorkerId = `worker-failed-${Date.now()}`;
    const stoppedWorkerId = `worker-stopped-${Date.now()}`;
    const runningWorkerId = `worker-running-${Date.now()}`;
    const cleanupDirs: string[] = [];

    try {
      cleanupDirs.push(writeWorkerSession(temp.cwd, {
        agentId: completedWorkerId,
        agentType: 'worker',
        state: 'completed',
        startedAt: '2026-04-01T10:00:00.000Z',
        completedAt: '2026-04-01T10:05:00.000Z',
        model: 'mock-model',
        numTurns: 3,
        durationMs: 300_000,
        result: 'implemented the requested change',
      }));
      cleanupDirs.push(writeWorkerSession(temp.cwd, {
        agentId: failedWorkerId,
        agentType: 'worker',
        state: 'failed',
        startedAt: '2026-04-01T11:00:00.000Z',
        completedAt: '2026-04-01T11:02:00.000Z',
        model: 'mock-model',
        numTurns: 2,
        durationMs: 120_000,
        error: 'tests failed on the narrowed fix',
      }));
      cleanupDirs.push(writeWorkerSession(temp.cwd, {
        agentId: stoppedWorkerId,
        agentType: 'worker',
        state: 'shutdown',
        startedAt: '2026-04-01T12:00:00.000Z',
        completedAt: '2026-04-01T12:01:00.000Z',
        model: 'mock-model',
        numTurns: 1,
        durationMs: 60_000,
        result: 'interrupted after partial progress',
      }));
      cleanupDirs.push(writeWorkerSession(temp.cwd, {
        agentId: runningWorkerId,
        agentType: 'worker',
        state: 'running',
        startedAt: '2026-04-01T13:00:00.000Z',
        model: 'mock-model',
        numTurns: 0,
        durationMs: 0,
      }));

      const q = query('worker followups', {
        cwd: temp.cwd,
        model: 'mock-model',
        provider: makeStaticProvider([textResponse('unused')]),
      });

      const completed = await q.getWorkerFollowUps(completedWorkerId);
      expect(completed.map((item) => item.scaffold.kind)).toEqual([
        'resume_worker',
        'launch_verifier',
      ]);
      expect(completed[0]?.scaffold.action).toEqual({
        tool: 'Task',
        arguments: {
          description: 'Resume existing worker',
          prompt: completed[0]?.scaffold.prompt,
          subagent_type: 'worker',
          resume: completedWorkerId,
        },
      });

      const failed = await q.getWorkerFollowUps(failedWorkerId);
      expect(failed.map((item) => item.scaffold.kind)).toEqual(['retry_worker']);
      expect(failed[0]?.scaffold.resume_task_id).toBe(failedWorkerId);

      const stopped = await q.getWorkerFollowUps(stoppedWorkerId);
      expect(stopped.map((item) => item.scaffold.kind)).toEqual(['stopped_worker_followup']);
      expect(stopped[0]?.scaffold.resume_task_id).toBe(stoppedWorkerId);

      await expect(q.getWorkerFollowUps(runningWorkerId)).resolves.toEqual([]);
      await expect(q.getWorkerFollowUps('missing-worker')).resolves.toEqual([]);
      q.close();
    } finally {
      for (const dir of cleanupDirs) {
        rmSync(dir, { recursive: true, force: true });
      }
      temp.cleanup();
    }
  });

  it('launches, resumes, and verifies workers directly through the SDK control plane', async () => {
    const temp = makeTempHome('open-agent-sdk-worker-launch-');
    const teamName = `alpha-team-${Date.now()}`;

    try {
      const q = query('direct worker control plane', {
        cwd: temp.cwd,
        model: 'mock-model',
        provider: makeDirectLaunchProvider(),
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
      });

      await q.createTeam({ name: teamName, setActive: true });
      const eventIterator = q.subscribeOrchestrationEvents({ teamName })[Symbol.asyncIterator]();

      const launchedWorker = await q.launchWorker({
        prompt: 'Wait until stopped.',
        name: 'alice',
      });
      expect(launchedWorker.workerType).toBe('worker');
      expect(launchedWorker.teamName).toBe(teamName);

      const launchedEvent = await readEventOfType(eventIterator, 'launched');
      expect(launchedEvent?.kind).toBe('worker_lifecycle');
      expect(launchedEvent?.raw.type).toBe('launched');
      expect(launchedEvent?.workerId).toBe(launchedWorker.workerId);

      const verifier = await q.launchVerifier({
        prompt: 'Verify the previous worker output.',
        name: 'vera',
        teamName,
      });
      expect(verifier.workerType).toBe('verifier');
      expect(verifier.teamName).toBe(teamName);

      const verifierLaunchEvent = await readEventOfType(eventIterator, 'launched');
      expect(verifierLaunchEvent?.workerId).toBe(verifier.workerId);
      expect(verifierLaunchEvent?.raw.type).toBe('launched');

      expect(await q.stopWorker(launchedWorker.workerId)).toEqual({ success: true });
      await waitForWorkerStatus(q, launchedWorker.workerId, 'shutdown');
      const shutdownEvent = await readEventOfType(eventIterator, 'shutdown');
      expect(shutdownEvent?.workerId).toBe(launchedWorker.workerId);

      const resumedWorker = await q.resumeWorker(launchedWorker.workerId, {
        prompt: 'Continue after being stopped.',
        teamName,
      });
      expect(resumedWorker.workerId).toBe(launchedWorker.workerId);
      expect(resumedWorker.workerType).toBe('worker');

      const resumedEvent = await readEventOfType(eventIterator, 'launched');
      expect(resumedEvent?.workerId).toBe(launchedWorker.workerId);
      expect(resumedEvent?.raw.type).toBe('launched');

      const followUps = await q.getWorkerFollowUps(launchedWorker.workerId);
      expect(followUps).toEqual([]);

      expect(await q.stopWorker(resumedWorker.workerId)).toEqual({ success: true });
      expect(await q.stopWorker(verifier.workerId)).toEqual({ success: true });
      await waitForWorkerStatus(q, resumedWorker.workerId, 'shutdown');
      await waitForWorkerStatus(q, verifier.workerId, 'shutdown');

      const workers = await q.listWorkers({ teamName });
      expect(workers.map((worker) => worker.workerId).sort()).toEqual(
        [launchedWorker.workerId, verifier.workerId].sort(),
      );

      await eventIterator.return?.();
      q.close();
    } finally {
      temp.cleanup();
    }
  });
});
