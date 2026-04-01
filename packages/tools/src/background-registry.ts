import {
  loadPersistedBackgroundTask,
  savePersistedBackgroundTask,
  type PersistedBackgroundTaskStatus,
} from './background-task-store.js';

export type BackgroundTaskStatus = PersistedBackgroundTaskStatus;

export interface BackgroundTaskRecord {
  task_id: string;
  status: BackgroundTaskStatus;
  start_time: number;
  command: string;
  summary: string;
  session_id: string;
  cwd?: string;
  process?: any;
  output: string;
  output_file?: string;
  pid?: number;
  completed_time?: number;
  /**
   * Backward-compatible alias used by existing callers.
   * Keep in sync with `start_time`.
   */
  startTime: number;
}

export interface RegisterBackgroundTaskInput {
  task_id: string;
  command: string;
  summary: string;
  session_id: string;
  cwd?: string;
  process?: any;
  output?: string;
  status?: BackgroundTaskStatus;
  start_time?: number;
  output_file?: string;
  pid?: number;
  completed_time?: number;
}

const registry = new Map<string, BackgroundTaskRecord>();

function normalizeStartTime(startTime?: number): number {
  return Number.isFinite(startTime) ? (startTime as number) : Date.now();
}

export function registerBackgroundTask(input: RegisterBackgroundTaskInput): BackgroundTaskRecord {
  const startTime = normalizeStartTime(input.start_time);
  const record: BackgroundTaskRecord = {
    task_id: input.task_id,
    status: input.status ?? 'running',
    start_time: startTime,
    command: input.command,
    summary: input.summary,
    session_id: input.session_id,
    cwd: input.cwd,
    process: input.process,
    output: input.output ?? '',
    output_file: input.output_file,
    pid: input.pid,
    completed_time: input.completed_time,
    startTime,
  };
  registry.set(record.task_id, record);
  persistRecord(record);
  return record;
}

export function getBackgroundTask(taskId: string): BackgroundTaskRecord | undefined {
  const inMemory = registry.get(taskId);
  if (inMemory) {
    return inMemory;
  }
  const persisted = loadPersistedBackgroundTask(taskId);
  if (!persisted) {
    return undefined;
  }
  const restored: BackgroundTaskRecord = {
    task_id: persisted.taskId,
    status: persisted.status,
    start_time: persisted.startTime,
    command: persisted.command,
    summary: persisted.summary ?? persisted.error ?? persisted.status,
    session_id: persisted.sessionId,
    cwd: persisted.cwd,
    output: '',
    output_file: persisted.outputFile,
    pid: persisted.pid,
    completed_time: persisted.completedAt,
    startTime: persisted.startTime,
  };
  registry.set(taskId, restored);
  return restored;
}

export function updateBackgroundTask(
  taskId: string,
  patch: Partial<Omit<BackgroundTaskRecord, 'task_id'>>,
): BackgroundTaskRecord | undefined {
  const current = registry.get(taskId);
  if (!current) return undefined;

  const nextStartTime = patch.start_time ?? patch.startTime ?? current.start_time;
  const next: BackgroundTaskRecord = {
    ...current,
    ...patch,
    task_id: taskId,
    start_time: nextStartTime,
    startTime: nextStartTime,
  };
  registry.set(taskId, next);
  persistRecord(next);
  return next;
}

export function deleteBackgroundTask(taskId: string): boolean {
  return registry.delete(taskId);
}

export function getBackgroundTaskRegistry(): Map<string, BackgroundTaskRecord> {
  return registry;
}

function persistRecord(record: BackgroundTaskRecord): void {
  savePersistedBackgroundTask({
    taskId: record.task_id,
    kind: 'bash',
    sessionId: record.session_id,
    command: record.command,
    cwd: record.cwd ?? '',
    summary: record.summary,
    status: record.status,
    startTime: record.start_time,
    outputFile: record.output_file ?? '',
    pid: record.pid,
    completedAt: record.completed_time,
    error: record.status === 'error' ? record.summary : undefined,
  });
}
