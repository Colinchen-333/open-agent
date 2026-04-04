import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export type PersistedBackgroundTaskStatus = 'running' | 'completed' | 'error' | 'stopped';

export interface PersistedBackgroundTask {
  taskId: string;
  kind: 'bash';
  sessionId: string;
  command: string;
  cwd: string;
  summary?: string;
  status: PersistedBackgroundTaskStatus;
  startTime: number;
  outputFile: string;
  pid?: number;
  completedAt?: number;
  exitCode?: number | null;
  error?: string;
}

function getBaseDir(): string {
  const dir = join(homedir(), '.open-agent', 'background-tasks');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function getBackgroundTaskOutputFile(taskId: string): string {
  return join(getBaseDir(), `${taskId}.log`);
}

function getMetadataFile(taskId: string): string {
  return join(getBaseDir(), `${taskId}.json`);
}

export function savePersistedBackgroundTask(task: PersistedBackgroundTask): void {
  writeFileSync(getMetadataFile(task.taskId), JSON.stringify(task, null, 2), 'utf-8');
}

export function loadPersistedBackgroundTask(taskId: string): PersistedBackgroundTask | null {
  const file = getMetadataFile(taskId);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as PersistedBackgroundTask;
  } catch {
    return null;
  }
}

export function updatePersistedBackgroundTask(
  taskId: string,
  updates: Partial<PersistedBackgroundTask>,
): PersistedBackgroundTask | null {
  const current = loadPersistedBackgroundTask(taskId);
  if (!current) return null;
  const next = {
    ...current,
    ...updates,
  };
  savePersistedBackgroundTask(next);
  return next;
}

export function listPersistedBackgroundTasks(): PersistedBackgroundTask[] {
  return readdirSync(getBaseDir())
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => loadPersistedBackgroundTask(entry.replace(/\.json$/, '')))
    .filter((task): task is PersistedBackgroundTask => task !== null)
    .sort((left, right) => right.startTime - left.startTime);
}

export function isPidRunning(pid?: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
