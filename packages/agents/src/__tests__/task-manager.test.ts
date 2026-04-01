import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { TaskManager } from '../task-manager';

describe('TaskManager scheduling', () => {
  let rootDir: string;
  let manager: TaskManager;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'open-agent-task-manager-'));
    manager = new TaskManager('demo', { rootDir });
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('claims the highest-priority available task first', () => {
    manager.create('low', 'low priority', undefined, undefined, 1);
    manager.create('high', 'high priority', undefined, undefined, 10);

    const claimed = manager.claimNext('worker-a', {
      now: new Date('2026-04-01T10:00:00.000Z'),
      leaseMs: 60_000,
    });

    expect(claimed?.subject).toBe('high');
    expect(claimed?.status).toBe('in_progress');
    expect(claimed?.owner).toBe('worker-a');
    expect(claimed?.lease?.attempts).toBe(1);
    expect(manager.listAvailable(new Date('2026-04-01T10:00:30.000Z')).map((task) => task.subject)).toEqual(['low']);
  });

  it('reclaims expired leases and increments attempts', () => {
    manager.create('recover', 'recover expired worker lease', undefined, undefined, 5);

    const firstClaim = manager.claimNext('worker-a', {
      now: new Date('2026-04-01T10:00:00.000Z'),
      leaseMs: 1_000,
    });
    expect(firstClaim?.lease?.owner).toBe('worker-a');

    expect(manager.listAvailable(new Date('2026-04-01T10:00:00.500Z'))).toHaveLength(0);

    const reclaimed = manager.claimNext('worker-b', {
      now: new Date('2026-04-01T10:00:02.000Z'),
      leaseMs: 5_000,
    });

    expect(reclaimed?.id).toBe(firstClaim?.id);
    expect(reclaimed?.owner).toBe('worker-b');
    expect(reclaimed?.lease?.attempts).toBe(2);
    expect(reclaimed?.lease?.expiresAt).toBe('2026-04-01T10:00:07.000Z');
  });

  it('renews and releases leases with ownership checks', () => {
    const task = manager.create('ship', 'ship release', undefined, undefined, 3);
    manager.claimNext('worker-a', {
      now: new Date('2026-04-01T10:00:00.000Z'),
      leaseMs: 60_000,
    });

    expect(() => manager.renewLease(task.id, 'worker-b')).toThrow(`Task ${task.id} is not leased by worker-b`);

    const renewed = manager.renewLease(task.id, 'worker-a', {
      now: new Date('2026-04-01T10:01:00.000Z'),
      leaseMs: 30_000,
    });
    expect(renewed.lease?.expiresAt).toBe('2026-04-01T10:01:30.000Z');

    const released = manager.releaseLease(task.id, 'worker-a');
    expect(released.status).toBe('pending');
    expect(released.owner).toBeUndefined();
    expect(released.lease).toBeUndefined();
    expect(manager.listAvailable(new Date('2026-04-01T10:01:01.000Z')).map((entry) => entry.id)).toEqual([task.id]);
  });

  it('does not claim blocked or deleted tasks', () => {
    const blocker = manager.create('blocker', 'finish first', undefined, undefined, 2);
    const blocked = manager.create('blocked', 'depends on blocker', undefined, undefined, 9);
    const deleted = manager.create('deleted', 'removed work item', undefined, undefined, 100);

    manager.update(blocked.id, { addBlockedBy: [blocker.id] });
    manager.update(deleted.id, { status: 'deleted' });

    const claimed = manager.claimNext('worker-a', {
      now: new Date('2026-04-01T10:00:00.000Z'),
      leaseMs: 60_000,
    });

    expect(claimed?.id).toBe(blocker.id);
    expect(manager.listAvailable(new Date('2026-04-01T10:00:01.000Z')).map((entry) => entry.id)).toEqual([]);

    manager.releaseLease(blocker.id, 'worker-a', 'completed');
    expect(manager.listAvailable(new Date('2026-04-01T10:00:02.000Z')).map((entry) => entry.id)).toEqual([blocked.id]);
  });
});
