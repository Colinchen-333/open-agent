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

  it('claimNext 会领取最高优先级的可用任务并写入 lease', () => {
    manager.create('low', 'low priority', undefined, undefined, 1);
    const high = manager.create('high', 'high priority', undefined, undefined, 10);

    const claimed = manager.claimNext('worker-a', {
      now: new Date('2026-04-01T10:00:00.000Z'),
      leaseMs: 60_000,
    });

    expect(claimed?.id).toBe(high.id);
    expect(claimed?.subject).toBe('high');
    expect(claimed?.status).toBe('in_progress');
    expect(claimed?.owner).toBe('worker-a');
    expect(claimed?.lease?.attempts).toBe(1);
    expect(claimed?.lease?.expiresAt).toBe('2026-04-01T10:01:00.000Z');
    expect(manager.listAvailable(new Date('2026-04-01T10:00:30.000Z')).map((task) => task.subject)).toEqual(['low']);
  });

  it('有效 lease 不可重复领取', () => {
    const task = manager.create('claim-once', 'single claim', undefined, undefined, 5);

    const firstClaim = manager.claimNext('worker-a', {
      now: new Date('2026-04-01T10:00:00.000Z'),
      leaseMs: 60_000,
    });
    const secondClaim = manager.claimNext('worker-b', {
      now: new Date('2026-04-01T10:00:30.000Z'),
      leaseMs: 60_000,
    });

    expect(firstClaim?.id).toBe(task.id);
    expect(secondClaim).toBeNull();
    expect(manager.get(task.id)?.owner).toBe('worker-a');
  });

  it('过期 lease 会被释放并重新可领取', () => {
    manager.create('recover', 'recover expired worker lease', undefined, undefined, 5);

    const firstClaim = manager.claimNext('worker-a', {
      now: new Date('2026-04-01T10:00:00.000Z'),
      leaseMs: 1_000,
    });
    expect(firstClaim?.lease?.owner).toBe('worker-a');

    expect(manager.listAvailable(new Date('2026-04-01T10:00:00.500Z'))).toHaveLength(0);
    const released = manager.releaseExpiredLeases(new Date('2026-04-01T10:00:02.000Z'));
    expect(released).toHaveLength(1);
    expect(released[0]?.status).toBe('pending');
    expect(released[0]?.owner).toBeUndefined();
    expect(released[0]?.lease?.attempts).toBe(1);

    const reclaimed = manager.claimNext('worker-b', {
      now: new Date('2026-04-01T10:00:02.000Z'),
      leaseMs: 5_000,
    });

    expect(reclaimed?.id).toBe(firstClaim?.id);
    expect(reclaimed?.owner).toBe('worker-b');
    expect(reclaimed?.lease?.attempts).toBe(2);
    expect(reclaimed?.lease?.expiresAt).toBe('2026-04-01T10:00:07.000Z');
  });

  it('heartbeat 只能续租当前 owner 的有效 lease', () => {
    const task = manager.create('ship', 'ship release', undefined, undefined, 3);
    manager.claimNext('worker-a', {
      now: new Date('2026-04-01T10:00:00.000Z'),
      leaseMs: 60_000,
    });

    expect(() => manager.heartbeat(
      task.id,
      'worker-b',
      30_000,
      new Date('2026-04-01T10:00:30.000Z'),
    )).toThrow(`Task ${task.id} is not leased by worker-b`);

    const renewed = manager.heartbeat(
      task.id,
      'worker-a',
      30_000,
      new Date('2026-04-01T10:00:45.000Z'),
    );
    expect(renewed.lease?.expiresAt).toBe('2026-04-01T10:01:15.000Z');

    expect(() => manager.heartbeat(
      task.id,
      'worker-a',
      30_000,
      new Date('2026-04-01T10:01:16.000Z'),
    )).toThrow(`Task ${task.id} lease has expired`);
  });

  it('releaseLease 会把任务释放回 pending 或完成态', () => {
    const task = manager.create('ship', 'ship release', undefined, undefined, 3);
    manager.claimNext('worker-a', {
      now: new Date('2026-04-01T10:00:00.000Z'),
      leaseMs: 60_000,
    });

    const released = manager.releaseLease(task.id, 'worker-a');
    expect(released.status).toBe('pending');
    expect(released.owner).toBeUndefined();
    expect(released.lease).toBeUndefined();
    expect(manager.listAvailable(new Date('2026-04-01T10:00:30.000Z')).map((entry) => entry.id)).toEqual([task.id]);

    const claimedAgain = manager.claimNext('worker-b', {
      now: new Date('2026-04-01T10:01:00.000Z'),
      leaseMs: 60_000,
    });
    expect(claimedAgain?.owner).toBe('worker-b');
    const completed = manager.releaseLease(task.id, 'worker-b', 'completed');
    expect(completed.status).toBe('completed');
    expect(completed.owner).toBe('worker-b');
    expect(completed.lease).toBeUndefined();
  });

  it('不会领取 blocked 或 deleted 任务', () => {
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
