import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createBashTool } from '../bash.js';

describe('Bash tool', () => {
  let tmpDir: string;
  let tool: ReturnType<typeof createBashTool>;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'open-agent-bash-test-'));
    tool = createBashTool();
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const makeCtx = (cwd?: string) => ({
    cwd: cwd ?? tmpDir,
    sessionId: 'test-bash',
  });

  // ---------------------------------------------------------------------------
  // Basic execution
  // ---------------------------------------------------------------------------

  it('executes a simple echo command and returns its output', async () => {
    const result = await tool.execute({ command: 'echo "hello"' }, makeCtx());
    expect(result).toContain('hello');
  });

  it('returns stdout from a multi-line command', async () => {
    const result = await tool.execute(
      { command: 'echo "first" && echo "second"' },
      makeCtx(),
    );
    expect(result).toContain('first');
    expect(result).toContain('second');
  });

  // ---------------------------------------------------------------------------
  // Exit codes
  // ---------------------------------------------------------------------------

  it('does not append exit code info when exit code is 0', async () => {
    // A successful command — exit code is 0, so no "(exit code: ...)" suffix.
    const result = await tool.execute({ command: 'echo "success"' }, makeCtx()) as string;
    expect(result).not.toContain('exit code');
    expect(result).toContain('success');
  });

  it('includes exit code in output when command exits non-zero', async () => {
    // The bash tool wraps commands as: cd "..." && CMD ; echo SENTINEL ; pwd
    // Using a plain `false` or `exit 1` results in exit code 0 because the
    // sentinel chain (echo + pwd) runs via `;` and pwd exits 0.
    // `set -e` causes bash to abort on the first failure, preventing the
    // sentinel from running and preserving the non-zero exit code.
    const result = await tool.execute(
      { command: 'set -e; false' },
      makeCtx(),
    ) as string;
    expect(result).toContain('exit code');
    expect(result).toContain('1');
  });

  it('includes the non-zero exit code number in the output', async () => {
    const result = await tool.execute(
      { command: 'set -e; exit 42' },
      makeCtx(),
    ) as string;
    expect(result).toContain('42');
  });

  // ---------------------------------------------------------------------------
  // Timeout
  // ---------------------------------------------------------------------------

  it('terminates a command that exceeds the timeout and notes interruption', async () => {
    // Use a CPU-bound infinite loop instead of sleep — sleep survives proc.kill()
    // because the signal doesn't propagate through bash, but a busy-loop in bash
    // itself is killed immediately when the process group is terminated.
    const start = Date.now();
    const result = await tool.execute(
      { command: 'while true; do :; done', timeout: 200 },
      makeCtx(),
    ) as string;
    const elapsed = Date.now() - start;

    // Should finish quickly (within 2 seconds), not run indefinitely.
    expect(elapsed).toBeLessThan(2000);

    // The result must mention interruption.
    expect(result).toContain('command timed out and was killed');
  }, 5_000);

  // ---------------------------------------------------------------------------
  // Persistent CWD
  // ---------------------------------------------------------------------------

  it('persists cwd change across consecutive calls on the same tool instance', async () => {
    // Change into tmpDir then ask pwd in a follow-up command.
    // Both calls use the same `tool` instance which maintains persistentCwd state.
    await tool.execute({ command: `cd "${tmpDir}"` }, makeCtx('/'));

    const result = await tool.execute({ command: 'pwd' }, makeCtx('/')) as string;
    expect(result.trim()).toContain(tmpDir);
  });

  // ---------------------------------------------------------------------------
  // Output truncation
  // ---------------------------------------------------------------------------

  it('truncates output that exceeds 30 000 characters', async () => {
    // Generate a large output: print 31 000 'x' characters.
    const result = await tool.execute(
      { command: "python3 -c \"print('x' * 31000)\"" },
      makeCtx(),
    ) as string;

    expect(result).toContain('[Output truncated');
    expect(result.length).toBeLessThan(35_000); // truncated + note is still bounded
  });

  // ---------------------------------------------------------------------------
  // Stderr handling
  // ---------------------------------------------------------------------------

  it('includes stderr when there is no stdout output', async () => {
    const result = await tool.execute(
      { command: 'echo "err output" >&2' },
      makeCtx(),
    ) as string;
    expect(result).toContain('err output');
  });

  // ---------------------------------------------------------------------------
  // No output
  // ---------------------------------------------------------------------------

  it('returns "(no output)" when command produces nothing', async () => {
    const result = await tool.execute({ command: 'true' }, makeCtx()) as string;
    // `true` exits 0 with no stdout/stderr
    expect(result).toBe('(no output)');
  });
});
