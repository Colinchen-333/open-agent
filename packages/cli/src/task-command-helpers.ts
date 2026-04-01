import type { BackgroundAgentInfo } from '@open-agent/tools';

export interface BackgroundTaskListEntry {
  task_id: string;
  type: 'bash' | 'agent';
  status: string;
  summary: string;
  session_id?: string;
  cwd?: string;
  output_file?: string;
  command?: string;
  started_at?: number;
}

export interface ListBackgroundTasksOptions {
  tasks: BackgroundTaskListEntry[];
  sessionId?: string;
  limit?: number;
}

export interface ListBackgroundTasksResult {
  tasks: BackgroundTaskListEntry[];
  output: string;
}

export interface BackgroundAgentListEntry {
  task_id: string;
  info: BackgroundAgentInfo;
}

export function listBackgroundTasksForDisplay(options: ListBackgroundTasksOptions): ListBackgroundTasksResult {
  const limit = Math.max(1, options.limit ?? 20);
  const filtered = options.sessionId
    ? options.tasks.filter((task) => task.session_id === options.sessionId || task.type === 'agent')
    : options.tasks;
  const visible = filtered.slice(0, limit);

  if (visible.length === 0) {
    return { tasks: [], output: 'No background tasks found.' };
  }

  const lines = visible.map((task, index) => {
    const bits = [
      `${index + 1}. ${task.task_id}`,
      task.type,
      task.status,
    ];
    if (task.summary) bits.push(task.summary);
    return `  ${bits.join(' | ')}`;
  });

  const more = filtered.length > visible.length
    ? `\nShowing ${visible.length}/${filtered.length}.`
    : '';

  return {
    tasks: visible,
    output: `Background tasks (${filtered.length}):\n${lines.join('\n')}${more}`,
  };
}

export function buildBackgroundAgentListEntries(entries: BackgroundAgentListEntry[]): BackgroundTaskListEntry[] {
  return entries.map(({ task_id, info }) => ({
    task_id,
    type: 'agent',
    status: info.status,
    summary: info.summary ?? info.description ?? info.status,
    output_file: info.output_file,
  }));
}
