import { describe, expect, test } from 'bun:test';
import { HOOK_EVENTS, type HookEvent, type HookInput, type PreToolUseHookInput } from '../events';

describe('hook events', () => {
  test('has 27 event types', () => {
    expect(HOOK_EVENTS).toHaveLength(27);
  });

  test('includes all critical events', () => {
    expect(HOOK_EVENTS).toContain('PreToolUse');
    expect(HOOK_EVENTS).toContain('PostToolUse');
    expect(HOOK_EVENTS).toContain('SessionStart');
    expect(HOOK_EVENTS).toContain('SessionEnd');
    expect(HOOK_EVENTS).toContain('SubagentStart');
    expect(HOOK_EVENTS).toContain('PermissionRequest');
    expect(HOOK_EVENTS).toContain('TaskCreated');
    expect(HOOK_EVENTS).toContain('ConfigChange');
    expect(HOOK_EVENTS).toContain('FileChanged');
  });

  test('PreToolUseHookInput has required fields', () => {
    const input: PreToolUseHookInput = {
      event: 'PreToolUse',
      sessionId: 's1',
      cwd: '/work',
      timestamp: new Date().toISOString(),
      toolName: 'Bash',
      toolInput: { command: 'ls' },
      toolUseId: 'tu-1',
    };
    expect(input.event).toBe('PreToolUse');
    expect(input.toolName).toBe('Bash');
  });

  test('HookEvent type covers all events', () => {
    const event: HookEvent = 'PreToolUse';
    expect(HOOK_EVENTS.includes(event)).toBe(true);
  });

  test('no duplicate events', () => {
    const unique = new Set(HOOK_EVENTS);
    expect(unique.size).toBe(HOOK_EVENTS.length);
  });
});
