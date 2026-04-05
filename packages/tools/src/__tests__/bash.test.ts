import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createBashTool } from '../bash.js';
import { createTaskOutputTool } from '../task-management.js';
import { BASH_SANDBOX_POLICY_FIELD, buildBashSandboxPolicy } from '../../../permissions/src/sandbox-adapter.js';

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

  const makeStatefulCtx = (cwd?: string) => {
    const state: any = {
      runtime: {
        diagnostics: [],
      },
    };
    return {
      cwd: cwd ?? tmpDir,
      sessionId: 'test-bash',
      getAppState: () => state,
      setAppState: (updater: (prev: any) => any) => {
        Object.assign(state, updater(state));
      },
      get diagnostics() {
        return state.runtime.diagnostics as Array<Record<string, unknown>>;
      },
    };
  };

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

  it('supports background execution with retrievable output', async () => {
    const started = await tool.execute(
      { command: 'echo "background hello"', run_in_background: true },
      makeCtx(),
    );
    const match = String(started).match(/id:\s*(bg_[^\)\s]+)/i);
    expect(match).not.toBeNull();

    const outputTool = createTaskOutputTool();
    const raw = await outputTool.execute({
      task_id: match![1],
      block: true,
      timeout: 5000,
    }, makeCtx() as any);
    const result = JSON.parse(raw);

    expect(result.type).toBe('bash');
    expect(['running', 'completed']).toContain(result.status);
    expect(result.output).toContain('background hello');
    expect(typeof result.output_file).toBe('string');
  });

  it('records sandbox provenance into app state for successful execution', async () => {
    const ctx = makeStatefulCtx();

    const result = await tool.execute({ command: 'echo "sandbox provenance"' }, ctx as any);

    expect(result).toContain('sandbox provenance');
    expect(ctx.diagnostics.length).toBeGreaterThanOrEqual(2);

    const started = ctx.diagnostics[0];
    const finished = ctx.diagnostics[ctx.diagnostics.length - 1];
    expect(started).toEqual(expect.objectContaining({
      code: 'bash_sandbox_execution',
      severity: 'info',
      source: 'runtime',
      payload: expect.objectContaining({
        outcome: 'started',
        provenance: expect.objectContaining({
          command: 'echo "sandbox provenance"',
          runInBackground: false,
          wrappedWithSandboxExec: false,
        }),
      }),
    }));
    expect(finished).toEqual(expect.objectContaining({
      code: 'bash_sandbox_execution',
      payload: expect.objectContaining({
        outcome: 'success',
        provenance: expect.objectContaining({
          command: 'echo "sandbox provenance"',
          runInBackground: false,
        }),
      }),
    }));
  });

  it('surfaces structured sandbox execution data on preflight block', async () => {
    const ctx = makeStatefulCtx();
    const policy = buildBashSandboxPolicy({
      sandbox: {
        enabled: true,
        filesystem: {
          allowWrite: [join(tmpDir, 'allowed')],
        },
      },
      cwd: tmpDir,
    });

    let error: any;
    try {
      await tool.execute({
        command: 'echo "blocked" > ./blocked.txt',
        [BASH_SANDBOX_POLICY_FIELD]: policy,
      }, ctx as any);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect(error.sandboxViolation).toEqual(expect.objectContaining({
      phase: 'preflight',
      code: 'write_outside_allowed_paths',
      feature: 'writePaths',
    }));
    expect(error.sandboxExecution?.outcome).toBe('blocked');
    expect(error.sandboxExecution?.findings[0]).toEqual(expect.objectContaining({
      stage: 'preflight',
      scope: 'filesystem',
      code: 'write_outside_allowed_paths',
      severity: 'error',
    }));
    expect(error.sandboxExecution?.provenance).toEqual(expect.objectContaining({
      command: 'echo "blocked" > ./blocked.txt',
      runInBackground: false,
      boundaryKind: expect.any(String),
    }));
    expect(ctx.diagnostics[0]).toEqual(expect.objectContaining({
      code: 'bash_sandbox_execution',
      severity: 'error',
      payload: expect.objectContaining({
        outcome: 'blocked',
      }),
    }));
  });

  it('blocks denyRead targets at preflight and records read-path provenance', async () => {
    const ctx = makeStatefulCtx();
    const blockedDir = join(tmpDir, 'blocked-read');
    const blockedFile = join(blockedDir, 'secret.txt');
    rmSync(blockedDir, { recursive: true, force: true });
    mkdirSync(blockedDir, { recursive: true });
    writeFileSync(blockedFile, 'top-secret', 'utf-8');

    const policy = buildBashSandboxPolicy({
      sandbox: {
        enabled: true,
        filesystem: {
          denyRead: [blockedDir],
        },
      },
      cwd: tmpDir,
    });

    let error: any;
    try {
      await tool.execute({
        command: `cat "${blockedFile}"`,
        [BASH_SANDBOX_POLICY_FIELD]: policy,
      }, ctx as any);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect(error.sandboxViolation).toEqual(expect.objectContaining({
      phase: 'preflight',
      code: 'read_denied',
      feature: 'readPaths',
      target: blockedFile,
    }));
    expect(error.sandboxExecution?.provenance).toEqual(expect.objectContaining({
      preflightEnforcedFeatures: expect.arrayContaining(['readPaths']),
      enforcedFeatures: expect.objectContaining({ readPaths: false }),
    }));
    expect(ctx.diagnostics[0]).toEqual(expect.objectContaining({
      code: 'bash_sandbox_execution',
      severity: 'error',
      payload: expect.objectContaining({
        outcome: 'blocked',
      }),
    }));
  });
});
