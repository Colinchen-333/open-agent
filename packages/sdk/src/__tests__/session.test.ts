import { describe, it, expect } from 'bun:test';
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
