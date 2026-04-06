import { describe, expect, it, spyOn, afterEach, type Mock } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import type { ChatOptions, LLMProvider, Message, StreamEvent } from '@open-agent/providers';
import type { Query, WorkerRecord, TaskDispatcherRecord } from '../types.js';
import { query } from '../query.js';
import { AgentExecutor } from '@open-agent/agents';
import { makeLockedTempHome as makeTempHome } from './temp-home.js';

// ---------------------------------------------------------------------------
// Spies for Fix 1: fork isolation via executeFollowUp scaffold
// ---------------------------------------------------------------------------

let executeForkedSpy: Mock<any>;
let executeInBackgroundSpy: Mock<any>;
let getAgentSpy: Mock<any>;

function makeMinimalSession(agentId: string) {
  return {
    agentId,
    agentType: 'worker',
    state: 'running' as const,
    startedAt: new Date().toISOString(),
    model: 'mock-model',
    numTurns: 0,
    durationMs: 0,
    totalToolUseCount: 0,
    totalTokens: 0,
  };
}

function installForkSpies() {
  let lastAgentId = '';

  executeForkedSpy = spyOn(AgentExecutor.prototype, 'executeForked').mockImplementation(
    async () => {
      lastAgentId = `fork-${randomUUID()}`;
      return { agentId: lastAgentId, outputFile: '/tmp/fake.output' };
    },
  );
  executeInBackgroundSpy = spyOn(AgentExecutor.prototype, 'executeInBackground').mockImplementation(
    async () => {
      lastAgentId = `bg-${randomUUID()}`;
      return { agentId: lastAgentId, outputFile: '/tmp/fake-bg.output' };
    },
  );
  // getAgent must return a session for the agentId returned by the spy
  getAgentSpy = spyOn(AgentExecutor.prototype, 'getAgent').mockImplementation(
    (agentId: string) => makeMinimalSession(agentId),
  );
}

function restoreForkSpies() {
  executeForkedSpy?.mockRestore();
  executeInBackgroundSpy?.mockRestore();
  getAgentSpy?.mockRestore();
}

afterEach(() => {
  restoreForkSpies();
});

function makeBackgroundProvider(): LLMProvider {
  return {
    name: 'mock-follow-up-background-provider',
    async *chat(_messages: Message[], options: ChatOptions): AsyncGenerator<StreamEvent> {
      await new Promise<void>((resolve) => {
        if (options.signal?.aborted) {
          resolve();
          return;
        }
        options.signal?.addEventListener('abort', () => resolve(), { once: true });
      });

      throw new Error('follow-up worker aborted for test');
    },
    async listModels() {
      return [{ value: 'mock-model', displayName: 'Mock Model', description: 'Follow-up dispatch test model' }];
    },
  };
}

function makeStaticProvider(): LLMProvider {
  return {
    name: 'mock-follow-up-static-provider',
    async *chat(_messages: Message[], _options: ChatOptions): AsyncGenerator<StreamEvent> {
      yield { type: 'text_delta', text: 'unused' };
      yield { type: 'message_end', message: {}, usage: { input_tokens: 10, output_tokens: 20 } };
    },
    async listModels() {
      return [{ value: 'mock-model', displayName: 'Mock Model', description: 'Follow-up dispatch test model' }];
    },
  };
}

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
    completedAt?: string;
    result?: string;
    error?: string;
  },
): string {
  const dir = join(cwd, '.open-agent', 'agent-sessions', session.agentId);
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

describe('query() follow-up dispatcher', () => {
  it('executes Task scaffold follow-ups through stable SDK APIs', async () => {
    const temp = makeTempHome('open-agent-sdk-follow-up-worker-');
    const teamName = `alpha-team-${Date.now()}`;
    const workerId = `worker-${Date.now()}`;
    let workerDir = '';

    try {
      workerDir = writeWorkerSession(temp.cwd, {
        agentId: workerId,
        agentType: 'worker',
        state: 'shutdown',
        teamName,
        startedAt: '2026-04-01T10:00:00.000Z',
        completedAt: '2026-04-01T10:01:00.000Z',
        model: 'mock-model',
        numTurns: 1,
        durationMs: 60_000,
        result: 'interrupted after partial progress',
      });

      const q = query('follow-up worker', {
        cwd: temp.cwd,
        model: 'mock-model',
        provider: makeBackgroundProvider(),
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
      });

      await q.createTeam({ name: teamName, setActive: true });
      const dispatched = await q.executeFollowUp({
        suggestion: 'Resume the stopped worker.',
        scaffold: {
          kind: 'stopped_worker_followup',
          action: {
            tool: 'Task',
            arguments: {
              description: 'Resume existing worker',
              prompt: 'Continue after being stopped.',
              subagent_type: 'worker',
              resume: workerId,
            },
          },
        },
      });
      expect(dispatched.kind).toBe('worker');
      if (dispatched.kind === 'worker') {
        const worker = dispatched.worker!;
        expect(dispatched.followUpKind).toBe('stopped_worker_followup');
        expect(worker.workerId).toBe(workerId);
        expect(worker.teamName).toBe(teamName);
        expect(await q.stopWorker(workerId)).toEqual({ success: true });
        await waitForWorkerStatus(q, workerId, 'shutdown');
      }

      q.close();
    } finally {
      if (workerDir) {
        rmSync(workerDir, { recursive: true, force: true });
      }
      temp.cleanup();
    }
  });

  it('executes raw SendMessage scaffolds without the host re-parsing scaffold arguments', async () => {
    const temp = makeTempHome('open-agent-sdk-follow-up-message-');

    try {
      const q = query('follow-up message', {
        cwd: temp.cwd,
        model: 'mock-model',
        provider: makeStaticProvider(),
      });

      const teamName = `alpha-team-${Date.now()}`;
      await q.createTeam({ name: teamName, setActive: true });

      const dispatched = await q.executeFollowUp({
        kind: 'generic_followup',
        action: {
          tool: 'SendMessage',
          arguments: {
            type: 'message',
            from: 'coordinator',
            to: 'alice',
            requestId: 'follow-up-request',
            summary: 'Next step',
            content: 'Continue from the partial worker result.',
          },
        },
      });
      expect(dispatched.kind).toBe('team_message');
      if (dispatched.kind === 'team_message') {
        expect(dispatched.followUpKind).toBe('generic_followup');
        expect(dispatched.teamMessage?.teamName).toBe(teamName);
        expect(dispatched.teamMessage?.from).toBe('coordinator');
        expect(dispatched.teamMessage?.to).toBe('alice');
        expect(dispatched.teamMessage?.requestId).toBe('follow-up-request');
      }

      const inbox = await q.readTeamInbox({ teamName, memberName: 'alice', consume: true });
      expect(inbox).toHaveLength(1);
      expect(inbox[0]?.content).toBe('Continue from the partial worker result.');
      q.close();
    } finally {
      temp.cleanup();
    }
  });

  it('executes TaskDispatcher scaffolds through the same follow-up entrypoint', async () => {
    const temp = makeTempHome('open-agent-sdk-follow-up-dispatcher-');

    try {
      const q = query('follow-up dispatcher', {
        cwd: temp.cwd,
        model: 'mock-model',
        provider: makeBackgroundProvider(),
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
      });

      const teamName = `alpha-team-${Date.now()}`;
      await q.createTeam({ name: teamName, setActive: true });
      await q.createTask({
        teamName,
        subject: 'Dispatch with follow-up',
        description: 'Use follow-up to manage dispatcher lifecycle.',
        priority: 10,
      });

      const started = await q.executeFollowUp({
        kind: 'generic_followup',
        action: {
          tool: 'TaskDispatcher',
          arguments: {
            action: 'start',
            dispatcher_id: `dispatcher-${Date.now()}`,
            owner: 'dispatcher-owner',
            team_name: teamName,
            poll_interval_ms: 25,
            lease_ms: 500,
            max_concurrent_workers: 1,
          },
        },
      });
      expect(started.kind).toBe('task_dispatcher');
      expect(started.dispatcher?.status).toBe('running');

      const activeDispatcher = await waitForDispatcher(
        q,
        started.dispatcher!.dispatcherId,
        (dispatcher) => dispatcher.status === 'running' && dispatcher.activeAssignments.length === 1,
      );
      expect(activeDispatcher.teamName).toBe(teamName);

      const requeued = await q.executeFollowUp({
        kind: 'generic_followup',
        action: {
          tool: 'TaskDispatcher',
          arguments: {
            action: 'requeue',
            dispatcher_id: started.dispatcher!.dispatcherId,
            task_id: activeDispatcher.activeAssignments[0]!.taskId,
            worker_id: activeDispatcher.activeAssignments[0]!.workerId,
          },
        },
      });
      expect(requeued.kind).toBe('task_dispatcher');
      expect(requeued.dispatcherRequeue?.success).toBe(true);
      expect(requeued.dispatcherRequeue?.task?.status).toBe('pending');
      expect(requeued.dispatcher?.dispatcherId).toBe(started.dispatcher!.dispatcherId);

      const stopped = await q.executeFollowUp({
        kind: 'generic_followup',
        action: {
          tool: 'TaskDispatcher',
          arguments: {
            action: 'stop',
            dispatcher_id: started.dispatcher!.dispatcherId,
          },
        },
      });
      expect(stopped.kind).toBe('task_dispatcher');
      expect(stopped.dispatcherStop?.success).toBe(true);
      expect(stopped.dispatcher?.dispatcherId).toBe(started.dispatcher!.dispatcherId);

      q.close();
    } finally {
      temp.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Fix 1 verification: executeFollowUp scaffold forwards isolation='fork'
// ---------------------------------------------------------------------------

describe('executeFollowUp: isolation=fork scaffold path (R10 fix)', () => {
  it('forwards isolation=fork to launchWorker → executeForked, not executeInBackground', async () => {
    const temp = makeTempHome('open-agent-sdk-follow-up-fork-isolation-');
    installForkSpies();

    try {
      const q = query('follow-up fork isolation', {
        cwd: temp.cwd,
        model: 'mock-model',
        provider: makeBackgroundProvider(),
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
      });

      const teamName = `fork-team-${Date.now()}`;
      await q.createTeam({ name: teamName, setActive: true });

      const dispatched = await q.executeFollowUp({
        kind: 'generic_followup',
        action: {
          tool: 'Task',
          arguments: {
            description: 'Fork isolation worker',
            prompt: 'Run with fork isolation.',
            subagent_type: 'worker',
            team_name: teamName,
            isolation: 'fork',
          },
        },
      });

      // The result is a worker launch
      expect(dispatched.kind).toBe('worker');
      if (dispatched.kind === 'worker') {
        expect(dispatched.followUpKind).toBe('generic_followup');
      }

      // isolation='fork' must have routed to executeForked, not executeInBackground
      expect(executeForkedSpy).toHaveBeenCalledTimes(1);
      expect(executeInBackgroundSpy).toHaveBeenCalledTimes(0);

      q.close();
    } finally {
      temp.cleanup();
    }
  });

  it('does NOT forward isolation=none to launchWorker (falls back to executeInBackground)', async () => {
    const temp = makeTempHome('open-agent-sdk-follow-up-none-isolation-');
    installForkSpies();

    try {
      const q = query('follow-up none isolation', {
        cwd: temp.cwd,
        model: 'mock-model',
        provider: makeBackgroundProvider(),
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
      });

      const teamName = `none-team-${Date.now()}`;
      await q.createTeam({ name: teamName, setActive: true });

      const dispatched = await q.executeFollowUp({
        kind: 'generic_followup',
        action: {
          tool: 'Task',
          arguments: {
            description: 'No-isolation worker',
            prompt: 'Run without isolation.',
            subagent_type: 'worker',
            team_name: teamName,
            isolation: 'none',
          },
        },
      });

      expect(dispatched.kind).toBe('worker');
      // isolation='none' is not forwarded → background dispatch, not fork
      expect(executeForkedSpy).toHaveBeenCalledTimes(0);
      expect(executeInBackgroundSpy).toHaveBeenCalledTimes(1);

      q.close();
    } finally {
      temp.cleanup();
    }
  });
});
