import { describe, expect, test } from 'bun:test';
import { McpHealthMonitor } from '../health-monitor';

describe('McpHealthMonitor', () => {
  test('starts healthy', () => {
    const monitor = new McpHealthMonitor(async () => ({ ok: true, latencyMs: 10 }));
    monitor.monitor('server1');
    const status = monitor.getStatus('server1');
    expect(status?.healthy).toBe(true);
    expect(status?.consecutiveFailures).toBe(0);
    monitor.stopAll();
  });

  test('marks unhealthy after max failures', async () => {
    const monitor = new McpHealthMonitor(
      async () => ({ ok: false, latencyMs: 0, error: 'down' }),
      { maxFailures: 2 },
    );
    monitor.monitor('s1');
    await monitor.check('s1');
    expect(monitor.getStatus('s1')?.healthy).toBe(true); // 1 < 2
    await monitor.check('s1');
    expect(monitor.getStatus('s1')?.healthy).toBe(false); // 2 >= 2
    monitor.stopAll();
  });

  test('recovers after success', async () => {
    let fail = true;
    const monitor = new McpHealthMonitor(
      async () => fail ? { ok: false, latencyMs: 0, error: 'x' } : { ok: true, latencyMs: 5 },
      { maxFailures: 1 },
    );
    monitor.monitor('s');
    await monitor.check('s');
    expect(monitor.getStatus('s')?.healthy).toBe(false);
    fail = false;
    await monitor.check('s');
    expect(monitor.getStatus('s')?.healthy).toBe(true);
    expect(monitor.getStatus('s')?.consecutiveFailures).toBe(0);
    monitor.stopAll();
  });

  test('getAllStatuses returns all', () => {
    const monitor = new McpHealthMonitor(async () => ({ ok: true, latencyMs: 1 }));
    monitor.monitor('a');
    monitor.monitor('b');
    expect(monitor.getAllStatuses()).toHaveLength(2);
    monitor.stopAll();
  });

  test('unmonitor removes server', () => {
    const monitor = new McpHealthMonitor(async () => ({ ok: true, latencyMs: 1 }));
    monitor.monitor('x');
    monitor.unmonitor('x');
    expect(monitor.getStatus('x')).toBeNull();
    monitor.stopAll();
  });

  test('tracks latency', async () => {
    const monitor = new McpHealthMonitor(async () => ({ ok: true, latencyMs: 42 }));
    monitor.monitor('s');
    await monitor.check('s');
    expect(monitor.getStatus('s')?.latencyMs).toBe(42);
    monitor.stopAll();
  });
});
