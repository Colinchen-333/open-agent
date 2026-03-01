import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, appendFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SessionManager } from '../session-manager.js';

// We point the SessionManager at a temp directory instead of ~/. open-agent
// by monkey-patching the private baseDir field via a subclass.
class TestSessionManager extends SessionManager {
  constructor(baseDir: string) {
    super();
    // Override the private field by casting through unknown.
    (this as unknown as { baseDir: string }).baseDir = baseDir;
  }
}

describe('SessionManager', () => {
  let tmpBase: string;
  let sm: SessionManager;
  // A fake CWD to use for all sessions — must be absolute so path-encoding works.
  const cwd = '/tmp/test-project';

  beforeAll(() => {
    tmpBase = mkdtempSync(join(tmpdir(), 'open-agent-test-'));
    sm = new TestSessionManager(tmpBase);
  });

  afterAll(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  it('createSession returns a SessionInfo with correct fields', () => {
    const session = sm.createSession(cwd, 'claude-3-5-sonnet');

    expect(session.id).toBeTypeOf('string');
    expect(session.id.length).toBeGreaterThan(0);
    expect(session.cwd).toBe(cwd);
    expect(session.model).toBe('claude-3-5-sonnet');
    expect(session.createdAt).toBeTypeOf('string');
    expect(session.lastActiveAt).toBeTypeOf('string');
  });

  it('createSession persists metadata to disk (getSession retrieves it)', () => {
    const created = sm.createSession(cwd, 'gpt-4o');
    const retrieved = sm.getSession(cwd, created.id);

    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe(created.id);
    expect(retrieved!.model).toBe('gpt-4o');
  });

  it('ensureSession creates metadata for a caller-provided session id', () => {
    const forcedId = 'forced-session-id-123';
    const ensured = sm.ensureSession(cwd, forcedId, 'claude-sonnet-4-6');
    expect(ensured.id).toBe(forcedId);
    expect(ensured.model).toBe('claude-sonnet-4-6');

    const retrieved = sm.getSession(cwd, forcedId);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe(forcedId);
  });

  it('getLatestSession returns the most recently touched session', () => {
    const first = sm.createSession(cwd, 'model-a');
    const second = sm.createSession(cwd, 'model-b');
    // Touch the first session so its lastActiveAt is strictly newer.
    // Use a small sleep to guarantee timestamp difference.
    const wait = (ms: number) => { const end = Date.now() + ms; while (Date.now() < end); };
    wait(5);
    sm.touchSession(cwd, first.id);

    const latest = sm.getLatestSession(cwd);
    expect(latest).not.toBeNull();
    expect(latest!.id).toBe(first.id);
  });

  it('getLatestSession returns null when no sessions exist for a CWD', () => {
    const fresh = sm.getLatestSession('/non/existent/project/path');
    expect(fresh).toBeNull();
  });

  it('appendToTranscript and readTranscript persist and restore messages', () => {
    const session = sm.createSession(cwd, 'test-model');

    const msgs = [
      { type: 'user', message: { role: 'user', content: 'hello' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } },
    ];

    for (const m of msgs) {
      sm.appendToTranscript(cwd, session.id, m);
    }

    const loaded = sm.readTranscript(cwd, session.id);
    expect(loaded).toHaveLength(2);
    expect((loaded[0] as any).type).toBe('user');
    expect((loaded[1] as any).type).toBe('assistant');
  });

  it('readTranscript returns empty array when transcript does not exist', () => {
    const session = sm.createSession(cwd, 'no-transcript-model');
    // Do not append anything — the .jsonl file should not exist yet.
    const result = sm.readTranscript(cwd, session.id);
    expect(result).toEqual([]);
  });

  it('readTranscript skips malformed lines and keeps valid entries', () => {
    const session = sm.createSession(cwd, 'corrupt-transcript-model');
    sm.appendToTranscript(cwd, session.id, { type: 'user', message: { role: 'user', content: 'hello' } });
    const safePath = cwd.replace(/\//g, '-').replace(/^-/, '');
    const transcriptPath = join(tmpBase, safePath, `${session.id}.jsonl`);
    appendFileSync(transcriptPath, '{"type":bad json}\n');
    sm.appendToTranscript(cwd, session.id, { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } });

    const loaded = sm.readTranscript(cwd, session.id);
    expect(loaded).toHaveLength(2);
    expect((loaded[0] as any).type).toBe('user');
    expect((loaded[1] as any).type).toBe('assistant');
  });

  it('loadTranscript reconstructs only user and assistant messages', () => {
    const session = sm.createSession(cwd, 'load-test-model');

    const entries = [
      { type: 'user', message: { role: 'user', content: 'what is 2+2?' } },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '4' }],
        },
      },
      // These should be filtered out by loadTranscript
      { type: 'stream_event', event: { type: 'text_delta', text: 'x' } },
      { type: 'tool_result', tool_name: 'Read', tool_use_id: 'xyz', result: 'ok', is_error: false },
      {
        type: 'result',
        subtype: 'success',
        result: '4',
        is_error: false,
        num_turns: 1,
        duration_ms: 100,
        duration_api_ms: 50,
        stop_reason: 'end_turn',
        total_cost_usd: 0,
        usage: {},
        modelUsage: {},
        permission_denials: [],
        uuid: 'test-uuid',
        session_id: session.id,
      },
    ];

    for (const e of entries) {
      sm.appendToTranscript(cwd, session.id, e);
    }

    const messages = sm.loadTranscript(cwd, session.id);
    // user + assistant + tool_result (reconstructed as user message) should be included
    expect(messages).toHaveLength(3);
    expect(messages[0].role).toBe('user');
    expect(messages[0].content).toBe('what is 2+2?');
    expect(messages[1].role).toBe('assistant');
    expect(messages[2].role).toBe('user'); // tool_result becomes a user message
  });

  it('loadTranscriptUpToAssistant truncates history at target assistant uuid', () => {
    const session = sm.createSession(cwd, 'resume-cutoff-model');
    sm.appendToTranscript(cwd, session.id, {
      type: 'user',
      uuid: 'u1',
      session_id: session.id,
      message: { role: 'user', content: 'first' },
    });
    sm.appendToTranscript(cwd, session.id, {
      type: 'assistant',
      uuid: 'a1',
      session_id: session.id,
      message: { role: 'assistant', content: [{ type: 'text', text: 'first answer' }] },
    });
    sm.appendToTranscript(cwd, session.id, {
      type: 'user',
      uuid: 'u2',
      session_id: session.id,
      message: { role: 'user', content: 'second' },
    });
    sm.appendToTranscript(cwd, session.id, {
      type: 'assistant',
      uuid: 'a2',
      session_id: session.id,
      message: { role: 'assistant', content: [{ type: 'text', text: 'second answer' }] },
    });

    const truncated = sm.loadTranscriptUpToAssistant(cwd, session.id, 'a1');
    expect(truncated.found).toBe(true);
    expect(truncated.messages).toHaveLength(2);
    expect(truncated.messages[0].role).toBe('user');
    expect(truncated.messages[1].role).toBe('assistant');

    const missing = sm.loadTranscriptUpToAssistant(cwd, session.id, 'missing-assistant');
    expect(missing.found).toBe(false);
    expect(missing.messages).toEqual([]);
  });

  it('listSessions returns all sessions for a CWD sorted by lastActiveAt desc', () => {
    // Use a fresh CWD to avoid pollution from earlier tests.
    const listCwd = '/tmp/list-sessions-test';
    const a = sm.createSession(listCwd, 'model-a');
    const b = sm.createSession(listCwd, 'model-b');
    // Ensure timestamps differ, then touch b so its lastActiveAt > a's
    const wait = (ms: number) => { const end = Date.now() + ms; while (Date.now() < end); };
    wait(5);
    sm.touchSession(listCwd, b.id);

    const sessions = sm.listSessions(listCwd);
    expect(sessions.length).toBeGreaterThanOrEqual(2);
    // First result should be the touched session b.
    const ids = sessions.map((s) => s.id);
    expect(ids.indexOf(b.id)).toBeLessThan(ids.indexOf(a.id));
  });
});
