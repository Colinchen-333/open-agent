import { describe, it, expect } from 'bun:test';
import { createSession, resumeSession } from '../session.js';

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

describe('resumeSession()', () => {
  it('returns a session with the provided session ID', () => {
    const session = resumeSession('test-session-id', { model: 'claude-sonnet-4-6' });
    expect(session.sessionId).toBe('test-session-id');
    expect(typeof session.send).toBe('function');
    expect(typeof session.close).toBe('function');
    session.close();
  });

  it('does not throw for non-existent session (starts fresh)', () => {
    const session = resumeSession('nonexistent-session-id', {
      model: 'claude-sonnet-4-6',
      cwd: '/tmp',
    });
    expect(session).toBeDefined();
    session.close();
  });
});
