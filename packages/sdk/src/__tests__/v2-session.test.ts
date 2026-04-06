import { describe, expect, test } from 'bun:test';
import { createSession, resumeSession, prompt } from '../v2-session';

describe('V2 Session API', () => {
  test('createSession returns session with ID', () => {
    const session = createSession({ model: 'test' });
    expect(session.id).toBeDefined();
    expect(session.getState().status).toBe('idle');
  });

  test('sendMessage yields events', async () => {
    const session = createSession({});
    const events: any[] = [];
    for await (const msg of session.sendMessage('hello')) {
      events.push(msg);
    }
    expect(events.length).toBeGreaterThan(0);
    expect(events.some(e => e.type === 'result')).toBe(true);
    await session.close();
  });

  test('getState tracks turn count', async () => {
    const session = createSession({});
    for await (const _ of session.sendMessage('turn 1')) {}
    expect(session.getState().turnCount).toBe(1);
    for await (const _ of session.sendMessage('turn 2')) {}
    expect(session.getState().turnCount).toBe(2);
    await session.close();
  });

  test('close sets status to closed', async () => {
    const session = createSession({});
    await session.close();
    expect(session.getState().status).toBe('closed');
  });

  test('sendMessage on closed session throws', async () => {
    const session = createSession({});
    await session.close();
    const iter = session.sendMessage('fail');
    await expect(async () => { for await (const _ of iter) {} }).toThrow('closed');
  });

  test('resumeSession uses provided ID', () => {
    const session = resumeSession('existing-id', {});
    expect(session.id).toBe('existing-id');
  });

  test('prompt returns result', async () => {
    const result = await prompt('hello', {});
    expect(result.type).toBe('result');
    expect(result.subtype).toBe('success');
  });
});
