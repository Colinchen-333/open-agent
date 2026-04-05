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

export type BackgroundTaskSessionFilter = 'all' | string;

export interface ListBackgroundTasksOptions {
  tasks: BackgroundTaskListEntry[];
  sessionId?: string;
  sessionFilter?: BackgroundTaskSessionFilter;
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

export interface BackgroundTaskInspection {
  task_id: string;
  type: 'bash' | 'agent' | 'unknown';
  status: string;
  state?: string;
  summary: string;
  output_preview?: string;
  output_file?: string;
  session_id?: string;
  command?: string;
  started_at?: number;
  duration_ms?: number;
}

export interface FormatTaskInspectionOptions {
  view?: 'inspect' | 'logs' | 'attach';
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  if (!record) return undefined;
  return normalizeString(record[key]);
}

function readNumber(record: Record<string, unknown> | undefined, key: string): number | undefined {
  if (!record) return undefined;
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function summarizeText(value?: string): string {
  const normalized = normalizeString(value);
  if (!normalized) return 'No summary available.';
  const singleLine = normalized.replace(/\s+/g, ' ');
  return singleLine.length > 180 ? `${singleLine.slice(0, 179)}…` : singleLine;
}

function buildOutputPreview(value?: string): string | undefined {
  const normalized = normalizeString(value);
  if (!normalized) return undefined;
  return normalized.length > 1200 ? `${normalized.slice(0, 1199)}…` : normalized;
}

function getContentText(content: unknown): string | undefined {
  if (!Array.isArray(content) || content.length === 0) return undefined;
  const first = asRecord(content[0]);
  return readString(first, 'text');
}

export function listBackgroundTasksForDisplay(options: ListBackgroundTasksOptions): ListBackgroundTasksResult {
  const limit = Math.max(1, options.limit ?? 20);
  const effectiveSessionFilter = options.sessionFilter ?? (options.sessionId ? options.sessionId : 'all');
  const filtered = effectiveSessionFilter === 'all'
    ? options.tasks
    : options.tasks.filter((task) => {
      if (task.type === 'agent' && !task.session_id) return true;
      return task.session_id === effectiveSessionFilter;
    });
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
    if (task.session_id) bits.push(`session=${task.session_id}`);
    if (task.output_file) bits.push(`logs=${task.output_file}`);
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
  return entries.map(({ task_id, info }) => {
    const extraInfo = info as unknown as Record<string, unknown>;
    const sessionId = readString(extraInfo, 'session_id');
    const command = readString(extraInfo, 'command');
    const startedAt = readNumber(extraInfo, 'started_at');
    return {
      task_id,
      type: 'agent',
      status: info.status,
      summary: info.summary ?? info.description ?? info.status,
      output_file: info.output_file,
      ...(sessionId ? { session_id: sessionId } : {}),
      ...(command ? { command } : {}),
      ...(typeof startedAt === 'number' ? { started_at: startedAt } : {}),
    };
  });
}

export function buildTaskInspection(
  payload: string | Record<string, unknown>,
  fallbackTaskId?: string,
): BackgroundTaskInspection | null {
  const rawRecord = typeof payload === 'string'
    ? (() => {
      const trimmed = payload.trim();
      if (!trimmed || trimmed.startsWith('Error: No task found')) return undefined;
      try {
        return JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        const summary = summarizeText(trimmed);
        return {
          task_id: fallbackTaskId ?? 'unknown',
          type: 'unknown',
          status: 'unknown',
          summary,
          output_preview: buildOutputPreview(trimmed),
        } as Record<string, unknown>;
      }
    })()
    : payload;

  const record = asRecord(rawRecord);
  if (!record) return null;

  const metadata = asRecord(record.metadata);
  const usage = asRecord(record.usage);

  const taskId = readString(record, 'task_id') ?? fallbackTaskId ?? 'unknown';
  const typeValue = readString(record, 'type');
  const type = typeValue === 'bash' || typeValue === 'agent' ? typeValue : 'unknown';
  const status = readString(record, 'status') ?? readString(record, 'state') ?? 'unknown';
  const state = readString(record, 'state');
  const output = readString(record, 'output') ?? readString(record, 'result') ?? getContentText(record.content);
  const outputPreview = buildOutputPreview(output);
  const summary = readString(metadata, 'summary')
    ?? readString(record, 'summary')
    ?? summarizeText(output);
  const outputFile = readString(record, 'output_file');
  const sessionId = readString(metadata, 'session_id') ?? readString(record, 'session_id');
  const command = readString(metadata, 'command') ?? readString(record, 'command');
  const startedAt = readNumber(metadata, 'start_time') ?? readNumber(record, 'started_at');
  const durationMs = readNumber(record, 'durationMs') ?? readNumber(record, 'duration_ms') ?? readNumber(usage, 'duration_ms');

  return {
    task_id: taskId,
    type,
    status,
    ...(state ? { state } : {}),
    summary,
    ...(outputPreview ? { output_preview: outputPreview } : {}),
    ...(outputFile ? { output_file: outputFile } : {}),
    ...(sessionId ? { session_id: sessionId } : {}),
    ...(command ? { command } : {}),
    ...(typeof startedAt === 'number' ? { started_at: startedAt } : {}),
    ...(typeof durationMs === 'number' ? { duration_ms: durationMs } : {}),
  };
}

export function formatTaskInspectionForDisplay(
  inspection: BackgroundTaskInspection,
  options?: FormatTaskInspectionOptions,
): string {
  const view = options?.view ?? 'inspect';
  const title = view === 'logs'
    ? `Task logs: ${inspection.task_id}`
    : view === 'attach'
      ? `Task attach: ${inspection.task_id}`
      : `Task: ${inspection.task_id}`;
  const lines = [
    title,
    `Type: ${inspection.type}`,
    `Status: ${inspection.status}${inspection.state ? ` (state=${inspection.state})` : ''}`,
    `Summary: ${inspection.summary}`,
    ...(inspection.session_id ? [`Session: ${inspection.session_id}`] : []),
    ...(inspection.command ? [`Command: ${inspection.command}`] : []),
    ...(typeof inspection.started_at === 'number' ? [`Started at(ms): ${inspection.started_at}`] : []),
    ...(typeof inspection.duration_ms === 'number' ? [`Duration(ms): ${inspection.duration_ms}`] : []),
    ...(inspection.output_file ? [`Log file: ${inspection.output_file}`] : []),
  ];

  if (inspection.output_preview) {
    lines.push('');
    lines.push(view === 'logs' ? 'Output preview:' : 'Latest output:');
    lines.push(inspection.output_preview);
  }

  return lines.join('\n');
}
