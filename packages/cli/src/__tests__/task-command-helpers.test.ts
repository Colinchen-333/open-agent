import { describe, expect, it } from 'bun:test';
import {
  buildBackgroundAgentListEntries,
  buildTaskInspection,
  formatTaskInspectionForDisplay,
  listBackgroundTasksForDisplay,
} from '../task-command-helpers.js';

describe('listBackgroundTasksForDisplay', () => {
  it('formats background task rows', () => {
    const result = listBackgroundTasksForDisplay({
      tasks: [
        {
          task_id: 'bg_1',
          type: 'bash',
          status: 'running',
          summary: 'Run tests',
          session_id: 'session-1',
        },
        {
          task_id: 'agent-1',
          type: 'agent',
          status: 'completed',
          summary: 'Review finished',
        },
      ],
    });

    expect(result.tasks).toHaveLength(2);
    expect(result.output).toContain('bg_1 | bash | running | Run tests');
    expect(result.output).toContain('agent-1 | agent | completed | Review finished');
  });

  it('filters by session id for bash tasks', () => {
    const result = listBackgroundTasksForDisplay({
      sessionId: 'session-1',
      tasks: [
        {
          task_id: 'bg_keep',
          type: 'bash',
          status: 'running',
          summary: 'Keep me',
          session_id: 'session-1',
        },
        {
          task_id: 'bg_skip',
          type: 'bash',
          status: 'completed',
          summary: 'Skip me',
          session_id: 'session-2',
        },
      ],
    });

    expect(result.tasks).toHaveLength(1);
    expect(result.output).toContain('bg_keep');
    expect(result.output).not.toContain('bg_skip');
  });

  it('supports all-session view and shows log path', () => {
    const result = listBackgroundTasksForDisplay({
      sessionFilter: 'all',
      tasks: [
        {
          task_id: 'bg_all_1',
          type: 'bash',
          status: 'completed',
          summary: 'Build done',
          session_id: 'session-1',
          output_file: '/tmp/bg_all_1.log',
        },
        {
          task_id: 'bg_all_2',
          type: 'bash',
          status: 'running',
          summary: 'Deploy',
          session_id: 'session-2',
        },
      ],
    });

    expect(result.tasks).toHaveLength(2);
    expect(result.output).toContain('logs=/tmp/bg_all_1.log');
    expect(result.output).toContain('session=session-2');
  });
});

describe('buildBackgroundAgentListEntries', () => {
  it('maps agent info into task rows', () => {
    const entries = buildBackgroundAgentListEntries([
      {
        task_id: 'agent-123',
        info: {
          status: 'running',
          output_file: '/tmp/agent.out',
          description: 'Research worker',
          summary: 'Scanning repo',
        },
      },
    ]);

    expect(entries).toEqual([
      {
        task_id: 'agent-123',
        type: 'agent',
        status: 'running',
        output_file: '/tmp/agent.out',
        summary: 'Scanning repo',
      },
    ]);
  });
});

describe('buildTaskInspection + formatTaskInspectionForDisplay', () => {
  it('builds normalized inspection from task output payload', () => {
    const inspection = buildTaskInspection(JSON.stringify({
      task_id: 'bg_logs_1',
      type: 'bash',
      status: 'completed',
      state: 'completed',
      output: 'line 1\nline 2',
      durationMs: 1234,
      output_file: '/tmp/bg_logs_1.log',
      metadata: {
        summary: 'Task done',
        session_id: 'session-a',
        command: 'bun test',
        start_time: 1700000000000,
      },
    }));

    expect(inspection).not.toBeNull();
    expect(inspection?.task_id).toBe('bg_logs_1');
    expect(inspection?.summary).toBe('Task done');
    expect(inspection?.output_file).toBe('/tmp/bg_logs_1.log');
    expect(inspection?.output_preview).toContain('line 1');
    expect(inspection?.session_id).toBe('session-a');
  });

  it('formats logs view with summary and log file path', () => {
    const inspection = buildTaskInspection(JSON.stringify({
      task_id: 'bg_logs_2',
      type: 'bash',
      status: 'running',
      output: 'streaming output',
      output_file: '/tmp/bg_logs_2.log',
      metadata: {
        summary: 'Still running',
      },
    }));

    const output = formatTaskInspectionForDisplay(inspection!, { view: 'logs' });
    expect(output).toContain('Task logs: bg_logs_2');
    expect(output).toContain('Summary: Still running');
    expect(output).toContain('Log file: /tmp/bg_logs_2.log');
    expect(output).toContain('Output preview:');
  });
});
