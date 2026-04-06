import { describe, expect, test, beforeEach } from 'bun:test';
import { AnalyticsCollector } from '../analytics';

describe('AnalyticsCollector', () => {
  let collector: AnalyticsCollector;

  beforeEach(() => {
    collector = new AnalyticsCollector('test-session');
  });

  test('logs event with auto ID and timestamp', () => {
    collector.logEvent({ category: 'tool', action: 'Bash' });
    const events = collector.getEvents();
    expect(events).toHaveLength(1);
    expect(events[0].id).toBeDefined();
    expect(events[0].timestamp).toBeDefined();
    expect(events[0].sessionId).toBe('test-session');
  });

  test('filters events by category', () => {
    collector.logEvent({ category: 'tool', action: 'Bash' });
    collector.logEvent({ category: 'error', action: 'timeout' });
    collector.logEvent({ category: 'tool', action: 'Read' });
    expect(collector.getEvents('tool')).toHaveLength(2);
    expect(collector.getEvents('error')).toHaveLength(1);
  });

  test('tracks tool use counts', () => {
    collector.logEvent({ category: 'tool', action: 'Bash' });
    collector.logEvent({ category: 'tool', action: 'Bash' });
    collector.logEvent({ category: 'tool', action: 'Read' });
    const metrics = collector.getSessionMetrics();
    expect(metrics.toolUseCounts['Bash']).toBe(2);
    expect(metrics.toolUseCounts['Read']).toBe(1);
  });

  test('tracks provider token usage', () => {
    collector.logEvent({
      category: 'provider',
      action: 'chat',
      metadata: { inputTokens: 1000, outputTokens: 500, costUsd: 0.01 },
      durationMs: 1500,
    });
    const metrics = collector.getSessionMetrics();
    expect(metrics.totalInputTokens).toBe(1000);
    expect(metrics.totalOutputTokens).toBe(500);
    expect(metrics.totalCostUsd).toBeCloseTo(0.01);
    expect(metrics.totalTurns).toBe(1);
  });

  test('tracks permission events', () => {
    collector.logEvent({ category: 'permission', action: 'approved' });
    collector.logEvent({ category: 'permission', action: 'denied' });
    collector.logEvent({ category: 'permission', action: 'approved' });
    const metrics = collector.getSessionMetrics();
    expect(metrics.permissionPrompts).toBe(3);
    expect(metrics.permissionApprovals).toBe(2);
    expect(metrics.permissionDenials).toBe(1);
  });

  test('tracks errors', () => {
    collector.logEvent({ category: 'error', action: 'provider_error' });
    expect(collector.getSessionMetrics().errors).toBe(1);
  });

  test('getTopTools returns sorted', () => {
    for (let i = 0; i < 5; i++) collector.logEvent({ category: 'tool', action: 'Bash' });
    for (let i = 0; i < 3; i++) collector.logEvent({ category: 'tool', action: 'Read' });
    collector.logEvent({ category: 'tool', action: 'Write' });
    const top = collector.getTopTools(2);
    expect(top[0].tool).toBe('Bash');
    expect(top[0].count).toBe(5);
    expect(top).toHaveLength(2);
  });

  test('formatSummary produces readable text', () => {
    collector.logEvent({ category: 'provider', action: 'chat', metadata: { inputTokens: 100 }, durationMs: 500 });
    const summary = collector.formatSummary();
    expect(summary).toContain('test-session');
    expect(summary).toContain('Turns: 1');
  });

  test('recordMetric and retrieve', () => {
    collector.recordMetric('latency', 150, 'ms');
    collector.recordMetric('memory', 1024, 'bytes');
    expect(collector.getPerformanceMetrics('latency')).toHaveLength(1);
    expect(collector.getPerformanceMetrics()).toHaveLength(2);
  });

  test('evicts old events when over maxEvents', () => {
    const small = new AnalyticsCollector('s', { maxEvents: 10 });
    for (let i = 0; i < 15; i++) small.logEvent({ category: 'tool', action: `t${i}` });
    expect(small.getEvents().length).toBeLessThanOrEqual(10);
  });

  test('serialize and endSession', () => {
    collector.logEvent({ category: 'tool', action: 'x' });
    collector.endSession();
    const json = collector.serialize();
    const parsed = JSON.parse(json);
    expect(parsed.sessionMetrics.endedAt).toBeDefined();
    expect(parsed.events).toHaveLength(1);
  });

  test('reset clears all state', () => {
    collector.logEvent({ category: 'tool', action: 'x' });
    collector.reset('new-session');
    expect(collector.getEvents()).toHaveLength(0);
    expect(collector.getSessionMetrics().sessionId).toBe('new-session');
  });
});
