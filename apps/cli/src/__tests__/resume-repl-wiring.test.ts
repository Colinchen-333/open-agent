/**
 * Integration test for R7.3 — /resume REPL hydration wiring
 *
 * Verifies that:
 *   1. handleSlashCommand('/resume <prefix>', ctx) returns shouldResume +
 *      resumeTranscript when a matching session is found.
 *   2. ConversationLoop.setMessages() replaces the message array so that the
 *      next turn starts with the restored transcript.
 *   3. The combined contract means the REPL loop in index.ts actually restores
 *      the session when it calls loop.setMessages(result.resumeTranscript).
 */
import { describe, expect, it } from 'bun:test';
import { handleSlashCommand } from '@open-agent/cli';
import { ConversationLoop } from '@open-agent/core';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MOCK_SESSION_ID = 'abcd1234-cafe-0000-0000-000000000000';
const MOCK_TRANSCRIPT = [
  { role: 'user' as const, content: 'hello world' },
  { role: 'assistant' as const, content: 'greetings' },
  { role: 'user' as const, content: 'write a test' },
];

function makeResumeCtx() {
  return {
    loop: {} as any, // not needed by /resume handler itself
    cwd: '/proj',
    model: 'test-model',
    sessionId: 'current-session',
    tools: [],
    capabilities: {} as any,
    checkpoint: {} as any,
    sessionMgr: {
      listSessions: () => [
        {
          id: MOCK_SESSION_ID,
          title: 'Test session',
          cwd: '/proj',
          lastActiveAt: new Date().toISOString(),
        },
      ],
      loadTranscript: () => MOCK_TRANSCRIPT,
    },
  } as any;
}

function makeLoop(): ConversationLoop {
  return new ConversationLoop({
    provider: {
      chat: async () => { throw new Error('should not be called'); },
    } as any,
    model: 'test-model',
    tools: new Map(),
    cwd: '/tmp/test',
    sessionId: 'test-session',
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('/resume REPL wiring — contract between slash-command and loop', () => {
  it('slash command returns shouldResume and resumeTranscript for a matching prefix', async () => {
    const ctx = makeResumeCtx();
    const result = await handleSlashCommand('/resume abcd1234', ctx);

    expect(result?.handled).toBe(true);
    expect(result?.shouldResume).toBe(MOCK_SESSION_ID);
    expect(Array.isArray(result?.resumeTranscript)).toBe(true);
    expect(result?.resumeTranscript).toHaveLength(MOCK_TRANSCRIPT.length);
  });

  it('ConversationLoop.setMessages() replaces the message history', () => {
    const loop = makeLoop();

    // Starts empty.
    expect(loop.getMessages()).toHaveLength(0);

    // Simulate what the REPL loop does after receiving shouldResume.
    loop.setMessages(MOCK_TRANSCRIPT as any);

    const restored = loop.getMessages();
    expect(restored).toHaveLength(MOCK_TRANSCRIPT.length);
    expect(restored[0].role).toBe('user');
    expect((restored[0].content as string)).toBe('hello world');
    expect(restored[2].role).toBe('user');
  });

  it('setMessages filters out transient messages from the incoming transcript', () => {
    const loop = makeLoop();
    const withTransient = [
      { role: 'user' as const, content: 'real', _transient: false },
      { role: 'assistant' as const, content: 'also real' },
      { role: 'user' as const, content: 'transient', _transient: true },
    ] as any[];

    loop.setMessages(withTransient);

    const restored = loop.getMessages();
    expect(restored).toHaveLength(2);
    expect(restored.every((m: any) => !m._transient)).toBe(true);
  });

  it('end-to-end: slash command result drives loop.setMessages correctly', async () => {
    const ctx = makeResumeCtx();
    const loop = makeLoop();
    let capturedSessionId = 'current-session';

    const result = await handleSlashCommand('/resume abcd1234', ctx);

    // Simulate exactly what index.ts does after getting the result:
    if (result?.shouldResume && Array.isArray(result.resumeTranscript)) {
      loop.setMessages(result.resumeTranscript as any);
      capturedSessionId = result.shouldResume;
    }

    expect(capturedSessionId).toBe(MOCK_SESSION_ID);
    expect(loop.getMessages()).toHaveLength(MOCK_TRANSCRIPT.length);
  });

  it('resume wiring calls setSessionId on the loop (R8.2)', async () => {
    const ctx = makeResumeCtx();
    const loop = makeLoop();

    const result = await handleSlashCommand('/resume abcd1234', ctx);

    // Simulate exactly what the updated index.ts wiring does:
    if (result?.shouldResume && Array.isArray(result.resumeTranscript)) {
      loop.setMessages(result.resumeTranscript as any);
      if (typeof loop.setSessionId === 'function') {
        loop.setSessionId(result.shouldResume);
      }
    }

    // Verify the loop's internal sessionId has been switched to the resumed one.
    expect((loop as any).options.sessionId).toBe(MOCK_SESSION_ID);
    // turnCount should have been reset by setMessages.
    expect(loop.getTurnCount()).toBe(0);
  });
});
