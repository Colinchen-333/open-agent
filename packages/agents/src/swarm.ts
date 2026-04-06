/**
 * Swarm dispatcher — coordinates multiple teammate agents working
 * on related tasks under a coordinator.
 */

import { randomUUID } from 'crypto';
import type { TeammateSpec, TeammateStatus, CoordinatorState } from './agent-taxonomy.js';
import { sendMessage, readMessages } from './agent-taxonomy.js';

export interface SwarmConfig {
  teamName: string;
  maxConcurrent: number;
  /** Auto-assign pending tasks to idle teammates */
  autoAssign: boolean;
  /** Timeout per teammate in ms (default: 600000 = 10min) */
  teammateTimeoutMs?: number;
}

export interface SwarmTask {
  id: string;
  spec: TeammateSpec;
  priority: number; // 0 = highest
  status: 'queued' | 'assigned' | 'running' | 'completed' | 'failed' | 'cancelled';
  assignedTo?: string;
  result?: string;
  error?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}

/**
 * Swarm dispatcher manages a pool of tasks and teammates.
 */
export class SwarmDispatcher {
  private tasks = new Map<string, SwarmTask>();
  private teammates = new Map<string, TeammateStatus>();
  private config: SwarmConfig;
  private coordinatorState: CoordinatorState;

  constructor(config: SwarmConfig) {
    this.config = config;
    this.coordinatorState = {
      mode: 'coordinator',
      teamName: config.teamName,
      teammates: [],
      maxConcurrent: config.maxConcurrent,
      autoAssign: config.autoAssign,
    };
  }

  /** Add a task to the queue. */
  addTask(spec: TeammateSpec, priority = 5): SwarmTask {
    const task: SwarmTask = {
      id: `task-${randomUUID().slice(0, 8)}`,
      spec,
      priority,
      status: 'queued',
      createdAt: new Date().toISOString(),
    };
    this.tasks.set(task.id, task);

    if (this.config.autoAssign) {
      this.tryAssign();
    }

    return task;
  }

  /** Register a teammate as available. */
  registerTeammate(name: string, agentId: string): void {
    const status: TeammateStatus = {
      name,
      agentId,
      state: 'pending',
      task: '',
    };
    this.teammates.set(name, status);
    this.coordinatorState.teammates = [...this.teammates.values()];
  }

  /** Try to assign queued tasks to idle teammates. */
  tryAssign(): SwarmTask[] {
    const assigned: SwarmTask[] = [];
    const running = [...this.teammates.values()].filter(t => t.state === 'running').length;
    const available = this.config.maxConcurrent - running;

    if (available <= 0) return assigned;

    // Get idle teammates
    const idle = [...this.teammates.values()].filter(t => t.state === 'pending' || t.state === 'completed');

    // Get queued tasks sorted by priority
    const queued = [...this.tasks.values()]
      .filter(t => t.status === 'queued')
      .sort((a, b) => a.priority - b.priority);

    for (let i = 0; i < Math.min(available, idle.length, queued.length); i++) {
      const task = queued[i]!;
      const teammate = idle[i]!;

      task.status = 'assigned';
      task.assignedTo = teammate.name;
      task.startedAt = new Date().toISOString();

      teammate.state = 'running';
      teammate.task = task.spec.task;
      teammate.startedAt = task.startedAt;

      // Send task to teammate via mailbox
      sendMessage('coordinator', teammate.name, JSON.stringify({
        type: 'task_assignment',
        taskId: task.id,
        task: task.spec.task,
        agentType: task.spec.agentType,
      }));

      assigned.push(task);
    }

    this.coordinatorState.teammates = [...this.teammates.values()];
    return assigned;
  }

  /** Mark a task as completed. */
  completeTask(taskId: string, result: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;

    task.status = 'completed';
    task.result = result;
    task.completedAt = new Date().toISOString();

    if (task.assignedTo) {
      const teammate = this.teammates.get(task.assignedTo);
      if (teammate) {
        teammate.state = 'completed';
        teammate.completedAt = task.completedAt;
        teammate.result = result;
      }
    }

    this.coordinatorState.teammates = [...this.teammates.values()];

    if (this.config.autoAssign) {
      this.tryAssign();
    }
  }

  /** Mark a task as failed. */
  failTask(taskId: string, error: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;

    task.status = 'failed';
    task.error = error;
    task.completedAt = new Date().toISOString();

    if (task.assignedTo) {
      const teammate = this.teammates.get(task.assignedTo);
      if (teammate) {
        teammate.state = 'failed';
        teammate.error = error;
      }
    }

    this.coordinatorState.teammates = [...this.teammates.values()];
  }

  /** Cancel a queued task. */
  cancelTask(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== 'queued') return false;
    task.status = 'cancelled';
    return true;
  }

  /** Get all tasks. */
  getTasks(): SwarmTask[] {
    return [...this.tasks.values()];
  }

  /** Get coordinator state. */
  getState(): CoordinatorState {
    return { ...this.coordinatorState, teammates: [...this.coordinatorState.teammates] };
  }

  /** Get progress summary. */
  getProgress(): { total: number; queued: number; running: number; completed: number; failed: number } {
    let queued = 0, running = 0, completed = 0, failed = 0;
    for (const task of this.tasks.values()) {
      switch (task.status) {
        case 'queued': queued++; break;
        case 'assigned': case 'running': running++; break;
        case 'completed': completed++; break;
        case 'failed': failed++; break;
      }
    }
    return { total: this.tasks.size, queued, running, completed, failed };
  }
}
