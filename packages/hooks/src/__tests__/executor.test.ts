import { describe, expect, it, test } from 'bun:test';
import { HookExecutor } from '../executor.js';

function makePreToolInput() {
  return {
    hook_event_name: 'PreToolUse' as const,
    session_id: 'session-1',
    transcript_path: '/tmp/session-1.jsonl',
    cwd: '/tmp',
    permission_mode: 'default',
    tool_name: 'Read',
    tool_input: { file_path: '/tmp/file.txt' },
    tool_use_id: 'tool-use-1',
  };
}

describe('HookExecutor', () => {
  it('reports effective hook surface across shell and callback registrations', () => {
    const executor = new HookExecutor();

    executor.loadFromConfig({
      Notification: [{
        command: `printf '%s' '{"continue":true}'`,
      }],
    }, 'settings_json');
    executor.registerCallbackHook('Notification', {
      hooks: [async () => ({ continue: true })],
    });

    expect(executor.getHookSurface()).toEqual([{
      event: 'Notification',
      count: 2,
      sources: ['callback', 'settings_json'],
    }]);
  });

  it('replaces shell hooks for one source without dropping other sources', async () => {
    const executor = new HookExecutor();

    executor.loadFromConfig({
      PreToolUse: [{
        command: `printf '%s' '{"continue":true,"additionalContext":"settings-v1"}'`,
      }],
    }, 'settings');
    executor.loadFromConfig({
      PreToolUse: [{
        command: `printf '%s' '{"continue":true,"additionalContext":"project"}'`,
      }],
    }, 'project');

    const before = await executor.execute('PreToolUse', makePreToolInput(), 'tool-use-1');
    expect(before.additionalContext).toContain('settings-v1');
    expect(before.additionalContext).toContain('project');

    executor.replaceShellHooksFromConfig({
      PreToolUse: [{
        command: `printf '%s' '{"continue":true,"additionalContext":"settings-v2"}'`,
      }],
    }, 'settings');

    const after = await executor.execute('PreToolUse', makePreToolInput(), 'tool-use-1');
    expect(after.additionalContext).toContain('settings-v2');
    expect(after.additionalContext).toContain('project');
    expect(after.additionalContext).not.toContain('settings-v1');
  });
});

test('async hook does not block tool execution', async () => {
  const startedAt = Date.now();
  const executor = new HookExecutor();
  executor.loadFromConfig({
    PreToolUse: [{
      command: "sleep 0.5 && echo '{\"continue\": true}'",
      asyncTimeout: 30, // fire-and-forget mode
    }],
  });
  const result = await executor.execute('PreToolUse', {
    session_id: 'x',
    transcript_path: '',
    cwd: '/',
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: {},
    tool_use_id: 't1',
  });
  const elapsed = Date.now() - startedAt;
  expect(elapsed).toBeLessThan(200); // fire-and-forget: returns quickly
  expect(result.continue).toBeTruthy();
});

test('shell hook receives stdin JSON with all HookInput fields', async () => {
  const executor = new HookExecutor();
  // This script reads stdin, saves it, then echoes a valid HookOutput.
  const script = `cat > /tmp/hook-stdin-capture.json && echo '{"continue": true, "additionalContext": "ok"}'`;
  executor.loadFromConfig({
    PreToolUse: [{ command: script, timeout: 5 }],
  });
  await executor.execute('PreToolUse', {
    session_id: 'sess-1',
    transcript_path: '/tmp/t',
    cwd: '/cwd',
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'ls' },
    tool_use_id: 'use-1',
  });
  const captured = JSON.parse(require('node:fs').readFileSync('/tmp/hook-stdin-capture.json', 'utf8'));
  expect(captured.session_id).toBe('sess-1');
  expect(captured.hook_event_name).toBe('PreToolUse');
  expect(captured.tool_name).toBe('Bash');
  expect(captured.tool_input).toEqual({ command: 'ls' });
  expect(captured.tool_use_id).toBe('use-1');
});
