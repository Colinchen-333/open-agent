import { describe, expect, test, afterEach } from 'bun:test';
import { BashPtySession } from '../bash-pty.js';

describe('BashPtySession', () => {
  const sessions: BashPtySession[] = [];

  afterEach(async () => {
    // Clean up any sessions created during tests
    for (const sess of sessions) {
      await sess.close().catch(() => {});
    }
    sessions.length = 0;
  });

  function makeSession(opts?: { cwd?: string }): BashPtySession {
    const sess = new BashPtySession({ cwd: opts?.cwd ?? '/tmp' });
    sessions.push(sess);
    return sess;
  }

  test('preserves cwd across commands in the same session', async () => {
    const sess = makeSession();
    await sess.exec('mkdir -p /tmp/oa-pty-test && cd /tmp/oa-pty-test');
    const result = await sess.exec('pwd');
    expect(result.stdout.trim()).toBe('/tmp/oa-pty-test');
  });

  test('preserves env variables across commands', async () => {
    const sess = makeSession();
    await sess.exec('export OA_FOO=bar');
    const result = await sess.exec('echo $OA_FOO');
    expect(result.stdout.trim()).toBe('bar');
  });

  test('times out long commands', async () => {
    const sess = makeSession();
    await expect(sess.exec('sleep 5', { timeout: 500 })).rejects.toThrow(/timeout/i);
  });

  test('returns exit code 0 for successful commands', async () => {
    const sess = makeSession();
    const result = await sess.exec('true');
    expect(result.exitCode).toBe(0);
  });

  test('returns non-zero exit code for failing commands', async () => {
    const sess = makeSession();
    const result = await sess.exec('false');
    expect(result.exitCode).not.toBe(0);
  });

  test('captures stdout output', async () => {
    const sess = makeSession();
    const result = await sess.exec('echo "hello pty"');
    expect(result.stdout).toContain('hello pty');
  });

  test('preserves shell functions across commands', async () => {
    const sess = makeSession();
    await sess.exec('greet() { echo "hi $1"; }');
    const result = await sess.exec('greet world');
    expect(result.stdout.trim()).toBe('hi world');
  });
});
