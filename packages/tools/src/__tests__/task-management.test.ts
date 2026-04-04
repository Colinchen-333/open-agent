import { beforeEach, describe, expect, it } from 'bun:test';
import { getBackgroundTaskRegistry, registerBackgroundTask } from '../background-registry.js';
import { createTaskOutputTool, createTaskStopTool } from '../task-management.js';

const ctx = {
  cwd: '/tmp/project',
  sessionId: 'session-1',
};

beforeEach(() => {
  getBackgroundTaskRegistry().clear();
});

describe('TaskOutput', () => {
  it('reads bash background task metadata from the shared registry', async () => {
    const startedAt = Date.now() - 1500;
    registerBackgroundTask({
      task_id: 'bg_abc123',
      command: 'npm test',
      summary: 'Run npm test',
      session_id: 'session-1',
      output: 'ok',
      status: 'completed',
      start_time: startedAt,
    });

    const tool = createTaskOutputTool();
    const raw = await tool.execute({ task_id: 'bg_abc123', block: false }, ctx as any);
    const result = JSON.parse(raw);

    expect(result.type).toBe('bash');
    expect(result.status).toBe('completed');
    expect(result.output).toBe('ok');
    expect(result.metadata.task_id).toBe('bg_abc123');
    expect(result.metadata.command).toBe('npm test');
    expect(result.metadata.summary).toBe('Run npm test');
    expect(result.metadata.session_id).toBe('session-1');
    expect(result.metadata.start_time).toBe(startedAt);
    expect(result.durationMs).toBeGreaterThanOrEqual(1000);
  });

  it('returns task_progress envelope for running background agents', async () => {
    const tool = createTaskOutputTool({
      getBackgroundAgent: () => ({
        status: 'running',
        output_file: '/tmp/agent.output',
        team_name: 'alpha-team',
        description: 'Exploring codebase',
        usage: {
          total_tokens: 0,
          tool_uses: 3,
          duration_ms: 1200,
        },
      }),
    });

    const raw = await tool.execute({ task_id: 'agent-1', block: false }, ctx as any);
    const result = JSON.parse(raw);

    expect(result.status).toBe('running');
    expect(result.state).toBe('running');
    expect(result.team_name).toBe('alpha-team');
    expect(result.task_event.subtype).toBe('task_progress');
    expect(result.task_event.team_name).toBe('alpha-team');
    expect(result.task_event.description).toBe('Exploring codebase');
    expect(result.task_event.usage.tool_uses).toBe(3);
  });

  it('returns task_notification envelope for completed background agents', async () => {
    const tool = createTaskOutputTool({
      getBackgroundAgent: () => ({
        status: 'completed',
        output_file: '/tmp/agent.output',
        team_name: 'alpha-team',
        result: 'Finished implementing runtime alignment.',
        usage: {
          total_tokens: 1200,
          tool_uses: 4,
          duration_ms: 2400,
        },
      }),
    });

    const raw = await tool.execute({ task_id: 'agent-2', block: false }, ctx as any);
    const result = JSON.parse(raw);

    expect(result.status).toBe('completed');
    expect(result.team_name).toBe('alpha-team');
    expect(result.task_event.subtype).toBe('task_notification');
    expect(result.task_event.status).toBe('completed');
    expect(result.task_event.team_name).toBe('alpha-team');
    expect(result.task_event.summary).toContain('Finished implementing runtime alignment');
    expect(result.task_event.orchestration_templates.verification_prompt_template).toContain('Claims to verify');
    expect(result.orchestration_templates.verification_prompt_template).toContain('Claims to verify');
    expect(result.content[0].text).toContain('Finished implementing runtime alignment');
  });
});

describe('TaskStop', () => {
  it('stops running bash tasks and updates shared registry state', async () => {
    let killed = false;
    registerBackgroundTask({
      task_id: 'bg_stop_1',
      command: 'npm run watch',
      summary: 'Run watch task',
      session_id: 'session-1',
      output: 'watching',
      status: 'running',
      process: {
        kill() {
          killed = true;
        },
      },
      start_time: Date.now(),
    });

    const tool = createTaskStopTool();
    const raw = await tool.execute({ task_id: 'bg_stop_1' }, ctx as any);
    const result = JSON.parse(raw);
    const record = getBackgroundTaskRegistry().get('bg_stop_1');

    expect(killed).toBe(true);
    expect(result.success).toBe(true);
    expect(result.type).toBe('bash');
    expect(record?.status).toBe('stopped');
    expect(record?.output).toContain('[Task stopped by user]');
    expect(record?.summary).toContain('Stopped:');
  });

  it('returns stopped status for background agents', async () => {
    const tool = createTaskStopTool({
      stopBackgroundAgent: () => true,
    });

    const raw = await tool.execute({ task_id: 'agent-3' }, ctx as any);
    const result = JSON.parse(raw);

    expect(result.success).toBe(true);
    expect(result.status).toBe('stopped');
    expect(result.state).toBe('stopped');
  });
});
