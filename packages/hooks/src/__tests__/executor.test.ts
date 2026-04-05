import { describe, expect, it } from 'bun:test';
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
