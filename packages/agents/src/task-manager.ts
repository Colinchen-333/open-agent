import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { TaskItem } from './types';

export class TaskManager {
  private baseDir: string;
  private nextId = 1;

  constructor(teamName: string) {
    this.baseDir = join(homedir(), '.open-agent', 'tasks', teamName);
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
  ): TaskItem {
    const task: TaskItem = {
      id: String(this.nextId++),
      subject,
      description,
      status: 'pending',
      activeForm,
      blocks: [],
      blockedBy: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata,
    };

    writeFileSync(join(this.baseDir, `${task.id}.json`), JSON.stringify(task, null, 2));
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
    if (updates.activeForm !== undefined) task.activeForm = updates.activeForm;
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

    if (updates.status === 'deleted') {
      // Remove the file and return the final state without persisting
      try {
        unlinkSync(join(this.baseDir, `${id}.json`));
      } catch {
        // File may already be absent; that's fine
      }
      return task;
    }

    writeFileSync(join(this.baseDir, `${id}.json`), JSON.stringify(task, null, 2));
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
  listAvailable(): TaskItem[] {
    return this.listAll().filter(t => {
      if (t.status !== 'pending') return false;
      if (t.owner) return false;
      if (!t.blockedBy || t.blockedBy.length === 0) return true;

      return t.blockedBy.every(bid => {
        const blocker = this.get(bid);
        return blocker?.status === 'completed' || blocker?.status === 'deleted';
      });
    });
  }
}
