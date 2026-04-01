import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { TaskItem } from './types';

interface TaskManagerOptions {
  rootDir?: string;
}

interface ClaimTaskOptions {
  leaseMs?: number;
  now?: Date;
}

const DEFAULT_LEASE_MS = 5 * 60 * 1000;

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
    const task = this.get(id);
    if (!task) throw new Error(`Task ${id} not found`);

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
      // Remove the file and return the final state without persisting
      try {
        unlinkSync(join(this.baseDir, `${id}.json`));
      } catch {
        // File may already be absent; that's fine
      }
      return task;
    }

    this.persistTask(task);
    return task;
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
    const task = this.listAvailable(now)[0];
    if (!task) return null;

    const attempts = (task.lease?.attempts ?? 0) + 1;
    task.status = 'in_progress';
    task.owner = owner;
    task.lease = {
      owner,
      claimedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + (options.leaseMs ?? DEFAULT_LEASE_MS)).toISOString(),
      attempts,
    };
    task.updatedAt = now.toISOString();
    this.persistTask(task);
    return task;
  }

  renewLease(id: string, owner: string, options: ClaimTaskOptions = {}): TaskItem {
    const task = this.get(id);
    if (!task) throw new Error(`Task ${id} not found`);
    if (task.lease?.owner !== owner) {
      throw new Error(`Task ${id} is not leased by ${owner}`);
    }

    const now = options.now ?? new Date();
    task.status = 'in_progress';
    task.owner = owner;
    task.lease = {
      owner,
      claimedAt: task.lease.claimedAt,
      expiresAt: new Date(now.getTime() + (options.leaseMs ?? DEFAULT_LEASE_MS)).toISOString(),
      attempts: task.lease.attempts,
    };
    task.updatedAt = now.toISOString();
    this.persistTask(task);
    return task;
  }

  releaseLease(id: string, owner: string, status: 'pending' | 'completed' = 'pending'): TaskItem {
    const task = this.get(id);
    if (!task) throw new Error(`Task ${id} not found`);
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
    this.persistTask(task);
    return task;
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
}
