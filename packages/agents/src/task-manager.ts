import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';
import type { TaskItem } from './types';

interface TaskManagerOptions {
  rootDir?: string;
}

interface ClaimTaskOptions {
  leaseMs?: number;
  now?: Date;
}

const DEFAULT_LEASE_MS = 5 * 60 * 1000;
const TASK_LOCK_TTL_MS = 30_000;
const TASK_LOCK_MAX_ATTEMPTS = 8;

export class TaskManager {
  private baseDir: string;
  private nextId = 1;

  constructor(teamName: string, options: TaskManagerOptions = {}) {
    this.baseDir = join(options.rootDir ?? join(homedir(), '.open-agent', 'tasks'), teamName);
    mkdirSync(this.baseDir, { recursive: true });
    // Determine next available ID from existing tasks
    const existing = this.listAll();
    if (existing.length > 0) {
      this.nextId = Math.max(...existing.map(t => parseInt(t.id, 10))) + 1;
    }
  }

  create(
    subject: string,
    description: string,
    activeForm?: string,
    metadata?: Record<string, unknown>,
    priority = 0,
  ): TaskItem {
    const now = new Date().toISOString();
    const task: TaskItem = {
      id: String(this.nextId++),
      subject,
      description,
      status: 'pending',
      priority,
      attempts: 0,
      activeForm,
      blocks: [],
      blockedBy: [],
      createdAt: now,
      updatedAt: now,
      metadata,
    };

    this.persistTask(task);
    return task;
  }

  get(id: string): TaskItem | null {
    const path = join(this.baseDir, `${id}.json`);
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf-8'));
  }

  update(
    id: string,
    updates: Partial<TaskItem> & {
      addBlocks?: string[];
      addBlockedBy?: string[];
    },
  ): TaskItem {
    const updated = this.mutateTask(id, (task) => {
      if (updates.subject !== undefined) task.subject = updates.subject;
      if (updates.description !== undefined) task.description = updates.description;
      if (updates.status !== undefined) task.status = updates.status;
      if (updates.owner !== undefined) task.owner = updates.owner;
      if (updates.priority !== undefined) task.priority = updates.priority;
      if (updates.activeForm !== undefined) task.activeForm = updates.activeForm;
      if (updates.lease !== undefined) task.lease = updates.lease;
      if (updates.metadata !== undefined) {
        task.metadata = { ...task.metadata, ...updates.metadata };
      }

      if (updates.addBlocks) {
        task.blocks = [...new Set([...(task.blocks ?? []), ...updates.addBlocks])];
      }
      if (updates.addBlockedBy) {
        task.blockedBy = [...new Set([...(task.blockedBy ?? []), ...updates.addBlockedBy])];
      }

      task.updatedAt = new Date().toISOString();

      if (task.status !== 'in_progress') {
        delete task.lease;
      }
      if (task.status === 'pending' && updates.owner === undefined) {
        delete task.owner;
      }

      if (updates.status === 'deleted') {
        return {
          result: task,
          deleteTask: true,
        };
      }

      return {
        result: task,
        nextTask: task,
      };
    });
    if (!updated) throw new Error(`Task ${id} not found`);
    return updated;
  }

  listAll(): TaskItem[] {
    if (!existsSync(this.baseDir)) return [];
    return readdirSync(this.baseDir)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        try {
          return JSON.parse(readFileSync(join(this.baseDir, f), 'utf-8')) as TaskItem;
        } catch {
          return null;
        }
      })
      .filter((t): t is TaskItem => t !== null)
      .sort((a, b) => parseInt(a.id, 10) - parseInt(b.id, 10));
  }

  // Return tasks that are pending, unowned, and not blocked by any incomplete task
  listAvailable(now = new Date()): TaskItem[] {
    this.releaseExpiredLeases(now);

    return this.listAll().filter(t => {
      if (!this.isClaimableStatus(t, now)) return false;
      if (!t.blockedBy || t.blockedBy.length === 0) return true;

      return t.blockedBy.every(bid => {
        const blocker = this.get(bid);
        return blocker?.status === 'completed' || blocker?.status === 'deleted';
      });
    }).sort((left, right) =>
      (right.priority ?? 0) - (left.priority ?? 0)
      || left.createdAt.localeCompare(right.createdAt)
      || parseInt(left.id, 10) - parseInt(right.id, 10));
  }

  claimNext(owner: string, options: ClaimTaskOptions = {}): TaskItem | null {
    const now = options.now ?? new Date();
    for (const candidate of this.listAvailable(now)) {
      const claimed = this.mutateTask(candidate.id, (task) => {
        if (!this.isClaimableTask(task, now)) {
          return { result: null };
        }

        const attempts = (task.attempts ?? 0) + 1;
        task.status = 'in_progress';
        task.owner = owner;
        task.attempts = attempts;
        task.lease = {
          owner,
          claimedAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + (options.leaseMs ?? DEFAULT_LEASE_MS)).toISOString(),
          attempts,
        };
        task.updatedAt = now.toISOString();
        return {
          result: task,
          nextTask: task,
        };
      });
      if (claimed) {
        return claimed;
      }
    }
    return null;
  }

  renewLease(id: string, owner: string, options: ClaimTaskOptions = {}): TaskItem {
    const now = options.now ?? new Date();
    const renewed = this.mutateTask(id, (task) => {
      if (task.lease?.owner !== owner) {
        throw new Error(`Task ${id} is not leased by ${owner}`);
      }
      if (!this.hasActiveLease(task, now)) {
        throw new Error(`Task ${id} lease has expired`);
      }

      task.status = 'in_progress';
      task.owner = owner;
      task.lease = {
        owner,
        claimedAt: task.lease.claimedAt,
        expiresAt: new Date(now.getTime() + (options.leaseMs ?? DEFAULT_LEASE_MS)).toISOString(),
        attempts: task.lease.attempts,
      };
      task.updatedAt = now.toISOString();
      return {
        result: task,
        nextTask: task,
      };
    });
    if (!renewed) throw new Error(`Task ${id} not found`);
    return renewed;
  }

  heartbeat(id: string, owner: string, extendMs = DEFAULT_LEASE_MS, now = new Date()): TaskItem {
    return this.renewLease(id, owner, { leaseMs: extendMs, now });
  }

  releaseLease(id: string, owner: string, status: 'pending' | 'completed' = 'pending'): TaskItem {
    const released = this.mutateTask(id, (task) => {
      if (task.lease?.owner !== owner) {
        throw new Error(`Task ${id} is not leased by ${owner}`);
      }

      task.status = status;
      task.updatedAt = new Date().toISOString();
      delete task.lease;
      if (status === 'pending') {
        delete task.owner;
      } else {
        task.owner = owner;
      }
      return {
        result: task,
        nextTask: task,
      };
    });
    if (!released) throw new Error(`Task ${id} not found`);
    return released;
  }

  releaseExpiredLeases(now = new Date()): TaskItem[] {
    const released: TaskItem[] = [];

    for (const task of this.listAll()) {
      if (!task.lease || this.hasActiveLease(task, now) || task.status === 'deleted') {
        continue;
      }
      const releasedTask = this.mutateTask(task.id, (latest) => {
        if (!latest.lease || this.hasActiveLease(latest, now) || latest.status === 'deleted') {
          return { result: null };
        }

        const nextTask: TaskItem = {
          ...latest,
          status: latest.status === 'completed' ? 'completed' : 'pending',
          updatedAt: now.toISOString(),
        };
        if (nextTask.lease && nextTask.owner === nextTask.lease.owner) {
          delete nextTask.owner;
        }
        return {
          result: nextTask,
          nextTask,
        };
      });
      if (releasedTask) {
        released.push(releasedTask);
      }
    }

    return released;
  }

  private isClaimableStatus(task: TaskItem, now: Date): boolean {
    if (task.status === 'pending') {
      return !task.owner && !this.hasActiveLease(task, now);
    }
    if (task.status === 'in_progress') {
      return !this.hasActiveLease(task, now);
    }
    return false;
  }

  private hasActiveLease(task: TaskItem, now: Date): boolean {
    if (!task.lease?.expiresAt) return false;
    const expiresAt = Date.parse(task.lease.expiresAt);
    if (Number.isNaN(expiresAt)) return false;
    return expiresAt > now.getTime();
  }

  private persistTask(task: TaskItem): void {
    writeFileSync(join(this.baseDir, `${task.id}.json`), JSON.stringify(task, null, 2));
  }

  private isClaimableTask(task: TaskItem, now: Date): boolean {
    if (!this.isClaimableStatus(task, now)) return false;
    if (!task.blockedBy || task.blockedBy.length === 0) return true;
    return task.blockedBy.every((bid) => {
      const blocker = this.get(bid);
      return blocker?.status === 'completed' || blocker?.status === 'deleted';
    });
  }

  private mutateTask<T>(
    id: string,
    mutate: (
      task: TaskItem,
    ) => {
      result: T;
      nextTask?: TaskItem;
      deleteTask?: boolean;
    },
  ): T | null {
    return this.withTaskLock(id, (path) => {
      if (!existsSync(path)) {
        return null;
      }

      const task = JSON.parse(readFileSync(path, 'utf-8')) as TaskItem;
      const outcome = mutate(task);
      if (outcome.deleteTask) {
        unlinkSync(path);
        return outcome.result;
      }
      if (outcome.nextTask) {
        this.persistTask(outcome.nextTask);
      }
      return outcome.result;
    });
  }

  private withTaskLock<T>(id: string, fn: (path: string) => T): T | null {
    const taskPath = join(this.baseDir, `${id}.json`);
    const lockPath = this.acquireTaskLock(id);
    if (!lockPath) {
      return null;
    }
    try {
      return fn(taskPath);
    } finally {
      try {
        unlinkSync(lockPath);
      } catch {
        // Ignore best-effort lock cleanup failures.
      }
    }
  }

  private acquireTaskLock(id: string): string | null {
    const lockPath = join(this.baseDir, `.${id}.lock`);
    const payload = JSON.stringify({
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
      token: randomUUID(),
    });

    for (let attempt = 0; attempt < TASK_LOCK_MAX_ATTEMPTS; attempt += 1) {
      try {
        writeFileSync(lockPath, payload, { flag: 'wx' });
        return lockPath;
      } catch {
        if (!existsSync(lockPath)) {
          continue;
        }
        try {
          const stat = statSync(lockPath);
          if (Date.now() - stat.mtimeMs > TASK_LOCK_TTL_MS) {
            unlinkSync(lockPath);
            continue;
          }
        } catch {
          continue;
        }
      }
    }

    return null;
  }
}
