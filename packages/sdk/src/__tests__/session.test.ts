import { describe, it, expect } from 'bun:test';
import type { ModelInfo } from '@open-agent/core';
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
    const inbox = await session.readTeamInbox({ memberName: 'alice', consume: true });
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.teamName).toBe(teamName);
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
          name: 'alice',
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
