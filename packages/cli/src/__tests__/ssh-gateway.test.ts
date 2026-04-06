import { describe, expect, test } from 'bun:test';
import { parseSshTarget, buildSshCommand } from '../ssh-gateway';

describe('parseSshTarget', () => {
  test('simple host', () => {
    const result = parseSshTarget('example.com');
    expect(result.host).toBe('example.com');
    expect(result.user).toBeUndefined();
    expect(result.port).toBeUndefined();
  });

  test('user@host', () => {
    const result = parseSshTarget('deploy@server.io');
    expect(result.user).toBe('deploy');
    expect(result.host).toBe('server.io');
  });

  test('host:port', () => {
    const result = parseSshTarget('server.io:2222');
    expect(result.host).toBe('server.io');
    expect(result.port).toBe(2222);
  });

  test('user@host:port', () => {
    const result = parseSshTarget('root@prod.example.com:22');
    expect(result.user).toBe('root');
    expect(result.host).toBe('prod.example.com');
    expect(result.port).toBe(22);
  });
});

describe('buildSshCommand', () => {
  test('basic command', () => {
    const cmd = buildSshCommand({ host: 'server.io' });
    expect(cmd[0]).toBe('ssh');
    expect(cmd).toContain('server.io');
    expect(cmd[cmd.length - 1]).toContain('open-agent');
  });

  test('with user and port', () => {
    const cmd = buildSshCommand({ host: 'server.io', user: 'deploy', port: 2222 });
    expect(cmd).toContain('-p');
    expect(cmd).toContain('2222');
    expect(cmd).toContain('deploy@server.io');
  });

  test('with remote dir', () => {
    const cmd = buildSshCommand({ host: 'server.io', remoteDir: '/home/user/project' });
    const remoteCmd = cmd[cmd.length - 1]!;
    expect(remoteCmd).toContain('cd /home/user/project');
  });

  test('with identity file', () => {
    const cmd = buildSshCommand({ host: 's', identityFile: '~/.ssh/deploy_key' });
    expect(cmd).toContain('-i');
    expect(cmd).toContain('~/.ssh/deploy_key');
  });

  test('with permission mode', () => {
    const cmd = buildSshCommand({ host: 's', permissionMode: 'bypassPermissions' });
    expect(cmd[cmd.length - 1]).toContain('--permission-mode bypassPermissions');
  });
});
