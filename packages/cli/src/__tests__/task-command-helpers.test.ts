import { describe, expect, it } from 'bun:test';
import {
  buildBackgroundAgentListEntries,
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
