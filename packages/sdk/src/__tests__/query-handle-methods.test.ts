import { describe, it, expect } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SessionManager } from '@open-agent/core';
import type { SDKMessage, ModelInfo } from '@open-agent/core';
import type { LLMProvider, Message, StreamEvent, ChatOptions } from '@open-agent/providers';
import { query } from '../query.js';
import { createSdkMcpServer, tool } from '../mcp-helpers.js';
import { savePersistedBackgroundTask } from '@open-agent/tools';
import type { SDKOrchestrationEvent } from '../types.js';

function createTempHome(prefix: string): { cwd: string; originalHome: string | undefined; restore(): void } {
  const cwd = mkdtempSync(join(tmpdir(), prefix));
  const home = join(cwd, 'home');
  mkdirSync(home, { recursive: true });
  const originalHome = process.env.HOME;
  process.env.HOME = home;

  return {
    cwd,
    originalHome,
    restore() {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      rmSync(cwd, { recursive: true, force: true });
    },
  };
}

function makeMockProvider(responses: StreamEvent[][]): LLMProvider {
  let callIndex = 0;

  return {
    name: 'mock-query-provider',
    async *chat(_messages: Message[], _options: ChatOptions): AsyncGenerator<StreamEvent> {
      const events = responses[Math.min(callIndex, responses.length - 1)] ?? [];
      callIndex++;
      for (const event of events) {
        yield event;
      }
    },
    async listModels(): Promise<ModelInfo[]> {
      return [{ value: 'mock-model', displayName: 'Mock Model', description: 'Test model' }];
    },
  };
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

async function collectMessages(gen: AsyncGenerator<SDKMessage>): Promise<SDKMessage[]> {
  const messages: SDKMessage[] = [];
  for await (const message of gen) {
    messages.push(message);
  }
  return messages;
}

function isSubagentSystemPrompt(systemPrompt: ChatOptions['systemPrompt']): boolean {
  return typeof systemPrompt === 'string'
    && systemPrompt.includes('You are a subagent working on behalf of another OpenAgent agent.');
}

function createBackgroundWorkerProvider(input: {
  taskToolUseId: string;
  workerName: string;
  teamName: string;
}): {
  provider: LLMProvider;
  waitForWorkerStart: Promise<void>;
} {
  let workerStartedResolve: (() => void) | null = null;
  const waitForWorkerStart = new Promise<void>((resolve) => {
    workerStartedResolve = resolve;
  });

  return {
    provider: {
      name: 'mock-background-worker-provider',
      async *chat(messages: Message[], options: ChatOptions): AsyncGenerator<StreamEvent> {
        if (!isSubagentSystemPrompt(options.systemPrompt)) {
          const hasTaskResult = messages.some((message) =>
            Array.isArray(message.content)
            && message.content.some((block) => block?.type === 'tool_result'),
          );

          if (!hasTaskResult) {
            yield* toolUseResponse(input.taskToolUseId, 'Task', {
              description: 'Launch background worker',
              prompt: 'Wait until you are stopped.',
              subagent_type: 'worker',
              name: input.workerName,
              team_name: input.teamName,
              run_in_background: true,
            });
            return;
          }

          yield* textResponse('parent done');
          return;
        }

        workerStartedResolve?.();
        workerStartedResolve = null;
        await new Promise<void>((resolve) => {
          if (options.signal?.aborted) {
            resolve();
            return;
          }
          options.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
      },
      async listModels(): Promise<ModelInfo[]> {
        return [{ value: 'mock-model', displayName: 'Mock Model', description: 'Background worker test model' }];
      },
    },
    waitForWorkerStart,
  };
}

// ---------------------------------------------------------------------------
// initializationResult()
// ---------------------------------------------------------------------------

describe('query().initializationResult()', () => {
  it('returns the expected shape', async () => {
    const q = query('test', { model: 'claude-sonnet-4-6' });
    const result = await q.initializationResult();
    expect(result).toHaveProperty('commands');
    expect(result).toHaveProperty('agents');
    expect(result).toHaveProperty('skills');
    expect(result).toHaveProperty('output_style');
    expect(result).toHaveProperty('available_output_styles');
    expect(result).toHaveProperty('models');
    expect(result).toHaveProperty('account');
    expect(result).toHaveProperty('capability_snapshot');
    if ('fast_mode_state' in result) {
      expect((result as any).fast_mode_state).toBeUndefined();
    }
    expect(Array.isArray(result.commands)).toBe(true);
    expect(Array.isArray(result.agents)).toBe(true);
    expect(Array.isArray(result.skills)).toBe(true);
    expect(Array.isArray(result.available_output_styles)).toBe(true);
    expect(typeof result.output_style).toBe('string');
    q.close();
  });

  it('returns official-style initialization keys only', async () => {
    const q = query('test', { model: 'claude-haiku-4-5' });
    const result = await q.initializationResult();
    const keys = Object.keys(result);
    expect(keys).toEqual(expect.arrayContaining([
      'account',
      'agents',
      'available_output_styles',
      'capability_snapshot',
      'commands',
      'models',
      'output_style',
      'skills',
    ]));
    const allowedKeys = new Set([
      'account',
      'agents',
      'available_output_styles',
      'capability_snapshot',
      'commands',
      'models',
      'output_style',
      'skills',
      'fast_mode_state',
    ]);
    expect(keys.every((k) => allowedKeys.has(k))).toBe(true);
    expect((result as any).model).toBeUndefined();
    expect((result as any).cwd).toBeUndefined();
    expect((result as any).sessionId).toBeUndefined();
    expect((result as any).permissionMode).toBeUndefined();
    expect((result as any).capability_snapshot?.totalTools).toBeGreaterThan(0);
    q.close();
  });

  it('returns a fresh copy each time (not the same reference)', async () => {
    const q = query('test', { model: 'claude-sonnet-4-6' });
    const a = await q.initializationResult();
    const b = await q.initializationResult();
    expect(a).not.toBe(b); // different object reference
    expect(a).toEqual(b);  // same values
    q.close();
  });

  it('reflects the configured output style', async () => {
    const q = query('test', {
      model: 'claude-sonnet-4-6',
      outputStyle: 'stream-json',
    });
    const result = await q.initializationResult();
    expect(result.output_style).toBe('stream-json');
    q.close();
  });
});

describe('query().sessionInfo()', () => {
  it('returns persisted session metadata for the current session', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'open-agent-session-info-'));
    const q = query('设计一下 harness', {
      cwd,
      model: 'claude-sonnet-4-6',
      permissionMode: 'acceptEdits',
      outputStyle: 'stream-json',
      language: 'Chinese',
      sessionTitle: 'Harness 对齐',
    });

    const info = await q.sessionInfo();
    expect(info).not.toBeNull();
    expect(info?.cwd).toBe(cwd);
    expect(info?.model).toBe('claude-sonnet-4-6');
    expect(info?.permissionMode).toBe('acceptEdits');
    expect(info?.outputStyle).toBe('stream-json');
    expect(info?.language).toBe('Chinese');
    expect(info?.title).toBe('Harness 对齐');
    expect(info?.createdFromPrompt).toContain('设计一下 harness');
    q.close();
  });
});

describe('query() team control plane', () => {
  it('creates, lists, retrieves, activates, and deletes teams', async () => {
    const temp = createTempHome('open-agent-sdk-team-plane-');

    try {
      const q = query('manage teams', { cwd: temp.cwd, model: 'claude-sonnet-4-6' });
      const alphaName = `alpha-${Date.now()}`;
      const betaName = `beta-${Date.now()}`;

      const alpha = await q.createTeam({
        name: alphaName,
        description: 'Primary workers',
      });
      expect(alpha.name).toBe(alphaName);
      expect(alpha.description).toBe('Primary workers');
      expect(alpha.isActive).toBe(true);

      const beta = await q.createTeam({
        name: betaName,
        description: 'Verification lane',
        setActive: false,
      });
      expect(beta.isActive).toBe(false);

      const teams = await q.listTeams();
      expect(teams.some((team) => team.name === alphaName)).toBe(true);
      expect(teams.some((team) => team.name === betaName)).toBe(true);

      const fetched = await q.getTeam(alphaName);
      expect(fetched?.scratchpadPath).toContain(`/${alphaName}/scratchpad`);

      const active = await q.getActiveTeam();
      expect(active?.name).toBe(alphaName);

      const switched = await q.setActiveTeam(betaName);
      expect(switched?.name).toBe(betaName);
      expect((await q.getActiveTeam())?.name).toBe(betaName);

      expect(await q.deleteTeam(betaName)).toEqual({ success: true });
      expect(await q.getTeam(betaName)).toBeNull();

      await expect(q.setActiveTeam(null)).resolves.toBeNull();
      expect(await q.getActiveTeam()).toBeNull();
      q.close();
    } finally {
      temp.restore();
    }
  });

  it('sends and reads team inbox messages', async () => {
    const temp = createTempHome('open-agent-sdk-team-inbox-');

    try {
      const q = query('team inbox', { cwd: temp.cwd, model: 'claude-sonnet-4-6' });
      const teamName = `alpha-${Date.now()}`;
      await q.createTeam({ name: teamName });

      const sent = await q.sendTeamMessage({
        teamName,
        type: 'shutdown_request',
        recipient: 'alice',
        content: 'Please stop after finishing the current step.',
        summary: 'shutdown alice',
      });
      expect(sent.teamName).toBe(teamName);
      expect(sent.requestId).toBeTruthy();

      expect(await q.getTeamInboxCount('alice', { teamName })).toBe(1);

      const peeked = await q.readTeamInbox({ teamName, memberName: 'alice', consume: false });
      expect(peeked).toHaveLength(1);
      expect(peeked[0]?.type).toBe('shutdown_request');
      expect(await q.getTeamInboxCount('alice', { teamName })).toBe(1);

      const consumed = await q.readTeamInbox({ teamName, memberName: 'alice', consume: true });
      expect(consumed).toHaveLength(1);
      expect(consumed[0]?.content).toContain('Please stop');
      expect(await q.getTeamInboxCount('alice', { teamName })).toBe(0);
      q.close();
    } finally {
      temp.restore();
    }
  });

  it('lists and responds to pending team approvals', async () => {
    const temp = createTempHome('open-agent-sdk-team-approvals-');

    try {
      const q = query('team approvals', { cwd: temp.cwd, model: 'claude-sonnet-4-6' });
      const teamName = `alpha-${Date.now()}`;
      await q.createTeam({ name: teamName });

      const request = await q.sendTeamMessage({
        teamName,
        type: 'plan_approval_request',
        from: 'worker-1',
        recipient: 'lead',
        content: 'Approve the planned refactor.',
        summary: 'plan approval',
      });
      expect(request.requestId).toBeTruthy();

      const pending = await q.listPendingTeamApprovals({
        teamName,
        memberName: 'lead',
        unreadOnly: true,
      });
      expect(pending).toHaveLength(1);
      expect(pending[0]?.requestType).toBe('plan_approval_request');

      const response = await q.respondToTeamApproval({
        teamName,
        memberName: 'lead',
        messageId: pending[0]!.messageId,
        approve: true,
        from: 'team-lead',
        feedback: 'Proceed with the refactor.',
      });
      expect(response.acknowledged).toBe(1);
      expect(response.request.requestId).toBe(request.requestId!);
      expect(response.response.type).toBe('plan_approval_response');
      expect(response.response.approve).toBe(true);

      const workerInbox = await q.readTeamInbox({ teamName, memberName: 'worker-1', consume: false });
      expect(
        workerInbox.some(
          (message) =>
            message.type === 'plan_approval_response'
            && message.requestId === request.requestId
            && message.approve === true,
        ),
      ).toBe(true);
      expect(
        await q.listPendingTeamApprovals({
          teamName,
          memberName: 'lead',
          unreadOnly: true,
        }),
      ).toHaveLength(0);
      q.close();
    } finally {
      temp.restore();
    }
  });
});

describe('query() orchestration event subscriptions', () => {
  it('streams live worker lifecycle and tool events through the SDK control plane', async () => {
    const temp = createTempHome('open-agent-sdk-orchestration-');

    try {
      const provider = makeMockProvider([
        toolUseResponse('task-parent', 'Task', {
          description: 'Delegate worker',
          prompt: 'Use DummyTool once, then report completion.',
          subagent_type: 'worker',
          name: 'alice',
          team_name: 'alpha-team',
        }),
        toolUseResponse('worker-tool-1', 'DummyTool', { value: 'from-worker' }),
        textResponse('worker finished successfully'),
        textResponse('parent done'),
      ]);

      const q = query('delegate the work', {
        cwd: temp.cwd,
        model: 'mock-model',
        provider,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        setupTools(registry) {
          registry.register({
            name: 'DummyTool',
            description: 'Return a stable string for orchestration tests.',
            inputSchema: {
              type: 'object',
              properties: {
                value: { type: 'string' },
              },
              required: ['value'],
            },
            async execute(input) {
              return `dummy:${String((input as { value?: string }).value ?? '')}`;
            },
          });
        },
      });

      const subscription = q.subscribeOrchestrationEvents({ teamName: 'alpha-team' });
      await collectMessages(q);
      q.close();

      const events: SDKOrchestrationEvent[] = [];
      for await (const event of subscription) {
        events.push(event);
      }

      expect(events.length).toBeGreaterThanOrEqual(4);
      expect(events.every((event) => event.sessionId)).toBe(true);
      expect(events.every((event) => event.parentToolCallId === 'task-parent')).toBe(true);
      expect(events.every((event) => event.teamName === 'alpha-team')).toBe(true);
      expect(events.some((event) => event.kind === 'worker_lifecycle' && event.raw.type === 'launched')).toBe(true);
      expect(events.some((event) => event.kind === 'worker_tool' && event.raw.type === 'tool_start' && event.raw.toolName === 'DummyTool')).toBe(true);
      expect(events.some((event) =>
        event.kind === 'worker_tool'
        && event.raw.type === 'tool_result'
        && event.raw.toolName === 'DummyTool')).toBe(true);
      expect(events.some((event) => event.kind === 'worker_lifecycle' && event.raw.type === 'completed')).toBe(true);
    } finally {
      temp.restore();
    }
  });

  it('supports type filters and abort-driven shutdown', async () => {
    const temp = createTempHome('open-agent-sdk-orchestration-abort-');

    try {
      const provider = makeMockProvider([
        toolUseResponse('task-parent', 'Task', {
          description: 'Delegate worker',
          prompt: 'Use DummyTool once, then report completion.',
          subagent_type: 'worker',
          name: 'alice',
          team_name: 'alpha-team',
        }),
        toolUseResponse('worker-tool-1', 'DummyTool', { value: 'from-worker' }),
        textResponse('worker finished successfully'),
        textResponse('parent done'),
      ]);

      const q = query('delegate the work', {
        cwd: temp.cwd,
        model: 'mock-model',
        provider,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        setupTools(registry) {
          registry.register({
            name: 'DummyTool',
            description: 'Return a stable string for orchestration tests.',
            inputSchema: {
              type: 'object',
              properties: {
                value: { type: 'string' },
              },
              required: ['value'],
            },
            async execute(input) {
              return `dummy:${String((input as { value?: string }).value ?? '')}`;
            },
          });
        },
      });

      const controller = new AbortController();
      const lifecycleOnly = q.subscribeOrchestrationEvents({
        types: ['worker_lifecycle'],
        signal: controller.signal,
      })[Symbol.asyncIterator]();

      const runPromise = collectMessages(q);
      const first = await lifecycleOnly.next();
      expect(first.done).toBe(false);
      expect(first.value?.kind).toBe('worker_lifecycle');

      controller.abort();
      await runPromise;
      q.close();

      await expect(lifecycleOnly.next()).resolves.toEqual({ done: true, value: undefined });
    } finally {
      temp.restore();
    }
  });
});

describe('query() worker lifecycle control plane', () => {
  it('lists, retrieves, and stops live background workers', async () => {
    const temp = createTempHome('open-agent-sdk-workers-');

    try {
      const workerName = `alice-${Date.now()}`;
      const taskToolUseId = `task-parent-bg-${Date.now()}`;
      const teamName = 'alpha-team';
      const { provider, waitForWorkerStart } = createBackgroundWorkerProvider({
        taskToolUseId,
        workerName,
        teamName,
      });
      const q = query('launch a background worker', {
        cwd: temp.cwd,
        model: 'mock-model',
        provider,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
      });

      await collectMessages(q);
      await waitForWorkerStart;

      const workers = await q.listWorkers({ teamName: 'alpha-team' });
      const worker = workers.find((entry) =>
        entry.parentToolCallId === taskToolUseId
        && entry.name === workerName
        && entry.teamName === teamName,
      );
      expect(worker).toBeDefined();
      expect(worker?.workerType).toBe('worker');
      expect(worker?.status === 'running' || worker?.status === 'spawning').toBe(true);

      const fetched = await q.getWorker(worker!.workerId);
      expect(fetched?.workerId).toBe(worker?.workerId);
      expect(fetched?.teamName).toBe(teamName);

      await expect(q.stopWorker(worker!.workerId)).resolves.toEqual({ success: true });
      expect((await q.getWorker(worker!.workerId))?.status).toBe('shutdown');
      q.close();
    } finally {
      temp.restore();
    }
  });
});

describe('query() shared task control plane', () => {
  it('creates, updates, lists, and retrieves shared tasks', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'open-agent-sdk-task-plane-'));
    const home = join(cwd, 'home');
    mkdirSync(home, { recursive: true });
    const originalHome = process.env.HOME;
    process.env.HOME = home;

    try {
      const q = query('安排一下任务', {
        cwd,
        model: 'claude-sonnet-4-6',
      });

      const created = await q.createTask({
        subject: 'Align SDK task plane',
        description: 'Expose task APIs in the SDK and wire priority through.',
        priority: 7,
        metadata: { lane: 'sdk' },
        teamName: 'alpha',
      });
      expect(created.id).toBeTruthy();
      expect(created.status).toBe('pending');
      expect(created.priority).toBe(7);
      expect(created.teamName).toBe('alpha');

      const updated = await q.updateTask({
        taskId: created.id,
        teamName: 'alpha',
        status: 'in_progress',
        owner: 'sdk-worker',
        priority: 9,
      });
      expect(updated.status).toBe('in_progress');
      expect(updated.owner).toBe('sdk-worker');
      expect(updated.priority).toBe(9);
      expect(updated.teamName).toBe('alpha');

      const task = await q.getTask(created.id, { teamName: 'alpha' });
      expect(task).not.toBeNull();
      expect(task?.subject).toBe('Align SDK task plane');
      expect(task?.status).toBe('in_progress');
      expect(task?.owner).toBe('sdk-worker');
      expect(task?.priority).toBe(9);
      expect(task?.metadata).toEqual({ lane: 'sdk' });
      expect(task?.teamName).toBe('alpha');

      const tasks = await q.listTasks({ teamName: 'alpha' });
      expect(tasks.some((entry) => entry.id === created.id && entry.priority === 9)).toBe(true);
      q.close();
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('returns null for unknown shared tasks', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'open-agent-sdk-task-missing-'));
    const home = join(cwd, 'home');
    mkdirSync(home, { recursive: true });
    const originalHome = process.env.HOME;
    process.env.HOME = home;

    try {
      const q = query('empty tasks', { cwd, model: 'claude-sonnet-4-6' });
      await expect(q.getTask('missing-task')).resolves.toBeNull();
      q.close();
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('claims, heartbeats, and releases leased tasks per team', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'open-agent-sdk-task-lease-'));
    const home = join(cwd, 'home');
    mkdirSync(home, { recursive: true });
    const originalHome = process.env.HOME;
    process.env.HOME = home;

    try {
      const q = query('lease tasks', { cwd, model: 'claude-sonnet-4-6' });
      await q.createTask({
        subject: 'low',
        description: 'lower priority task',
        priority: 1,
        teamName: 'alpha',
      });
      const high = await q.createTask({
        subject: 'high',
        description: 'higher priority task',
        priority: 10,
        teamName: 'alpha',
      });

      const claimed = await q.claimNextTask('worker-a', {
        teamName: 'alpha',
        leaseMs: 60_000,
        now: new Date('2026-04-01T10:00:00.000Z'),
      });
      expect(claimed?.id).toBe(high.id);
      expect(claimed?.lease?.owner).toBe('worker-a');
      expect(claimed?.teamName).toBe('alpha');

      const available = await q.listTasks({
        teamName: 'alpha',
        availableOnly: true,
        now: new Date('2026-04-01T10:00:30.000Z'),
      });
      expect(available.map((task) => task.subject)).toEqual(['low']);

      const renewed = await q.heartbeatTask(claimed!.id, 'worker-a', {
        teamName: 'alpha',
        leaseMs: 30_000,
        now: new Date('2026-04-01T10:00:45.000Z'),
      });
      expect(renewed.lease?.expiresAt).toBe('2026-04-01T10:01:15.000Z');

      const released = await q.releaseTask(claimed!.id, 'worker-a', {
        teamName: 'alpha',
        status: 'completed',
      });
      expect(released.status).toBe('completed');
      expect(released.owner).toBe('worker-a');
      expect(released.lease).toBeUndefined();
      q.close();
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('dispatches the next available task into a background worker', async () => {
    const temp = createTempHome('open-agent-sdk-task-dispatch-');

    try {
      const teamName = `dispatch-team-${Date.now()}`;
      const { provider, waitForWorkerStart } = createBackgroundWorkerProvider({
        taskToolUseId: `dispatch-parent-${Date.now()}`,
        workerName: 'dispatch-worker',
        teamName,
      });
      const q = query('dispatch tasks', {
        cwd: temp.cwd,
        model: 'mock-model',
        provider,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
      });

      const task = await q.createTask({
        teamName,
        subject: 'Implement approval bridge',
        description: 'Claim this task and launch a worker.',
        priority: 10,
      });

      const dispatched = await q.dispatchNextTask({
        owner: 'dispatch-owner',
        teamName,
        name: 'dispatch-worker',
      });
      expect(dispatched).not.toBeNull();
      expect(dispatched?.task.id).toBe(task.id);
      expect(dispatched?.task.lease?.owner).toBe('dispatch-owner');
      expect(dispatched?.worker.teamName).toBe(teamName);

      await waitForWorkerStart;
      expect(await q.stopWorker(dispatched!.worker.workerId)).toEqual({ success: true });
      expect((await q.getWorker(dispatched!.worker.workerId))?.status).toBe('shutdown');
      q.close();
    } finally {
      temp.restore();
    }
  });
});

// ---------------------------------------------------------------------------
// stopTask()
// ---------------------------------------------------------------------------

describe('query().stopTask()', () => {
  it('does not abort caller-provided AbortController', async () => {
    const ac = new AbortController();
    const q = query('test', { model: 'claude-sonnet-4-6', abortController: ac });
    expect(ac.signal.aborted).toBe(false);
    await q.stopTask('task-1');
    expect(ac.signal.aborted).toBe(false);
    q.close();
  });

  it('accepts required taskId parameter', async () => {
    const q = query('test', { model: 'claude-sonnet-4-6' });
    // Should not throw with taskId
    await q.stopTask('task-1');
    await q.stopTask('some-task-id');
    q.close();
  });

  it('stops a persisted bash background task without aborting the query', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'open-agent-stop-task-'));
    savePersistedBackgroundTask({
      taskId: 'bg-stop-sdk',
      kind: 'bash',
      sessionId: 'session-sdk',
      command: 'npm test',
      cwd,
      summary: 'Run tests',
      status: 'stopped',
      startTime: Date.now(),
      outputFile: join(cwd, 'bg-stop-sdk.log'),
    });

    const q = query('test', { cwd, model: 'claude-sonnet-4-6' });
    await expect(q.stopTask('bg-stop-sdk')).resolves.toBeUndefined();
    q.close();
  });
});

describe('query() background task inspection', () => {
  it('lists persisted bash background tasks', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'open-agent-list-tasks-'));
    savePersistedBackgroundTask({
      taskId: 'bg-list-sdk',
      kind: 'bash',
      sessionId: 'session-list',
      command: 'bun test',
      cwd,
      summary: 'Run test suite',
      status: 'running',
      startTime: Date.now(),
      outputFile: join(cwd, 'bg-list-sdk.log'),
    });

    const q = query('test', { cwd, model: 'claude-sonnet-4-6' });
    const tasks = await q.listBackgroundTasks();
    expect(tasks.some((task) => task.task_id === 'bg-list-sdk' && task.type === 'bash')).toBe(true);
    q.close();
  });

  it('returns structured background task details for persisted bash tasks', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'open-agent-task-details-'));
    const outputFile = join(cwd, 'bg-detail-sdk.log');
    writeFileSync(outputFile, 'ok\n');
    const startTime = Date.now() - 5_000;
    savePersistedBackgroundTask({
      taskId: 'bg-detail-sdk',
      kind: 'bash',
      sessionId: 'session-detail',
      command: 'echo ok',
      cwd,
      summary: 'Echo ok',
      status: 'completed',
      startTime,
      outputFile,
    });

    const q = query('test', { cwd, model: 'claude-sonnet-4-6' });
    const task = await q.getBackgroundTask('bg-detail-sdk');
    expect(task).not.toBeNull();
    expect(task?.task_id).toBe('bg-detail-sdk');
    expect(task?.type).toBe('bash');
    expect(task?.summary).toBe('Echo ok');
    expect(task?.session_id).toBe('session-detail');
    expect(task?.command).toBe('echo ok');
    expect(task?.output_file).toBe(outputFile);
    expect(task?.output_preview).toContain('ok');
    expect(task?.started_at).toBe(startTime);
    expect(typeof task?.duration_ms).toBe('number');
    q.close();
  });
});

describe('query().interrupt()', () => {
  it('aborts caller-provided AbortController', async () => {
    const ac = new AbortController();
    const q = query('test', { model: 'claude-sonnet-4-6', abortController: ac });
    expect(ac.signal.aborted).toBe(false);
    await q.interrupt();
    expect(ac.signal.aborted).toBe(true);
    q.close();
  });

  it('is idempotent when called multiple times', async () => {
    const ac = new AbortController();
    const q = query('test', { model: 'claude-sonnet-4-6', abortController: ac });
    await q.interrupt();
    await q.interrupt();
    expect(ac.signal.aborted).toBe(true);
    q.close();
  });
});

describe('query().setPermissionMode()', () => {
  it('rejects bypassPermissions at runtime without allowDangerouslySkipPermissions', async () => {
    const q = query('test', { model: 'claude-sonnet-4-6' });
    await expect(q.setPermissionMode('bypassPermissions')).rejects.toThrow(
      /allowDangerouslySkipPermissions/i,
    );
    q.close();
  });

  it('allows bypassPermissions at runtime when allowDangerouslySkipPermissions=true', async () => {
    const q = query('test', {
      model: 'claude-sonnet-4-6',
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
    });
    await expect(q.setPermissionMode('bypassPermissions')).resolves.toBeUndefined();
    q.close();
  });
});

describe('query() runtime setter validation', () => {
  it('setModel rejects empty string', async () => {
    const q = query('test', { model: 'claude-sonnet-4-6' });
    await expect(q.setModel('')).rejects.toThrow(/non-empty model string/i);
    await expect(q.setModel('   ' as any)).rejects.toThrow(/non-empty model string/i);
    q.close();
  });

  it('setMaxThinkingTokens rejects non-positive values', async () => {
    const q = query('test', { model: 'claude-sonnet-4-6' });
    await expect(q.setMaxThinkingTokens(0)).rejects.toThrow(/positive finite number/i);
    await expect(q.setMaxThinkingTokens(-1)).rejects.toThrow(/positive finite number/i);
    q.close();
  });
});

// ---------------------------------------------------------------------------
// close() abort behavior with caller-provided AbortController
// ---------------------------------------------------------------------------

describe('query().close()', () => {
  it('does not abort caller-provided AbortController', () => {
    const ac = new AbortController();
    const q = query('test', { model: 'claude-sonnet-4-6', abortController: ac });
    expect(ac.signal.aborted).toBe(false);
    q.close();
    expect(ac.signal.aborted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// reconnectMcpServer() / toggleMcpServer() — no MCP configured
// ---------------------------------------------------------------------------

describe('query() MCP methods without mcpServers', () => {
  it('mcpServerStatus() returns empty array when no MCP manager', async () => {
    const q = query('test', { model: 'claude-sonnet-4-6' });
    const status = await q.mcpServerStatus();
    expect(status).toEqual([]);
    q.close();
  });

  it('reconnectMcpServer() throws when no MCP manager', async () => {
    const q = query('test', { model: 'claude-sonnet-4-6' });
    await expect(q.reconnectMcpServer('foo')).rejects.toThrow(/MCP/i);
    q.close();
  });

  it('toggleMcpServer() throws when no MCP manager', async () => {
    const q = query('test', { model: 'claude-sonnet-4-6' });
    await expect(q.toggleMcpServer('foo', false)).rejects.toThrow(/MCP/i);
    q.close();
  });

  it('setMcpServers({}) creates manager on the fly and returns empty result', async () => {
    const q = query('test', { model: 'claude-sonnet-4-6' });
    const result = await q.setMcpServers({});
    expect(result).toHaveProperty('added');
    expect(result).toHaveProperty('removed');
    expect(result).toHaveProperty('errors');
    expect(Array.isArray(result.added)).toBe(true);
    expect(Array.isArray(result.removed)).toBe(true);
    q.close();
  });
});

describe('query() MCP status shape', () => {
  it('initializationResult waits for MCP tools and mcpServerStatus returns official-like shape', async () => {
    const server = createSdkMcpServer({
      name: 'sdk-test',
      tools: [
        tool(
          'echo_status',
          'Echoes input status',
          { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
          async ({ text }: { text: string }) => text,
        ) as any,
      ],
    });

    const q = query('test', {
      model: 'claude-sonnet-4-6',
      mcpServers: {
        sdk_test: server as any,
      },
    });

    const init = await q.initializationResult();
    expect(Array.isArray(init.commands)).toBe(true);

    const status = await q.mcpServerStatus();
    expect(status.length).toBe(1);
    expect(status[0].name).toBe('sdk_test');
    expect(status[0].status).toBe('connected');
    expect(status[0]).toHaveProperty('config');
    expect((status[0] as any).config?.type).toBe('sdk');
    expect(Array.isArray(status[0].tools)).toBe(true);
    expect(status[0].tools?.[0]?.name).toBe('echo_status');

    await q.toggleMcpServer('sdk_test', false);
    const disabled = await q.mcpServerStatus();
    expect(disabled[0].status).toBe('disabled');
    q.close();
  });

  it('normalizes stdio config without explicit type in mcpServerStatus', async () => {
    const q = query('test', {
      model: 'claude-sonnet-4-6',
      mcpServers: {
        bad_stdio: {
          command: '__definitely_missing_mcp_binary__',
          args: ['--version'],
        } as any,
      },
    });

    await q.initializationResult();
    const status = await q.mcpServerStatus();
    expect(status).toHaveLength(1);
    expect((status[0] as any).config?.type).toBe('stdio');
    expect((status[0] as any).config?.command).toBe('__definitely_missing_mcp_binary__');
    q.close();
  });

  it('returns defensive copies from mcpServerStatus()', async () => {
    const server = createSdkMcpServer({
      name: 'copy-test',
      tools: [
        tool(
          'echo_copy',
          'Echo copy test',
          { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
          async ({ text }: { text: string }) => text,
        ) as any,
      ],
    });

    const q = query('test', {
      model: 'claude-sonnet-4-6',
      mcpServers: {
        copy_test: server as any,
      },
    });

    await q.initializationResult();
    const first = await q.mcpServerStatus();
    (first[0] as any).config.name = 'mutated';
    if (first[0].tools?.[0]) {
      (first[0].tools?.[0] as any).name = 'mutated_tool';
    }
    const second = await q.mcpServerStatus();
    expect((second[0] as any).config?.name).toBe('copy-test');
    expect(second[0].tools?.[0]?.name).toBe('echo_copy');
    q.close();
  });

  it('setMcpServers() hot-reloads a server when same name config changes', async () => {
    const serverV1 = createSdkMcpServer({
      name: 'hot-reload-test',
      tools: [
        tool(
          'echo_v1',
          'Echo v1',
          { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
          async ({ text }: { text: string }) => text,
        ) as any,
      ],
    });

    const serverV2 = createSdkMcpServer({
      name: 'hot-reload-test',
      tools: [
        tool(
          'echo_v2',
          'Echo v2',
          { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
          async ({ text }: { text: string }) => text,
        ) as any,
      ],
    });

    const q = query('test', {
      model: 'claude-sonnet-4-6',
      mcpServers: {
        sdk_test: serverV1 as any,
      },
    });

    await q.initializationResult();
    const before = await q.mcpServerStatus();
    expect(before[0].tools?.map(t => t.name)).toContain('echo_v1');
    expect(before[0].tools?.map(t => t.name)).not.toContain('echo_v2');

    const updateResult = await q.setMcpServers({
      sdk_test: serverV2 as any,
    });
    expect(updateResult.removed).toContain('sdk_test');
    expect(updateResult.added).toContain('sdk_test');

    const after = await q.mcpServerStatus();
    expect(after[0].tools?.map(t => t.name)).toContain('echo_v2');
    expect(after[0].tools?.map(t => t.name)).not.toContain('echo_v1');
    q.close();
  });

  it('reconnectMcpServer throws when reconnect result is not connected', async () => {
    const q = query('test', {
      model: 'claude-sonnet-4-6',
      mcpServers: {
        bad_stdio: {
          command: '__definitely_missing_mcp_binary__',
        } as any,
      },
    });

    await q.initializationResult();
    await expect(q.reconnectMcpServer('bad_stdio')).rejects.toThrow(/failed to reconnect/i);
    q.close();
  });

  it('toggleMcpServer throws when enabling back fails', async () => {
    const q = query('test', {
      model: 'claude-sonnet-4-6',
      mcpServers: {
        bad_stdio: {
          command: '__definitely_missing_mcp_binary__',
        } as any,
      },
    });

    await q.initializationResult();
    await q.toggleMcpServer('bad_stdio', false);
    await expect(q.toggleMcpServer('bad_stdio', true)).rejects.toThrow(/failed to enable/i);
    q.close();
  });
});

// ---------------------------------------------------------------------------
// rewindFiles()
// ---------------------------------------------------------------------------

describe('query().rewindFiles()', () => {
  it('returns false when file checkpointing is not enabled', async () => {
    const q = query('test', { model: 'claude-sonnet-4-6' });
    const result = await q.rewindFiles('some-tool-use-id');
    expect(result.canRewind).toBe(false);
    expect(result.error).toMatch(/not enabled/i);
    expect(result.filesChanged).toBeUndefined();
    q.close();
  });

  it('returns checkpoint-not-found when checkpointing is enabled but id is missing', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'open-agent-rewind-missing-'));
    const q = query('test', {
      model: 'claude-sonnet-4-6',
      cwd,
      sessionId: '11111111-1111-4111-8111-111111111121',
      enableFileCheckpointing: true,
    });
    const result = await q.rewindFiles('missing-tool-use-id');
    expect(result.canRewind).toBe(false);
    expect(result.error).toMatch(/checkpoint not found/i);
    q.close();
  });

  it('supports dryRun and actual rewind when checkpoints exist on disk', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'open-agent-rewind-dryrun-'));
    const sessionId = '11111111-1111-4111-8111-111111111122';
    const targetFile = join(cwd, 'demo.txt');
    writeFileSync(targetFile, 'after', 'utf-8');

    const sm = new SessionManager();
    const sessionDir = sm.getSessionDir(cwd, sessionId);
    const checkpointDir = join(sessionDir, 'checkpoints');
    mkdirSync(checkpointDir, { recursive: true });
    writeFileSync(
      join(checkpointDir, 'checkpoint-1.json'),
      JSON.stringify({
        toolUseId: 'tool-use-1',
        filePath: targetFile,
        originalContent: 'before',
        timestamp: Date.now(),
      }),
      'utf-8',
    );

    const q = query('test', {
      model: 'claude-sonnet-4-6',
      cwd,
      sessionId,
      enableFileCheckpointing: true,
    });

    const preview = await q.rewindFiles('tool-use-1', { dryRun: true });
    expect(preview.canRewind).toBe(true);
    expect(preview.filesChanged).toEqual([targetFile]);
    expect(preview.insertions).toBe(1);
    expect(preview.deletions).toBe(1);

    const applied = await q.rewindFiles('tool-use-1');
    expect(applied.canRewind).toBe(true);
    expect(applied.filesChanged).toEqual([targetFile]);
    expect(applied.insertions).toBe(1);
    expect(applied.deletions).toBe(1);
    expect(readFileSync(targetFile, 'utf-8')).toBe('before');
    q.close();
  });

  it('computes deletion stats when rewinding to a non-existent original file', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'open-agent-rewind-delete-'));
    const sessionId = '11111111-1111-4111-8111-111111111123';
    const targetFile = join(cwd, 'remove-me.txt');
    writeFileSync(targetFile, 'line1\nline2', 'utf-8');

    const sm = new SessionManager();
    const sessionDir = sm.getSessionDir(cwd, sessionId);
    const checkpointDir = join(sessionDir, 'checkpoints');
    mkdirSync(checkpointDir, { recursive: true });
    writeFileSync(
      join(checkpointDir, 'checkpoint-delete.json'),
      JSON.stringify({
        toolUseId: 'tool-use-delete',
        filePath: targetFile,
        originalContent: null,
        timestamp: Date.now(),
      }),
      'utf-8',
    );

    const q = query('test', {
      model: 'claude-sonnet-4-6',
      cwd,
      sessionId,
      enableFileCheckpointing: true,
    });

    const preview = await q.rewindFiles('tool-use-delete', { dryRun: true });
    expect(preview.insertions).toBe(0);
    expect(preview.deletions).toBe(2);

    const applied = await q.rewindFiles('tool-use-delete');
    expect(applied.insertions).toBe(0);
    expect(applied.deletions).toBe(2);
    expect(() => readFileSync(targetFile, 'utf-8')).toThrow();
    q.close();
  });

  it('accepts userMessageId by resolving to underlying toolUseId from transcript', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'open-agent-rewind-user-msg-'));
    const sessionId = '11111111-1111-4111-8111-111111111124';
    const targetFile = join(cwd, 'map-id.txt');
    writeFileSync(targetFile, 'after-map', 'utf-8');

    const sm = new SessionManager();
    const sessionDir = sm.getSessionDir(cwd, sessionId);
    const checkpointDir = join(sessionDir, 'checkpoints');
    mkdirSync(checkpointDir, { recursive: true });
    writeFileSync(
      join(checkpointDir, 'checkpoint-map.json'),
      JSON.stringify({
        toolUseId: 'tool-use-map',
        filePath: targetFile,
        originalContent: 'before-map',
        timestamp: Date.now(),
      }),
      'utf-8',
    );

    const q = query('test', {
      model: 'claude-sonnet-4-6',
      cwd,
      sessionId,
      enableFileCheckpointing: true,
    });

    sm.appendToTranscript(cwd, sessionId, {
      type: 'user',
      uuid: 'user-msg-1',
      session_id: sessionId,
      message: 'rewrite this file',
    });
    sm.appendToTranscript(cwd, sessionId, {
      type: 'tool_result',
      tool_use_id: 'tool-use-map',
      session_id: sessionId,
      result: 'done',
      is_error: false,
    });

    const preview = await q.rewindFiles('user-msg-1', { dryRun: true });
    expect(preview.canRewind).toBe(true);
    expect(preview.filesChanged).toEqual([targetFile]);
    q.close();
  });

  it('stops resolving when a newer user message is encountered', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'open-agent-rewind-user-boundary-'));
    const sessionId = '11111111-1111-4111-8111-111111111125';
    const targetFile = join(cwd, 'boundary.txt');
    writeFileSync(targetFile, 'after-boundary', 'utf-8');

    const sm = new SessionManager();
    const sessionDir = sm.getSessionDir(cwd, sessionId);
    const checkpointDir = join(sessionDir, 'checkpoints');
    mkdirSync(checkpointDir, { recursive: true });
    writeFileSync(
      join(checkpointDir, 'checkpoint-boundary.json'),
      JSON.stringify({
        toolUseId: 'tool-use-boundary',
        filePath: targetFile,
        originalContent: 'before-boundary',
        timestamp: Date.now(),
      }),
      'utf-8',
    );

    const q = query('test', {
      model: 'claude-sonnet-4-6',
      cwd,
      sessionId,
      enableFileCheckpointing: true,
    });

    sm.appendToTranscript(cwd, sessionId, {
      type: 'user',
      uuid: 'user-msg-old',
      session_id: sessionId,
      message: 'old user message',
    });
    sm.appendToTranscript(cwd, sessionId, {
      type: 'user',
      uuid: 'user-msg-new',
      session_id: sessionId,
      message: 'newer user message',
    });
    sm.appendToTranscript(cwd, sessionId, {
      type: 'tool_result',
      tool_use_id: 'tool-use-boundary',
      session_id: sessionId,
      result: 'done',
      is_error: false,
    });

    const preview = await q.rewindFiles('user-msg-old', { dryRun: true });
    expect(preview.canRewind).toBe(false);
    expect(preview.error).toMatch(/checkpoint not found/i);
    q.close();
  });
});

// ---------------------------------------------------------------------------
// streamInput()
// ---------------------------------------------------------------------------

describe('query().streamInput()', () => {
  it('throws on non-stream prompt mode', async () => {
    const q = query('test', { model: 'claude-sonnet-4-6' });
    await expect(q.streamInput('additional message')).rejects.toThrow(/async-iterable/i);
    q.close();
  });

  it('accepts an async iterable input stream', async () => {
    const initialPrompt = (async function* () {
      // keep empty so the query stays in async-iterable mode without running a provider call
    })();
    const q = query({ prompt: initialPrompt, options: { model: 'claude-sonnet-4-6' } });
    const stream = (async function* () {
      yield {
        type: 'user',
        message: 'hello',
        parent_tool_use_id: null,
        session_id: 's',
        uuid: 'u',
      } as any;
    })();
    await q.streamInput(stream);
    q.close();
  });

  it('throws after close() because stream is no longer writable', async () => {
    const initialPrompt = (async function* () {})();
    const q = query({ prompt: initialPrompt, options: { model: 'claude-sonnet-4-6' } });
    q.close();
    await expect(q.streamInput('after-close')).rejects.toThrow(/closed or interrupted/i);
  });

  it('throws after interrupt() because stream is no longer writable', async () => {
    const initialPrompt = (async function* () {})();
    const q = query({ prompt: initialPrompt, options: { model: 'claude-sonnet-4-6' } });
    await q.interrupt();
    await expect(q.streamInput('after-interrupt')).rejects.toThrow(/closed or interrupted/i);
  });

  it('emits error result when async prompt source throws', async () => {
    const source = (async function* () {
      throw new Error('source pump failed');
      yield {
        type: 'user',
        message: 'unreachable',
        parent_tool_use_id: null,
        session_id: 's',
        uuid: 'u',
      } as any;
    })();
    const q = query({ prompt: source, options: { model: 'claude-sonnet-4-6' } });

    const messages: any[] = [];
    for await (const m of q) {
      messages.push(m);
    }
    const result = messages.find((m) => m.type === 'result');
    expect(result).toBeDefined();
    expect(result.subtype).toBe('error_during_execution');
    expect(result.is_error).toBe(true);
    expect(Array.isArray(result.errors)).toBe(true);
    expect(String(result.errors[0] || '')).toContain('source pump failed');
  });
});

// ---------------------------------------------------------------------------
// canUseTool option
// ---------------------------------------------------------------------------

describe('query() with canUseTool option', () => {
  it('accepts a canUseTool callback without error', () => {
    const q = query('test', {
      model: 'claude-sonnet-4-6',
      canUseTool: (_tool, _input) => true,
    });
    expect(q).toBeDefined();
    q.close();
  });

  it('accepts a canUseTool callback that returns false', () => {
    const q = query('test', {
      model: 'claude-sonnet-4-6',
      canUseTool: () => false,
    });
    expect(q).toBeDefined();
    q.close();
  });
});

// ---------------------------------------------------------------------------
// permissionPromptToolName option
// ---------------------------------------------------------------------------

describe('query() with permissionPromptToolName option', () => {
  it('accepts the option without error', () => {
    const q = query('test', {
      model: 'claude-sonnet-4-6',
      permissionPromptToolName: 'mcp__my-server__permission_prompt',
    });
    expect(q).toBeDefined();
    q.close();
  });
});

// ---------------------------------------------------------------------------
// settingSources option
// ---------------------------------------------------------------------------

describe('query() with settingSources option', () => {
  it('accepts an empty array without error', () => {
    const q = query('test', {
      model: 'claude-sonnet-4-6',
      settingSources: [],
    });
    expect(q).toBeDefined();
    q.close();
  });

  it('accepts user-only sources', () => {
    const q = query('test', {
      model: 'claude-sonnet-4-6',
      settingSources: ['user'],
    });
    expect(q).toBeDefined();
    q.close();
  });

  it('accepts all sources', () => {
    const q = query('test', {
      model: 'claude-sonnet-4-6',
      settingSources: ['user', 'project', 'local'],
    });
    expect(q).toBeDefined();
    q.close();
  });
});
