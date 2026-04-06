import { describe, expect, test } from 'bun:test';
import { withCamelCaseAliases } from '../camel-case-compat';

describe('withCamelCaseAliases', () => {
  test('adds camelCase aliases for base fields', () => {
    const input = {
      hook_event_name: 'PreToolUse',
      session_id: 'sess-1',
      transcript_path: '/tmp/t',
      cwd: '/work',
      permission_mode: 'default',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      tool_use_id: 'tu-1',
    } as any;
    const result = withCamelCaseAliases(input);

    // camelCase aliases present
    expect(result.hookEvent).toBe('PreToolUse');
    expect(result.sessionId).toBe('sess-1');
    expect(result.transcriptPath).toBe('/tmp/t');
    expect(result.permissionMode).toBe('default');
    expect(result.toolName).toBe('Bash');
    expect(result.toolUse).toEqual({ id: 'tu-1', input: { command: 'ls' } });
    expect(result.toolUseId).toBe('tu-1');

    // snake_case originals preserved
    expect(result.hook_event_name).toBe('PreToolUse');
    expect(result.session_id).toBe('sess-1');
    expect(result.tool_name).toBe('Bash');
    expect(result.tool_input).toEqual({ command: 'ls' });
    expect(result.tool_use_id).toBe('tu-1');
  });

  test('adds agent-related camelCase aliases', () => {
    const input = {
      hook_event_name: 'SubagentStart',
      session_id: 's',
      transcript_path: '/t',
      cwd: '/',
      agent_id: 'a1',
      agent_type: 'explore',
    } as any;
    const result = withCamelCaseAliases(input);

    expect(result.agentId).toBe('a1');
    expect(result.agentType).toBe('explore');
    // snake_case preserved
    expect(result.agent_id).toBe('a1');
    expect(result.agent_type).toBe('explore');
  });

  test('handles events without tool fields', () => {
    const input = {
      hook_event_name: 'SessionStart',
      session_id: 's',
      transcript_path: '/t',
      cwd: '/',
      source: 'startup',
    } as any;
    const result = withCamelCaseAliases(input);

    expect(result.hookEvent).toBe('SessionStart');
    expect(result.sessionId).toBe('s');
    expect(result.toolName).toBeUndefined();
    expect(result.toolUse).toBeUndefined();
  });

  test('adds SubagentStop camelCase aliases', () => {
    const input = {
      hook_event_name: 'SubagentStop',
      session_id: 's',
      transcript_path: '/t',
      cwd: '/',
      agent_id: 'a2',
      agent_type: 'worker',
      agent_transcript_path: '/tmp/agent.jsonl',
      stop_hook_active: false,
      last_assistant_message: 'done',
    } as any;
    const result = withCamelCaseAliases(input);

    expect(result.agentId).toBe('a2');
    expect(result.agentType).toBe('worker');
    expect(result.agentTranscriptPath).toBe('/tmp/agent.jsonl');
    expect(result.stopHookActive).toBe(false);
    expect(result.lastAssistantMessage).toBe('done');
    // originals preserved
    expect(result.agent_transcript_path).toBe('/tmp/agent.jsonl');
    expect(result.stop_hook_active).toBe(false);
  });

  test('adds Notification camelCase aliases', () => {
    const input = {
      hook_event_name: 'Notification',
      session_id: 's',
      transcript_path: '/t',
      cwd: '/',
      message: 'hello',
      notification_type: 'info',
    } as any;
    const result = withCamelCaseAliases(input);

    expect(result.notificationType).toBe('info');
    expect(result.notification_type).toBe('info');
  });

  test('adds TaskCompleted camelCase aliases', () => {
    const input = {
      hook_event_name: 'TaskCompleted',
      session_id: 's',
      transcript_path: '/t',
      cwd: '/',
      task_id: 't1',
      task_subject: 'Fix bug',
      task_description: 'desc',
      teammate_name: 'alice',
      team_name: 'eng',
    } as any;
    const result = withCamelCaseAliases(input);

    expect(result.taskId).toBe('t1');
    expect(result.taskSubject).toBe('Fix bug');
    expect(result.taskDescription).toBe('desc');
    expect(result.teammateName).toBe('alice');
    expect(result.teamName).toBe('eng');
    // originals preserved
    expect(result.task_id).toBe('t1');
    expect(result.team_name).toBe('eng');
  });

  test('adds WorktreeRemove camelCase aliases', () => {
    const input = {
      hook_event_name: 'WorktreeRemove',
      session_id: 's',
      transcript_path: '/t',
      cwd: '/',
      worktree_path: '/tmp/wt',
    } as any;
    const result = withCamelCaseAliases(input);

    expect(result.worktreePath).toBe('/tmp/wt');
    expect(result.worktree_path).toBe('/tmp/wt');
  });

  test('adds PostToolUse toolResponse camelCase alias', () => {
    const input = {
      hook_event_name: 'PostToolUse',
      session_id: 's',
      transcript_path: '/t',
      cwd: '/',
      tool_name: 'Read',
      tool_input: { file_path: '/etc/hosts' },
      tool_response: { content: '127.0.0.1 localhost' },
      tool_use_id: 'use-2',
    } as any;
    const result = withCamelCaseAliases(input);

    expect(result.toolResponse).toEqual({ content: '127.0.0.1 localhost' });
    expect(result.tool_response).toEqual({ content: '127.0.0.1 localhost' });
    expect(result.toolUse).toEqual({ id: 'use-2', input: { file_path: '/etc/hosts' } });
  });
});
