import { describe, expect, test, beforeEach } from 'bun:test';
import {
  recordCollapseCommit,
  recordCollapseError,
  recordEmptyCollapse,
  stageCollapse,
  flushStaged,
  resetContextCollapse,
  restoreFromEntries,
  getCollapseStats,
  getCollapseCommits,
  subscribeToCollapse,
  type ContextCollapseCommit,
} from '../compact/index';

function makeCommit(overrides?: Partial<ContextCollapseCommit>): ContextCollapseCommit {
  return {
    id: overrides?.id ?? 'c-' + Math.random().toString(36).slice(2, 6),
    summary: overrides?.summary ?? 'test summary',
    messageCount: overrides?.messageCount ?? 5,
    tokensSaved: overrides?.tokensSaved ?? 1000,
    timestamp: overrides?.timestamp ?? new Date().toISOString(),
  };
}

describe('context-collapse', () => {
  beforeEach(() => resetContextCollapse());

  test('starts with zero stats', () => {
    const stats = getCollapseStats();
    expect(stats.collapsedSpans).toBe(0);
    expect(stats.collapsedMessages).toBe(0);
    expect(stats.health.totalSpawns).toBe(0);
  });

  test('recordCollapseCommit updates stats', () => {
    recordCollapseCommit(makeCommit({ messageCount: 10 }));
    const stats = getCollapseStats();
    expect(stats.collapsedSpans).toBe(1);
    expect(stats.collapsedMessages).toBe(10);
    expect(stats.health.totalSpawns).toBe(1);
  });

  test('getCollapseCommits returns committed entries', () => {
    const c = makeCommit({ id: 'test-1' });
    recordCollapseCommit(c);
    const commits = getCollapseCommits();
    expect(commits).toHaveLength(1);
    expect(commits[0].id).toBe('test-1');
  });

  test('recordCollapseError increments error count', () => {
    recordCollapseError('test error');
    const stats = getCollapseStats();
    expect(stats.health.totalErrors).toBe(1);
    expect(stats.health.lastError).toBe('test error');
  });

  test('recordEmptyCollapse tracks empty spawns', () => {
    recordEmptyCollapse();
    recordEmptyCollapse();
    recordEmptyCollapse();
    const stats = getCollapseStats();
    expect(stats.health.totalEmptySpawns).toBe(3);
    expect(stats.health.emptySpawnWarningEmitted).toBe(true);
  });

  test('stageCollapse and flushStaged', () => {
    const c = makeCommit();
    stageCollapse(c);
    expect(getCollapseStats().stagedSpans).toBe(1);
    const flushed = flushStaged();
    expect(flushed).toHaveLength(1);
    expect(getCollapseStats().stagedSpans).toBe(0);
  });

  test('subscribe notifies on changes', () => {
    let callCount = 0;
    const unsub = subscribeToCollapse(() => callCount++);
    recordCollapseCommit(makeCommit());
    recordCollapseError('err');
    expect(callCount).toBe(2);
    unsub();
    recordCollapseCommit(makeCommit());
    expect(callCount).toBe(2); // no more notifications
  });

  test('resetContextCollapse clears all state', () => {
    recordCollapseCommit(makeCommit());
    recordCollapseError('e');
    resetContextCollapse();
    expect(getCollapseStats().collapsedSpans).toBe(0);
    expect(getCollapseCommits()).toHaveLength(0);
  });

  test('restoreFromEntries rebuilds state', () => {
    const commits = [makeCommit({ messageCount: 3 }), makeCommit({ messageCount: 7 })];
    restoreFromEntries(commits);
    const stats = getCollapseStats();
    expect(stats.collapsedSpans).toBe(2);
    expect(stats.collapsedMessages).toBe(10);
  });

  test('getCollapseStats returns deep copy', () => {
    recordCollapseCommit(makeCommit());
    const s1 = getCollapseStats();
    const s2 = getCollapseStats();
    expect(s1).not.toBe(s2);
    expect(s1.health).not.toBe(s2.health);
  });
});
