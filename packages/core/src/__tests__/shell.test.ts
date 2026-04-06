import { describe, expect, test } from 'bun:test';
import {
  shellExec,
  shellExecChain,
  getDefaultShell,
  getShellBinary,
  buildShellArgs,
  detectSandboxMode,
  type ShellConfig,
} from '../shell';

const defaultConfig: ShellConfig = { mode: 'sh', cwd: '/tmp' };

describe('shell utilities', () => {
  test('getDefaultShell returns valid mode', () => {
    const mode = getDefaultShell();
    expect(['bash', 'sh', 'zsh', 'powershell']).toContain(mode);
  });

  test('getShellBinary returns path', () => {
    expect(getShellBinary('bash')).toBe('/bin/bash');
    expect(getShellBinary('sh')).toBe('/bin/sh');
  });

  test('buildShellArgs for bash', () => {
    const args = buildShellArgs('bash', 'echo hi');
    expect(args).toEqual(['/bin/bash', '-c', 'echo hi']);
  });

  test('buildShellArgs for powershell', () => {
    const args = buildShellArgs('powershell', 'echo hi');
    const binary = getShellBinary('powershell');
    expect(args).toEqual([binary, '-NoProfile', '-NonInteractive', '-Command', 'echo hi']);
  });

  test('detectSandboxMode returns platform-appropriate mode', () => {
    const mode = detectSandboxMode();
    if (process.platform === 'darwin') expect(mode).toBe('darwin-seatbelt');
    else if (process.platform === 'linux') expect(mode).toBe('linux-bwrap');
    else expect(mode).toBe('none');
  });
});

describe('shellExec', () => {
  test('runs command and captures stdout', async () => {
    const result = await shellExec('echo hello', defaultConfig);
    expect(result.stdout.trim()).toBe('hello');
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  test('captures stderr', async () => {
    const result = await shellExec('echo err >&2', defaultConfig);
    expect(result.stderr.trim()).toBe('err');
  });

  test('returns non-zero exit code', async () => {
    const result = await shellExec('exit 42', defaultConfig);
    expect(result.exitCode).toBe(42);
  });

  test('respects timeout', async () => {
    const result = await shellExec('sleep 10', { ...defaultConfig, timeoutMs: 500 });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(124);
  }, 10_000);

  test('measures duration', async () => {
    const result = await shellExec('echo fast', defaultConfig);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  test('truncates large output', async () => {
    const result = await shellExec('yes | head -100000', { ...defaultConfig, maxOutputBytes: 1000 });
    expect(result.truncated).toBe(true);
    expect(result.stdout).toContain('truncated');
  });

  test('tracks raw output bytes', async () => {
    const result = await shellExec('echo hello', defaultConfig);
    expect(result.rawOutputBytes).toBeGreaterThan(0);
  });

  test('calls signal handler on output', async () => {
    let captured = '';
    await shellExec('echo callback', defaultConfig, {
      onOutput: (chunk) => { captured += chunk; },
    });
    expect(captured).toContain('callback');
  });

  test('calls signal handler onExit', async () => {
    let exitCode = -1;
    await shellExec('exit 7', defaultConfig, {
      onExit: (code) => { exitCode = code; },
    });
    expect(exitCode).toBe(7);
  });

  test('no signal field on normal exit', async () => {
    const result = await shellExec('echo ok', defaultConfig);
    expect(result.signal).toBeUndefined();
  });

  test('uses custom env', async () => {
    const result = await shellExec('echo $MY_VAR', {
      ...defaultConfig,
      env: { MY_VAR: 'custom_value' },
    });
    expect(result.stdout.trim()).toBe('custom_value');
  });
});

describe('shellExecChain', () => {
  test('runs all commands on success', async () => {
    const { results, allSucceeded } = await shellExecChain(
      ['echo a', 'echo b', 'echo c'],
      defaultConfig,
    );
    expect(allSucceeded).toBe(true);
    expect(results).toHaveLength(3);
  });

  test('stops on first failure', async () => {
    const { results, allSucceeded } = await shellExecChain(
      ['echo ok', 'exit 1', 'echo never'],
      defaultConfig,
    );
    expect(allSucceeded).toBe(false);
    expect(results).toHaveLength(2);
  });

  test('empty command list succeeds', async () => {
    const { results, allSucceeded } = await shellExecChain([], defaultConfig);
    expect(allSucceeded).toBe(true);
    expect(results).toHaveLength(0);
  });
});
