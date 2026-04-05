import { describe, expect, test } from 'bun:test';
import { searchSessions, buildCrossProjectResumeHint } from '../session-search.js';

describe('session-search', () => {
  // Sessions use ISO strings for createdAt/lastActiveAt to match the real SessionInfo shape.
  const SESSIONS: any[] = [
    {
      id: 'a',
      title: 'Fix auth bug',
      cwd: '/proj/a',
      model: 'claude-3',
      createdAt: new Date(Date.now() - 1000).toISOString(),
      lastActiveAt: new Date(Date.now() - 1000).toISOString(),
    },
    {
      id: 'b',
      title: 'Refactor payments module',
      cwd: '/proj/a',
      model: 'claude-3',
      createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 10).toISOString(),
      lastActiveAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 10).toISOString(),
    },
    {
      id: 'c',
      title: 'Auth refactor in other project',
      cwd: '/proj/b',
      model: 'claude-3',
      createdAt: new Date(Date.now() - 1000 * 30).toISOString(),
      lastActiveAt: new Date(Date.now() - 1000 * 30).toISOString(),
    },
  ];

  test('text search matches title keywords', () => {
    const results = searchSessions(SESSIONS, { text: 'auth' }, '/proj/a');
    expect(results.length).toBeGreaterThanOrEqual(2);
    const ids = results.map((r) => r.sessionId);
    expect(ids).toContain('a');
    expect(ids).toContain('c');
  });

  test('empty query returns all sessions with default score', () => {
    const results = searchSessions(SESSIONS, {}, '/proj/a');
    expect(results).toHaveLength(3);
  });

  test('crossProject flag is true for sessions in a different cwd', () => {
    const results = searchSessions(SESSIONS, { text: 'auth' }, '/proj/a');
    const c = results.find((r) => r.sessionId === 'c');
    expect(c?.crossProject).toBe(true);
    const a = results.find((r) => r.sessionId === 'a');
    expect(a?.crossProject).toBe(false);
  });

  test('recency bonus boosts recently active sessions', () => {
    const results = searchSessions(SESSIONS, { text: 'auth' }, '/proj/a');
    const a = results.find((r) => r.sessionId === 'a')!; // very recent, lastActiveAt within 24h
    expect(a.score).toBeGreaterThan(0.5); // 1.0 keyword match + 0.1 recency
  });

  test('limit caps results', () => {
    const results = searchSessions(SESSIONS, { text: 'auth', limit: 1 }, '/proj/a');
    expect(results).toHaveLength(1);
  });

  test('sinceTimestamp filters out older sessions', () => {
    // Set threshold to 5 days ago; session 'b' (10 days old) should be excluded
    const fiveDaysAgo = Date.now() - 1000 * 60 * 60 * 24 * 5;
    const results = searchSessions(SESSIONS, { sinceTimestamp: fiveDaysAgo }, '/proj/a');
    const ids = results.map((r) => r.sessionId);
    expect(ids).not.toContain('b');
    expect(ids).toContain('a');
    expect(ids).toContain('c');
  });

  test('buildCrossProjectResumeHint produces actionable string', () => {
    const hint = buildCrossProjectResumeHint(
      { sessionId: 'x', cwd: '/other/proj', score: 1, crossProject: true },
      '/current',
    );
    expect(hint).toContain('different project');
    expect(hint).toContain('/other/proj');
    expect(hint).toContain('--resume x');
  });

  test('buildCrossProjectResumeHint returns null for same-cwd', () => {
    const hint = buildCrossProjectResumeHint(
      { sessionId: 'x', cwd: '/current', score: 1, crossProject: false },
      '/current',
    );
    expect(hint).toBeNull();
  });
});
