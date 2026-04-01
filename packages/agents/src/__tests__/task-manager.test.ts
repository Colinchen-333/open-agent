import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { TaskManager } from '../task-manager.js';

function makeHarness() {
  const teamName = `task-manager-${randomUUID()}`;
  const manager = new TaskManager(teamName);
  const taskDir = join(homedir(), '.open-agent', 'tasks', teamName);

  return {
    teamName,
    manager,
    taskDir,
    cleanup() {
      rmSync(taskDir, { recursive: true, force: true });
    },
  };
}

function taskPath(taskDir: string, taskId: string): string {
  return join(taskDir, `${taskId}.json`);
}

function readTaskFile(taskDir: string, taskId: string): any {
  return JSON.parse(readFileSync(taskPath(taskDir, taskId), 'utf-8'));
}

function writeTaskFile(taskDir: string, taskId: string, task: Record<string, unknown>): void {
  writeFileSync(taskPath(taskDir, taskId), JSON.stringify(task, null, 2));
}

describe('TaskManager claim/lease workflow', () => {
  it('claimNext 成功领取任务并写入 owner/status/lease 状态', () => {
    const { manager, taskDir, cleanup } = makeHarness();

    try {
      const created = manager.create('subject-1', 'description-1');
      const claimed = (manager as any).claimNext('worker-1');
      const stored = manager.get(created.id) as any;

      expect(claimed?.id ?? claimed?.task?.id).toBe(created.id);
      expect(claimed?.owner ?? claimed?.task?.owner).toBe('worker-1');
      expect(stored.owner).toBe('worker-1');
      expect(stored.status).toBe('in_progress');
      expect(stored.leaseOwner ?? stored.owner).toBe('worker-1');
      expect(typeof stored.leaseExpiresAt).toBe('string');
      expect(stored.leaseExpiresAt.length).toBeGreaterThan(0);
      expect(readTaskFile(taskDir, created.id).status).toBe('in_progress');
    } finally {
      cleanup();
    }
  });

  it('有效 lease 不可重复领取', () => {
    const { manager, cleanup } = makeHarness();

    try {
      const created = manager.create('subject-2', 'description-2');
      const firstClaim = (manager as any).claimNext('worker-1');
      const secondClaim = (manager as any).claimNext('worker-2');

      expect(firstClaim?.id ?? firstClaim?.task?.id).toBe(created.id);
      expect(secondClaim == null).toBe(true);
      expect((manager.get(created.id) as any).owner).toBe('worker-1');
    } finally {
      cleanup();
    }
  });

  it('过期 lease 会释放并可再次领取', () => {
    const { manager, taskDir, cleanup } = makeHarness();

    try {
      const created = manager.create('subject-3', 'description-3');
      writeTaskFile(taskDir, created.id, {
        ...created,
        status: 'in_progress',
        owner: 'worker-1',
        leaseOwner: 'worker-1',
        claimedAt: '2020-01-01T00:00:00.000Z',
        leaseExpiresAt: '2020-01-01T00:00:00.000Z',
      });

      (manager as any).releaseExpiredLeases();

      const storedAfterRelease = manager.get(created.id) as any;
      expect(storedAfterRelease.status).toBe('pending');
      expect(storedAfterRelease.owner).toBeUndefined();
      expect(storedAfterRelease.leaseOwner).toBeUndefined();

      const reclaimed = (manager as any).claimNext('worker-2');
      const storedAfterReclaim = manager.get(created.id) as any;

      expect(reclaimed?.id ?? reclaimed?.task?.id).toBe(created.id);
      expect(storedAfterReclaim.owner).toBe('worker-2');
      expect(storedAfterReclaim.status).toBe('in_progress');
    } finally {
      cleanup();
    }
  });

  it('非 owner heartbeat 会报错', () => {
    const { manager, taskDir, cleanup } = makeHarness();

    try {
      const created = manager.create('subject-4', 'description-4');
      writeTaskFile(taskDir, created.id, {
        ...created,
        status: 'in_progress',
        owner: 'worker-1',
        leaseOwner: 'worker-1',
        claimedAt: '2020-01-01T00:00:00.000Z',
        leaseExpiresAt: '2099-01-01T00:00:00.000Z',
      });

      expect(() => (manager as any).heartbeat(created.id, 'worker-2', 60_000)).toThrow(/owner|lease/i);
      expect((manager.get(created.id) as any).leaseOwner).toBe('worker-1');
    } finally {
      cleanup();
    }
  });

  it('blockedBy 未完成的任务不可 claim', () => {
    const { manager, cleanup } = makeHarness();

    try {
      const blocker = manager.create('blocker', 'blocker task');
      const blocked = manager.create('blocked', 'blocked task');
      manager.update(blocked.id, { addBlockedBy: [blocker.id] });

      const firstClaim = (manager as any).claimNext('worker-1');
      const secondClaim = (manager as any).claimNext('worker-2');

      expect(firstClaim?.id ?? firstClaim?.task?.id).toBe(blocker.id);
      expect(secondClaim == null).toBe(true);
      expect((manager.get(blocked.id) as any).status).toBe('pending');
      expect((manager.get(blocked.id) as any).blockedBy).toEqual([blocker.id]);
    } finally {
      cleanup();
    }
  });

  it('deleted 任务不可 claim', () => {
    const { manager, taskDir, cleanup } = makeHarness();

    try {
      const created = manager.create('subject-6', 'description-6');
      manager.update(created.id, { status: 'deleted' });

      const claimed = (manager as any).claimNext('worker-1');

      expect(claimed == null).toBe(true);
      expect(existsSync(taskPath(taskDir, created.id))).toBe(false);
    } finally {
      cleanup();
    }
  });
});
