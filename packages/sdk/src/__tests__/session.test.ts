import { describe, it, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import type { ModelInfo } from '@open-agent/core';
import { tmpdir } from 'os';
import { join } from 'path';
import type { LLMProvider, Message, StreamEvent, ChatOptions } from '@open-agent/providers';
import {
  createSession,
  resumeSession,
  forkSession,
  unstable_v2_createSession,
  unstable_v2_resumeSession,
  __internal_appendSdkMessageToHistory,
  __internal_buildSessionTurnQueryOptions,
  __internal_loadInitialMessages,
} from '../session.js';

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

function makeMockProvider(responses: StreamEvent[][]): LLMProvider {
  let callIndex = 0;

  return {
    name: 'mock-session-provider',
    async *chat(_messages: Message[], _options: ChatOptions): AsyncGenerator<StreamEvent> {
      const events = responses[Math.min(callIndex, responses.length - 1)] ?? [];
      callIndex += 1;
      for (const event of events) {
        yield event;
      }
    },
    async listModels(): Promise<ModelInfo[]> {
      return [{ value: 'mock-model', displayName: 'Mock Model', description: 'Session test model' }];
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

function makeBackgroundControlProvider(): LLMProvider {
  return {
    name: 'mock-session-background-provider',
    async *chat(_messages: Message[], options: ChatOptions): AsyncGenerator<StreamEvent> {
      await new Promise<void>((resolve) => {
        if (options.signal?.aborted) {
          resolve();
          return;
        }
        options.signal?.addEventListener('abort', () => resolve(), { once: true });
      });

      throw new Error('background session worker aborted for test');
    },
    async listModels(): Promise<ModelInfo[]> {
      return [{ value: 'mock-model', displayName: 'Mock Model', description: 'Background session test model' }];
    },
  };
}

async function waitForWorkerStatus(
  getWorker: (workerId: string) => Promise<{ status?: string } | null>,
  workerId: string,
  expectedStatus: string,
): Promise<void> {
  const timeoutAt = Date.now() + 2_000;
  while (Date.now() < timeoutAt) {
    const worker = await getWorker(workerId);
    if (worker?.status === expectedStatus) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function waitForDispatcher(
  getDispatcher: (dispatcherId: string) => Promise<{ status?: string; activeAssignments?: unknown[] } | null>,
  dispatcherId: string,
  predicate: (dispatcher: { status?: string; activeAssignments?: unknown[] }) => boolean,
): Promise<{ status?: string; activeAssignments?: unknown[] }> {
  const timeoutAt = Date.now() + 2_000;
  while (Date.now() < timeoutAt) {
    const dispatcher = await getDispatcher(dispatcherId);
    if (dispatcher && predicate(dispatcher)) {
      return dispatcher;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for dispatcher ${dispatcherId}`);
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

describe('createSession()', () => {
  it('returns a session with required interface methods', () => {
    const session = createSession({ model: 'claude-sonnet-4-6' });
    expect(session).toBeDefined();
    expect(typeof session.sessionId).toBe('string');
    expect(session.sessionId.length).toBeGreaterThan(0);
    expect(typeof session.send).toBe('function');
    expect(typeof session.interrupt).toBe('function');
    expect(typeof session.setPermissionMode).toBe('function');
    expect(typeof session.setModel).toBe('function');
    expect(typeof session.setMaxThinkingTokens).toBe('function');
    expect(typeof session.supportedCommands).toBe('function');
    expect(typeof session.supportedModels).toBe('function');
    expect(typeof session.supportedAgents).toBe('function');
    expect(typeof session.supportedSkills).toBe('function');
    expect(typeof session.readRuntimeControlPlane).toBe('function');
    expect(typeof session.listRuntimeDiagnostics).toBe('function');
    expect(typeof session.readOrchestrationControlPlane).toBe('function');
    expect(typeof session.mcpServerStatus).toBe('function');
    expect(typeof session.accountInfo).toBe('function');
    expect(typeof session.initializationResult).toBe('function');
    expect(typeof session.sessionInfo).toBe('function');
    expect(typeof session.acknowledgeTeamInbox).toBe('function');
    expect(typeof session.listPendingTeamApprovals).toBe('function');
    expect(typeof session.respondToTeamApproval).toBe('function');
    expect(typeof session.listBackgroundTasks).toBe('function');
    expect(typeof session.getBackgroundTask).toBe('function');
    expect(typeof session.dispatchNextTask).toBe('function');
    expect(typeof session.startTaskDispatcher).toBe('function');
    expect(typeof session.resumeTaskDispatcher).toBe('function');
    expect(typeof session.getTaskDispatcher).toBe('function');
    expect(typeof session.listTaskDispatchers).toBe('function');
    expect(typeof session.inspectTaskDispatcherHealth).toBe('function');
    expect(typeof session.getTaskDispatcherDiagnosis).toBe('function');
    expect(typeof session.listTaskDispatcherDiagnoses).toBe('function');
    expect(typeof session.requeueTaskDispatcherAssignment).toBe('function');
    expect(typeof session.stopTaskDispatcher).toBe('function');
    expect(typeof session.stopTask).toBe('function');
    expect(typeof session.streamInput).toBe('function');
    expect(typeof session.reconnectMcpServer).toBe('function');
    expect(typeof session.toggleMcpServer).toBe('function');
    expect(typeof session.setMcpServers).toBe('function');
    expect(typeof session.rewindFiles).toBe('function');
    expect(typeof session.close).toBe('function');
    expect(typeof session[Symbol.asyncDispose]).toBe('function');
    session.close();
  });

  it('each session gets a unique ID', () => {
    const s1 = createSession({ model: 'claude-sonnet-4-6' });
    const s2 = createSession({ model: 'claude-sonnet-4-6' });
    expect(s1.sessionId).not.toBe(s2.sessionId);
    s1.close();
    s2.close();
  });

  it('send() throws after close()', async () => {
    const session = createSession({ model: 'claude-sonnet-4-6' });
    session.close();

    let threw = false;
    try {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _msg of session.send('hello')) {
        // should not reach
      }
    } catch (e) {
      threw = true;
      expect((e as Error).message).toContain('closed');
    }
    expect(threw).toBe(true);
  });

  it('asyncDispose closes the session', async () => {
    const session = createSession({ model: 'claude-sonnet-4-6' });
    await session[Symbol.asyncDispose]();

    let threw = false;
    try {
      for await (const _msg of session.send('hello')) {
        // should not reach
      }
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it('forwards team and task control plane methods through the stable session handle', async () => {
    const session = createSession({
      model: 'mock-model',
      provider: makeMockProvider([textResponse('unused')]),
    } as any);

    const teamName = `alpha-team-${Date.now()}`;
    const createdTeam = await session.createTeam({ name: teamName });
    expect(createdTeam.name).toBe(teamName);
    expect((await session.getActiveTeam())?.name).toBe(teamName);

    const createdTask = await session.createTask({
      subject: 'Session-scoped task',
      description: 'Should inherit the active team from the session control plane.',
    });
    expect(createdTask.teamName).toBe(teamName);

    await session.sendTeamMessage({
      type: 'message',
      recipient: 'alice',
      content: 'Continue the session-scoped task.',
    });
    const timelineInbox = await session.readTimelineInbox({ memberName: 'alice', consume: false });
    expect(timelineInbox).toHaveLength(1);
    expect(timelineInbox[0]?.kind).toBe('team_message');
    expect(timelineInbox[0]?.timelineId).toBeTruthy();
    expect(timelineInbox[0]?.teamMessage?.teamName).toBe(teamName);
    expect(timelineInbox[0]?.teamMessage?.messageId).toBeTruthy();

    expect(await session.getTeamInboxCount('alice')).toBe(1);
    expect(
      await session.acknowledgeTeamInbox({
        memberName: 'alice',
        messageIds: [timelineInbox[0]!.teamMessage!.messageId!],
      }),
    ).toEqual({ acknowledged: 1 });
    expect(await session.getTeamInboxCount('alice')).toBe(0);

    const unreadOnly = await session.readTeamInbox({ memberName: 'alice', consume: false, unreadOnly: true });
    expect(unreadOnly).toHaveLength(0);

    const inbox = await session.readTeamInbox({ memberName: 'alice', consume: true });
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.teamName).toBe(teamName);
    session.close();
  });

  it('forwards team approval control methods through the stable session handle', async () => {
    const session = createSession({
      model: 'mock-model',
      provider: makeMockProvider([textResponse('unused')]),
    } as any);

    const teamName = `approval-team-${Date.now()}`;
    await session.createTeam({ name: teamName });

    const request = await session.sendTeamMessage({
      teamName,
      type: 'plan_approval_request',
      from: 'worker-1',
      recipient: 'lead',
      content: 'Approve the plan.',
      summary: 'approval needed',
    });

    const pending = await session.listPendingTeamApprovals({
      teamName,
      memberName: 'lead',
      unreadOnly: true,
    });
    expect(pending).toHaveLength(1);
    expect(pending[0]?.requestId).toBe(request.requestId);

    const response = await session.respondToTeamApproval({
      teamName,
      memberName: 'lead',
      messageId: pending[0]!.messageId,
      approve: true,
      feedback: 'Ship it.',
    });
    expect(response.acknowledged).toBe(1);
    expect(response.response.type).toBe('plan_approval_response');
    expect(response.response.to).toBe('worker-1');

    const workerInbox = await session.readTeamInbox({ teamName, memberName: 'worker-1', consume: true });
    expect(workerInbox).toHaveLength(1);
    expect(workerInbox[0]?.type).toBe('plan_approval_response');
    expect(workerInbox[0]?.approve).toBe(true);
    session.close();
  });

  it('forwards host introspection control methods through the stable session handle', async () => {
    const session = createSession({
      model: 'mock-model',
      apiKey: 'sk-test-key',
      provider: makeMockProvider([textResponse('unused')]),
      sessionTitle: 'SDK Session Host Control',
      permissionMode: 'acceptEdits',
    } as any);

    const commands = await session.supportedCommands();
    expect(commands.some((command) => command.name === '/help')).toBe(true);

    const models = await session.supportedModels();
    expect(models.some((model) => model.value === 'mock-model')).toBe(true);

    const init = await session.initializationResult();
    expect(Array.isArray(init.commands)).toBe(true);
    expect(init).toHaveProperty('capability_snapshot');

    const info = await session.sessionInfo();
    expect(info === null || info.id === session.sessionId).toBe(true);
    if (info) {
      expect(info.title).toBe('SDK Session Host Control');
      expect(info.permissionMode).toBe('acceptEdits');
    }

    const account = await session.accountInfo();
    expect(account.apiKeySource).toBe('direct');

    expect(Array.isArray(await session.supportedAgents())).toBe(true);
    expect(Array.isArray(await session.supportedSkills())).toBe(true);
    const runtimeControlPlane = await session.readRuntimeControlPlane();
    expect(runtimeControlPlane.sessionId).toBe(session.sessionId);
    expect(runtimeControlPlane.permissionMode).toBe('acceptEdits');
    expect(Array.isArray(runtimeControlPlane.runtime.agentNames)).toBe(true);
    expect(Array.isArray(await session.listRuntimeDiagnostics())).toBe(true);
    const orchestrationControlPlane = await session.readOrchestrationControlPlane();
    expect(orchestrationControlPlane.sessionId).toBe(session.sessionId);
    expect(Array.isArray(orchestrationControlPlane.tasks)).toBe(true);
    expect(Array.isArray(orchestrationControlPlane.workers)).toBe(true);
    expect(Array.isArray(orchestrationControlPlane.dispatchers)).toBe(true);
    expect(Array.isArray(await session.mcpServerStatus())).toBe(true);
    expect(Array.isArray(await session.listBackgroundTasks())).toBe(true);

    await session.setModel('mock-model');
    await session.setMaxThinkingTokens(2048);
    await session.setPermissionMode('acceptEdits');
    await session.streamInput('Queued input from the stable session control plane.');
    await session.interrupt();
    session.close();
  });

  it('streams live orchestration events and worker follow-ups from the stable session handle', async () => {
    const teamName = `alpha-team-${Date.now()}`;
    const session = createSession({
      model: 'mock-model',
      provider: makeMockProvider([
        toolUseResponse('task-parent-session', 'Task', {
          description: 'Delegate worker',
          prompt: 'Use DummyTool once, then report completion.',
          subagent_type: 'worker',
          name: 'worker',
          team_name: teamName,
        }),
        toolUseResponse('worker-tool-1', 'DummyTool', { value: 'from-session-worker' }),
        textResponse('worker finished successfully'),
        textResponse('session parent done'),
      ]),
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      setupTools(registry) {
        registry.register({
          name: 'DummyTool',
          description: 'Return a stable string for session orchestration tests.',
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
    } as any);

    const eventIterator = session.subscribeOrchestrationEvents({ teamName })[Symbol.asyncIterator]();
    const turnMessages: any[] = [];
    for await (const message of session.send('delegate from stable session')) {
      turnMessages.push(message);
    }

    const events = [
      (await eventIterator.next()).value,
      (await eventIterator.next()).value,
      (await eventIterator.next()).value,
      (await eventIterator.next()).value,
    ].filter(Boolean);
    await eventIterator.return?.();

    expect(events.some((event) => event.kind === 'worker_lifecycle' && event.raw.type === 'launched')).toBe(true);
    expect(events.some((event) => event.kind === 'worker_tool' && event.raw.toolName === 'DummyTool')).toBe(true);
    expect(events.some((event) => event.kind === 'worker_lifecycle' && event.raw.type === 'completed')).toBe(true);

    const workers = await session.listWorkers({ teamName });
    expect(workers).toHaveLength(1);
    const followUps = await session.getWorkerFollowUps(workers[0]!.workerId);
    expect(followUps.some((item) => item.scaffold.kind === 'resume_worker')).toBe(true);
    expect(followUps.some((item) => item.scaffold.kind === 'launch_verifier')).toBe(true);
    const resumeFollowUp = followUps.find((item) => item.scaffold.kind === 'resume_worker')!;
    const resumed = await session.executeFollowUp(resumeFollowUp);
    const expectedTool = resumeFollowUp.scaffold.action?.tool;
    if (expectedTool === 'SendMessage') {
      expect(resumed.kind).toBe('team_message');
      if (resumed.kind === 'team_message') {
        expect(resumed.followUpKind).toBe(resumeFollowUp.scaffold.kind);
        expect(resumed.teamMessage?.teamName).toBe(teamName);
        expect(resumed.teamMessage?.to).toBe('alice');
      }
      const inboxAfterFollowUp = await session.readTeamInbox({ teamName, memberName: 'alice', consume: true });
      expect(inboxAfterFollowUp.some((message) => message.content.includes('worker finished successfully'))).toBe(true);
    } else {
      expect(resumed.kind).toBe('worker');
      if (resumed.kind === 'worker') {
        expect(resumed.worker.workerId).toBe(workers[0]!.workerId);
        expect(await session.stopWorker(resumed.worker.workerId)).toEqual({ success: true });
      }
    }
    expect(turnMessages.some((message) => message.type === 'result' && message.result === 'session parent done')).toBe(true);
    session.close();
  });

  it('forwards direct worker actuation through the stable session handle', async () => {
    const teamName = `alpha-team-${Date.now()}`;
    const session = createSession({
      model: 'mock-model',
      provider: makeBackgroundControlProvider(),
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
    } as any);

    await session.createTeam({ name: teamName, setActive: true });
    const eventIterator = session.subscribeOrchestrationEvents({ teamName })[Symbol.asyncIterator]();

    const worker = await session.launchWorker({
      prompt: 'Wait until stopped.',
      name: 'alice',
    });
    expect(worker.workerType).toBe('worker');
    expect(worker.teamName).toBe(teamName);

    const launchedEvent = await readEventOfType(eventIterator, 'launched');
    expect(launchedEvent?.kind).toBe('worker_lifecycle');
    expect(launchedEvent?.raw.type).toBe('launched');
    expect(launchedEvent?.workerId).toBe(worker.workerId);

    expect(await session.stopWorker(worker.workerId)).toEqual({ success: true });
    await waitForWorkerStatus((workerId) => session.getWorker(workerId), worker.workerId, 'shutdown');
    const shutdownEvent = await readEventOfType(eventIterator, 'shutdown');
    expect(shutdownEvent?.workerId).toBe(worker.workerId);

    const resumed = await session.resumeWorker(worker.workerId, {
      prompt: 'Continue after stop.',
      teamName,
    });
    expect(resumed.workerId).toBe(worker.workerId);

    const resumedEvent = await readEventOfType(eventIterator, 'launched');
    expect(resumedEvent?.raw.type).toBe('launched');
    expect(resumedEvent?.workerId).toBe(worker.workerId);

    expect(await session.stopWorker(resumed.workerId)).toEqual({ success: true });
    await waitForWorkerStatus((workerId) => session.getWorker(workerId), resumed.workerId, 'shutdown');
    await eventIterator.return?.();
    session.close();
  });

  it('forwards dispatcher inspection and requeue control through the stable session handle', async () => {
    const teamName = `alpha-team-${Date.now()}`;
    const session = createSession({
      model: 'mock-model',
      provider: makeBackgroundControlProvider(),
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
    } as any);

    await session.createTeam({ name: teamName, setActive: true });
    const task = await session.createTask({
      teamName,
      subject: 'Session dispatcher requeue',
      description: 'Force one dispatcher assignment back to pending.',
      priority: 1,
    });

    const dispatcher = await session.startTaskDispatcher({
      dispatcherId: `dispatcher-${Date.now()}`,
      owner: 'dispatcher-owner',
      teamName,
      pollIntervalMs: 25,
      leaseMs: 500,
    });

    const activeDispatcher = await waitForDispatcher(
      (dispatcherId) => session.getTaskDispatcher(dispatcherId),
      dispatcher.dispatcherId,
      (item) => item.status === 'running' && Array.isArray(item.activeAssignments) && item.activeAssignments.length === 1,
    );
    const assignment = activeDispatcher.activeAssignments![0] as {
      taskId?: string;
      workerId?: string;
    };
    expect(assignment.taskId).toBe(task.id);
    expect(assignment.workerId).toBeTruthy();

    await expect(session.stopTaskDispatcher(dispatcher.dispatcherId)).resolves.toMatchObject({
      success: true,
      dispatcher: { status: 'draining' },
    });

    const requeued = await session.requeueTaskDispatcherAssignment({
      dispatcherId: dispatcher.dispatcherId,
      taskId: task.id,
    });
    expect(requeued.success).toBe(true);
    expect(requeued.workerStop?.success).toBe(true);
    expect(requeued.task?.status).toBe('pending');
    expect(requeued.dispatcher?.status).toBe('stopped');
    expect(requeued.dispatcher?.activeAssignments).toEqual([]);

    await expect(session.getTaskDispatcher(dispatcher.dispatcherId)).resolves.toMatchObject({
      dispatcherId: dispatcher.dispatcherId,
      status: 'stopped',
      activeAssignments: [],
    });
    await expect(session.getTask(task.id, { teamName })).resolves.toMatchObject({
      id: task.id,
      teamName,
      status: 'pending',
    });

    const health = await session.inspectTaskDispatcherHealth(dispatcher.dispatcherId);
    expect(health?.healthy).toBe(true);
    expect(health?.dispatcher.status).toBe('stopped');
    await expect(session.getTaskDispatcherDiagnosis(dispatcher.dispatcherId)).resolves.toMatchObject({
      dispatcherId: dispatcher.dispatcherId,
      healthy: true,
      dispatcher: { status: 'stopped' },
    });
    await expect(session.listTaskDispatcherDiagnoses({ teamName })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        dispatcherId: dispatcher.dispatcherId,
        healthy: true,
      }),
    ]));

    session.close();
  });

  it('restores dispatcher ledger through stable durable persistence', async () => {
    const temp = makeTempHome('open-agent-sdk-session-dispatcher-ledger-');
    const teamName = `alpha-team-${Date.now()}`;

    try {
      const session = createSession({
        cwd: temp.cwd,
        model: 'mock-model',
        provider: makeBackgroundControlProvider(),
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        persistSession: true,
      } as any);

      await session.createTeam({ name: teamName, setActive: true });
      await session.createTask({
        teamName,
        subject: 'Persist dispatcher ledger through session',
        description: 'Recover dispatcher state from the stable session transcript.',
        priority: 1,
      });

      const dispatcher = await session.startTaskDispatcher({
        dispatcherId: `dispatcher-${Date.now()}`,
        owner: 'dispatcher-owner',
        teamName,
        pollIntervalMs: 25,
        leaseMs: 500,
      });

      await waitForDispatcher(
        (dispatcherId) => session.getTaskDispatcher(dispatcherId),
        dispatcher.dispatcherId,
        (item) => item.status === 'running' && Array.isArray(item.activeAssignments) && item.activeAssignments.length === 1,
      );
      await expect(session.stopTaskDispatcher(dispatcher.dispatcherId)).resolves.toMatchObject({
        success: true,
        dispatcher: { status: 'draining' },
      });

      const resumed = resumeSession(session.sessionId, {
        cwd: temp.cwd,
        model: 'mock-model',
        provider: makeMockProvider([textResponse('unused')]),
        persistSession: true,
      } as any);

      await expect(resumed.getTaskDispatcher(dispatcher.dispatcherId)).resolves.toMatchObject({
        dispatcherId: dispatcher.dispatcherId,
        source: 'ledger',
        status: 'draining',
      });
      const recoveredHealth = await resumed.inspectTaskDispatcherHealth(dispatcher.dispatcherId, {
        now: new Date(Date.now() + 60_000),
        heartbeatGraceMs: 1,
        drainingTimeoutMs: 1,
      });
      expect(recoveredHealth?.healthy).toBe(false);
      expect(recoveredHealth?.summary.totalFindings).toBeGreaterThan(0);
      expect(recoveredHealth?.followUps.some((item) =>
        item.scaffold.action?.tool === 'TaskDispatcher'
        && item.scaffold.action.arguments['action'] === 'requeue',
      )).toBe(true);
      expect(recoveredHealth?.findings.map((item) => item.code)).toEqual(expect.arrayContaining([
        'lease_expired',
        'stuck_assignment',
        'draining_timeout',
      ]));
      await expect(resumed.getTaskDispatcherDiagnosis(dispatcher.dispatcherId)).resolves.toMatchObject({
        dispatcherId: dispatcher.dispatcherId,
        healthy: false,
      });

      resumed.close();
      session.close();
    } finally {
      temp.cleanup();
    }
  });

  it('forwards follow-up dispatch through the stable session handle', async () => {
    const teamName = `alpha-team-${Date.now()}`;
    const session = createSession({
      model: 'mock-model',
      provider: makeMockProvider([textResponse('unused')]),
    } as any);

    await session.createTeam({ name: teamName, setActive: true });
    const dispatched = await session.executeFollowUp({
      suggestion: 'Tell alice to continue.',
      scaffold: {
        kind: 'generic_followup',
        action: {
          tool: 'SendMessage',
          arguments: {
            type: 'message',
            recipient: 'alice',
            summary: 'Continue',
            content: 'Continue from the stable session follow-up.',
          },
        },
      },
    });

    expect(dispatched.kind).toBe('team_message');
    if (dispatched.kind === 'team_message') {
      expect(dispatched.followUpKind).toBe('generic_followup');
      expect(dispatched.teamMessage?.teamName).toBe(teamName);
    }

    const inbox = await session.readTeamInbox({ teamName, memberName: 'alice', consume: true });
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.content).toBe('Continue from the stable session follow-up.');
    session.close();
  });
});

describe('forkSession()', () => {
  it('is exported from session module', () => {
    expect(typeof forkSession).toBe('function');
  });

  it('returns a session with a different ID than the source', () => {
    const session = forkSession('non-existent-session-id');
    expect(session.sessionId).toBeDefined();
    expect(session.sessionId).not.toBe('non-existent-session-id');
    session.close();
  });

  it('returns a session with required interface methods', () => {
    const session = forkSession('any-session-id');
    expect(typeof session.send).toBe('function');
    expect(typeof session.streamInput).toBe('function');
    expect(typeof session.close).toBe('function');
    expect(typeof session[Symbol.asyncDispose]).toBe('function');
    session.close();
  });

  it('each fork gets a unique session ID', () => {
    const fork1 = forkSession('source-session');
    const fork2 = forkSession('source-session');
    expect(fork1.sessionId).not.toBe(fork2.sessionId);
    fork1.close();
    fork2.close();
  });

  it('is exported from @open-agent/sdk', () => {
    const sdk = require('../index.js');
    expect(typeof sdk.forkSession).toBe('function');
  });

  it('does not throw for non-existent source session (starts with empty history)', () => {
    const session = forkSession('completely-unknown-session-99999');
    expect(session).toBeDefined();
    session.close();
  });

  it('send() throws after close()', async () => {
    const session = forkSession('some-session');
    session.close();

    let threw = false;
    try {
      for await (const _msg of session.send('hello')) {
        // should not reach
      }
    } catch (e) {
      threw = true;
      expect((e as Error).message).toContain('closed');
    }
    expect(threw).toBe(true);
  });
});

describe('resumeSession()', () => {
  it('returns a session with the provided session ID', () => {
    const sessionId = '11111111-1111-4111-8111-111111111141';
    const session = resumeSession(sessionId, { model: 'claude-sonnet-4-6' });
    expect(session.sessionId).toBe(sessionId);
    expect(typeof session.send).toBe('function');
    expect(typeof session.close).toBe('function');
    session.close();
  });

  it('does not throw for non-existent session (starts fresh)', () => {
    const session = resumeSession('11111111-1111-4111-8111-111111111142', {
      model: 'claude-sonnet-4-6',
      cwd: '/tmp',
    });
    expect(session).toBeDefined();
    session.close();
  });
});

describe('unstable_v2_resumeSession()', () => {
  it('uses the provided sessionId for streamed message session_id', async () => {
    const sessionId = '11111111-1111-4111-8111-111111111143';
    const session = unstable_v2_resumeSession(sessionId, {
      model: 'claude-sonnet-4-6',
    });
    await session.send('hello from resume');
    const stream = session.stream();
    const first = await stream.next();
    expect(first.done).toBe(false);
    expect((first.value as any).type).toBe('user');
    expect((first.value as any).session_id).toBe(sessionId);
    session.close();
  });

  it('normalizes enqueued SDKUserMessage session_id to the current session', async () => {
    const session = unstable_v2_createSession({
      model: 'claude-sonnet-4-6',
    });
    await session.send({
      type: 'user',
      message: { role: 'user', content: 'custom message' },
      parent_tool_use_id: null,
      session_id: 'wrong-session-id',
      uuid: 'custom-uuid',
    } as any);
    const stream = session.stream();
    const first = await stream.next();
    expect(first.done).toBe(false);
    expect((first.value as any).session_id).toBe(session.sessionId);
    session.close();
  });

  it('accepts queued mid-stream input through streamInput()', async () => {
    const session = unstable_v2_createSession({
      model: 'claude-sonnet-4-6',
    });

    const stream = session.stream();
    await session.streamInput('hello via streamInput');

    const seen: any[] = [];
    while (true) {
      const next = await stream.next();
      if (next.done) break;
      seen.push(next.value);
      if ((next.value as any).type === 'result') {
        break;
      }
    }

    expect(seen.some((message) => message.type === 'user' && message.session_id === session.sessionId)).toBe(true);
    expect(seen.some((message) => message.type === 'result')).toBe(true);
    await stream.return?.();
    session.close();
  });
});

describe('__internal_buildSessionTurnQueryOptions()', () => {
  it('forces persistSession=false to prevent double transcript persistence', () => {
    const ac = new AbortController();
    const opts = __internal_buildSessionTurnQueryOptions(
      {
        model: 'claude-sonnet-4-6',
        persistSession: true,
      },
      '11111111-1111-4111-8111-111111111144',
      ac,
      [{ role: 'user', content: 'hello' }],
    );

    expect(opts.persistSession).toBe(false);
    expect(opts.sessionId).toBe('11111111-1111-4111-8111-111111111144');
    expect(opts.abortController).toBe(ac);
    expect(opts.initialMessages).toHaveLength(1);
  });
});

describe('__internal_loadInitialMessages()', () => {
  it('prefers loadTranscriptAnyCwd when available', () => {
    const calls: string[] = [];
    const messages = __internal_loadInitialMessages(
      {
        loadTranscript: (_cwd: string, _sessionId: string) => {
          calls.push('loadTranscript');
          return [{ role: 'user', content: 'from-loadTranscript' }] as any;
        },
        loadTranscriptAnyCwd: (_sessionId: string, _cwd: string) => {
          calls.push('loadTranscriptAnyCwd');
          return [{ role: 'user', content: 'from-loadTranscriptAnyCwd' }] as any;
        },
      } as any,
      '/tmp/b',
      '11111111-1111-4111-8111-111111111145',
    );

    expect(calls).toEqual(['loadTranscriptAnyCwd']);
    expect(messages).toEqual([{ role: 'user', content: 'from-loadTranscriptAnyCwd' }]);
  });

  it('falls back to empty history on load error', () => {
    const messages = __internal_loadInitialMessages(
      {
        loadTranscript: () => {
          throw new Error('broken');
        },
        loadTranscriptAnyCwd: () => {
          throw new Error('broken-any-cwd');
        },
      } as any,
      '/tmp/b',
      '11111111-1111-4111-8111-111111111146',
    );
    expect(messages).toEqual([]);
  });
});

describe('__internal_appendSdkMessageToHistory()', () => {
  it('appends user/assistant messages and tool_result blocks', () => {
    const history: any[] = [];

    __internal_appendSdkMessageToHistory(history, {
      type: 'user',
      message: { role: 'user', content: 'hi' },
    } as any);
    __internal_appendSdkMessageToHistory(history, {
      type: 'assistant',
      message: { role: 'assistant', content: 'ok' },
    } as any);
    __internal_appendSdkMessageToHistory(history, {
      type: 'tool_result',
      tool_use_id: 'tool-1',
      result: 'done',
      is_error: false,
    } as any);
    __internal_appendSdkMessageToHistory(history, {
      type: 'tool_result',
      tool_use_id: 'tool-2',
      result: 'done-2',
      is_error: true,
    } as any);

    expect(history).toHaveLength(3);
    expect(history[0]).toEqual({ role: 'user', content: 'hi' });
    expect(history[1]).toEqual({ role: 'assistant', content: 'ok' });
    expect(history[2].role).toBe('user');
    expect(Array.isArray(history[2].content)).toBe(true);
    expect(history[2].content).toHaveLength(2);
    expect(history[2].content[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 'tool-1',
      content: 'done',
    });
    expect(history[2].content[1]).toEqual({
      type: 'tool_result',
      tool_use_id: 'tool-2',
      content: 'done-2',
      is_error: true,
    });
  });
});
