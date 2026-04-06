import { describe, expect, test } from 'bun:test';
import { buildMissedTaskNotification, connectRemoteControl } from '../daemon';
import type { CronTask } from '../sdk-types-complete';

describe('buildMissedTaskNotification', () => {
  test('empty returns empty string', () => {
    expect(buildMissedTaskNotification([])).toBe('');
  });

  test('single task formats correctly', () => {
    const tasks: CronTask[] = [
      { id: 't1', cron: '*', prompt: 'check status', createdAt: 0 },
    ];
    const result = buildMissedTaskNotification(tasks);
    expect(result).toContain('1 scheduled task');
    expect(result).not.toContain('tasks');
    expect(result).toContain('check status');
    expect(result).toContain('t1');
  });

  test('multiple tasks formats correctly', () => {
    const tasks: CronTask[] = [
      { id: 't1', cron: '*', prompt: 'task one', createdAt: 0 },
      { id: 't2', cron: '*', prompt: 'task two', createdAt: 0 },
    ];
    const result = buildMissedTaskNotification(tasks);
    expect(result).toContain('2 scheduled tasks');
    expect(result).toContain('task one');
    expect(result).toContain('task two');
  });

  test('long prompts are truncated', () => {
    const longPrompt = 'x'.repeat(200);
    const tasks: CronTask[] = [
      { id: 't1', cron: '*', prompt: longPrompt, createdAt: 0 },
    ];
    const result = buildMissedTaskNotification(tasks);
    expect(result).toContain('...');
    expect(result.length).toBeLessThan(longPrompt.length + 200);
  });

  test('numbered list is sequential', () => {
    const tasks: CronTask[] = [
      { id: 'a', cron: '*', prompt: 'first', createdAt: 0 },
      { id: 'b', cron: '*', prompt: 'second', createdAt: 0 },
      { id: 'c', cron: '*', prompt: 'third', createdAt: 0 },
    ];
    const result = buildMissedTaskNotification(tasks);
    expect(result).toContain('1. [a]');
    expect(result).toContain('2. [b]');
    expect(result).toContain('3. [c]');
  });
});

describe('connectRemoteControl', () => {
  test('throws stub error', async () => {
    await expect(
      connectRemoteControl({
        dir: '/work',
        getAccessToken: () => 'token',
        baseUrl: 'https://api.claude.ai',
        orgUUID: 'org',
        model: 'sonnet',
      }),
    ).rejects.toThrow('stub');
  });
});
