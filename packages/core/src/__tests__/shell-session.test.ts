import { describe, expect, test, afterEach } from 'bun:test';
import { ShellSessionPool } from '../shell-session';

describe('ShellSessionPool', () => {
  let pool: ShellSessionPool;

  afterEach(async () => {
    if (pool) await pool.destroyAll();
  });

  test('exec runs command and returns result', async () => {
    pool = new ShellSessionPool({ cwd: '/tmp' });
    const result = await pool.exec('echo hello');
    expect(result.stdout.trim()).toBe('hello');
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.durationMs).toBeGreaterThan(0);
  });

  test('exec captures stderr', async () => {
    pool = new ShellSessionPool({ cwd: '/tmp' });
    const result = await pool.exec('echo err >&2');
    expect(result.stderr.trim()).toBe('err');
  });

  test('exec returns non-zero exit code', async () => {
    pool = new ShellSessionPool({ cwd: '/tmp' });
    const result = await pool.exec('exit 42');
    expect(result.exitCode).toBe(42);
  });

  test('exec respects timeout', async () => {
    pool = new ShellSessionPool({ cwd: '/tmp' });
    const result = await pool.exec('sleep 10', { timeout: 500 });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(124);
  });

  test('create and list sessions', async () => {
    pool = new ShellSessionPool({ cwd: '/tmp' });
    await pool.create();
    await pool.create();
    expect(pool.list()).toHaveLength(2);
  });

  test('destroy removes session', async () => {
    pool = new ShellSessionPool({ cwd: '/tmp' });
    const s = await pool.create();
    await pool.destroy(s.id);
    expect(pool.get(s.id)).toBeNull();
  });

  test('stats reports counts', async () => {
    pool = new ShellSessionPool({ cwd: '/tmp' });
    await pool.create();
    const stats = pool.stats();
    expect(stats.total).toBe(1);
  });
});
