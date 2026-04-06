import { describe, expect, test } from 'bun:test';
import { findCommand, EXTENDED_COMMANDS, type CommandContext } from '../commands/index';

const ctx: CommandContext = { cwd: '/tmp', sessionId: 'test', model: 'gpt-4o', permissionMode: 'default' };

describe('extended commands', () => {
  test('has 12+ commands registered', () => {
    expect(EXTENDED_COMMANDS.length).toBeGreaterThanOrEqual(12);
  });

  test('findCommand by name', () => {
    expect(findCommand('cost')).not.toBeNull();
    expect(findCommand('status')).not.toBeNull();
    expect(findCommand('diff')).not.toBeNull();
  });

  test('findCommand by alias', () => {
    expect(findCommand('settings')).not.toBeNull();
    expect(findCommand('perms')).not.toBeNull();
    expect(findCommand('model')).not.toBeNull();
  });

  test('findCommand returns null for unknown', () => {
    expect(findCommand('nonexistent')).toBeNull();
  });

  test('cost command executes', async () => {
    const result = await findCommand('cost')!.execute('', ctx);
    expect(result.output).toContain('test');
  });

  test('status command shows platform info', async () => {
    const result = await findCommand('status')!.execute('', ctx);
    expect(result.output).toContain(process.platform);
  });

  test('config command shows current config', async () => {
    const result = await findCommand('config')!.execute('', ctx);
    expect(result.output).toContain('/tmp');
  });

  test('version command runs', async () => {
    const result = await findCommand('version')!.execute('', ctx);
    expect(result.output).toContain('open-agent');
  });

  test('clear command writes escape code', async () => {
    const result = await findCommand('clear')!.execute('', ctx);
    expect(result.output).toBe('');
  });

  test('all commands have name and description', () => {
    for (const cmd of EXTENDED_COMMANDS) {
      expect(cmd.name).toBeTruthy();
      expect(cmd.description).toBeTruthy();
    }
  });
});
