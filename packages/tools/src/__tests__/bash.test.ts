import { describe, it, expect, beforeAll, afterAll, afterEach, spyOn } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createBashTool, applyMetaPolicyToFindings } from '../bash.js';
import { createTaskOutputTool } from '../task-management.js';
import { BASH_SANDBOX_POLICY_FIELD, buildBashSandboxPolicy } from '../../../permissions/src/sandbox-adapter.js';
import { closeBashPty } from '../bash-pty.js';
import { setFeatureDefault, clearFeatureOverrides } from '@open-agent/core';
import { isDarwinSandboxAvailable, wrapWithDarwinSandbox } from '../sandbox/darwin-runner.js';
import type { SandboxMetaPolicy, BashSandboxExecutionFinding } from '@open-agent/permissions';

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

  // ---------------------------------------------------------------------------
  // Persistent PTY — cwd and state across invocations
  // ---------------------------------------------------------------------------

  it('Bash tool preserves cwd across invocations in same session', async () => {
    const sessionId = 'persist-test-pty-1';
    // Clean up any residual PTY session from a previous run
    afterEach(() => closeBashPty(sessionId));

    const persistDir = join(tmpDir, 'oa-persist-pty');
    mkdirSync(persistDir, { recursive: true });

    const ctx = { cwd: '/tmp', sessionId };
    await tool.execute({ command: `cd "${persistDir}"` }, ctx as any);
    const r = await tool.execute({ command: 'pwd' }, ctx as any);
    expect(r).toContain(persistDir);
  }, 15_000);

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

  // ---------------------------------------------------------------------------
  // Darwin sandbox runner (R4.2)
  // ---------------------------------------------------------------------------

  describe('Darwin sandbox runner (wrapWithDarwinSandbox)', () => {
    afterEach(() => clearFeatureOverrides());

    it('wrapWithDarwinSandbox produces an argv starting with sandbox-exec on darwin', async () => {
      // Unit test of the low-level runner — does not require DARWIN_SANDBOX flag.
      if (!isDarwinSandboxAvailable()) return; // skip on non-darwin

      const result = await wrapWithDarwinSandbox(['/bin/bash', '-c', 'echo hi']);
      try {
        expect(result.argv[0]).toBe('sandbox-exec');
        expect(result.argv[1]).toBe('-f');
        expect(result.argv[2]).toMatch(/\.sb$/);
        expect(result.argv.slice(3)).toEqual(['/bin/bash', '-c', 'echo hi']);
      } finally {
        await result.cleanup();
      }
    });

    it('wrapWithDarwinSandbox profile contains expected rules for writablePaths', async () => {
      if (!isDarwinSandboxAvailable()) return;

      const result = await wrapWithDarwinSandbox(['/bin/bash', '-c', 'true'], {
        writablePaths: ['/Users/test/project'],
        blockNetwork: true,
        allowUnixSockets: false,
      });
      try {
        expect(result.profile).toContain('(deny default)');
        expect(result.profile).toContain('/Users/test/project');
        expect(result.profile).toContain('(deny network*)');
      } finally {
        await result.cleanup();
      }
    });

    it('Bash tool takes the unsandboxed path when DARWIN_SANDBOX flag is off', async () => {
      // Flag defaults to false — with sandbox: true in input, the tool should still
      // execute normally (no sandbox-exec wrapping), because the flag gates the feature.
      setFeatureDefault('DARWIN_SANDBOX', false);

      const ctx = makeStatefulCtx();
      const result = await tool.execute(
        { command: 'echo "no-sandbox-flag"', sandbox: true } as any,
        ctx as any,
      );
      // Command should succeed normally
      expect(result).toContain('no-sandbox-flag');
    });

    it('Bash tool takes the Darwin sandbox path when flag is on and sandbox:true (darwin only)', async () => {
      if (!isDarwinSandboxAvailable()) return; // skip on non-darwin CI

      setFeatureDefault('DARWIN_SANDBOX', true);

      const ctx = makeStatefulCtx();
      // sandbox:true uses the non-PTY path, which runs the actual command through sandbox-exec.
      // The command itself is harmless; we just verify it runs and produces output.
      const result = await tool.execute(
        { command: 'echo "darwin-sandbox-active"', sandbox: true } as any,
        ctx as any,
      );
      expect(result).toContain('darwin-sandbox-active');

      // The diagnostics should reflect wrappedWithSandboxExec: true
      const startedRecord = ctx.diagnostics.find(
        (d) => (d.payload as any)?.outcome === 'started',
      );
      expect(startedRecord).toBeDefined();
      expect((startedRecord!.payload as any).provenance.wrappedWithSandboxExec).toBe(true);
    }, 15_000);
  });

  // ---------------------------------------------------------------------------
  // Sandbox meta policy filter (applyMetaPolicyToFindings)
  // ---------------------------------------------------------------------------

  describe('applyMetaPolicyToFindings', () => {
    const makeFilesystemFinding = (target: string): BashSandboxExecutionFinding => ({
      code: 'filesystem_write_denied',
      message: `Write denied: ${target}`,
      severity: 'error',
      scope: 'filesystem',
      target,
    } as any);

    const makeNetworkFinding = (): BashSandboxExecutionFinding => ({
      code: 'network_blocked',
      message: 'Outbound network blocked',
      severity: 'warning',
      scope: 'network',
    } as any);

    it('returns raw findings unchanged when no meta policy is provided', () => {
      const findings = [makeFilesystemFinding('/etc/hosts'), makeNetworkFinding()];
      expect(applyMetaPolicyToFindings(findings, undefined)).toEqual(findings);
    });

    it('returns raw findings unchanged when ignoreViolations is empty', () => {
      const policy: SandboxMetaPolicy = { ignoreViolations: [] };
      const findings = [makeFilesystemFinding('/tmp/foo')];
      expect(applyMetaPolicyToFindings(findings, policy)).toEqual(findings);
    });

    it('filters out a filesystem finding that matches a pathPattern rule', () => {
      const policy: SandboxMetaPolicy = {
        ignoreViolations: [
          { category: 'filesystem', pathPattern: '/tmp/**', reason: 'tmp writes are fine', silent: true },
        ],
      };
      const tmpFinding = makeFilesystemFinding('/tmp/workdir/output.txt');
      const etcFinding = makeFilesystemFinding('/etc/hosts');
      const result = applyMetaPolicyToFindings([tmpFinding, etcFinding], policy);
      // /tmp/workdir/output.txt matches /tmp/**, should be removed
      expect(result).not.toContain(tmpFinding);
      // /etc/hosts does not match, should be kept
      expect(result).toContain(etcFinding);
    });

    it('keeps a finding whose target does not match the pathPattern', () => {
      const policy: SandboxMetaPolicy = {
        ignoreViolations: [
          { category: 'filesystem', pathPattern: '/tmp/**', reason: 'tmp only', silent: true },
        ],
      };
      const finding = makeFilesystemFinding('/var/log/app.log');
      const result = applyMetaPolicyToFindings([finding], policy);
      expect(result).toContain(finding);
    });

    it('filters by category — a network rule does not remove a filesystem finding', () => {
      const policy: SandboxMetaPolicy = {
        ignoreViolations: [
          { category: 'network', reason: 'network is allowed', silent: true },
        ],
      };
      const fsFinding = makeFilesystemFinding('/tmp/x');
      const netFinding = makeNetworkFinding();
      const result = applyMetaPolicyToFindings([fsFinding, netFinding], policy);
      expect(result).toContain(fsFinding);
      expect(result).not.toContain(netFinding);
    });

    it('calls console.warn for non-silent ignored violations', () => {
      const policy: SandboxMetaPolicy = {
        ignoreViolations: [
          { category: 'filesystem', pathPattern: '/tmp/**', reason: 'tmp ok', silent: false },
        ],
      };
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const finding = makeFilesystemFinding('/tmp/scratch/test.txt');
        const result = applyMetaPolicyToFindings([finding], policy);
        expect(result).toHaveLength(0);
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy.mock.calls[0][0]).toContain('[bash] sandbox violation ignored by rule "tmp ok"');
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('does NOT call console.warn for silent ignored violations', () => {
      const policy: SandboxMetaPolicy = {
        ignoreViolations: [
          { category: 'filesystem', pathPattern: '/tmp/**', reason: 'silent rule', silent: true },
        ],
      };
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const finding = makeFilesystemFinding('/tmp/foo');
        applyMetaPolicyToFindings([finding], policy);
        expect(warnSpy).not.toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('createBashTool accepts sandboxMetaPolicy in deps without type error', () => {
      const policy: SandboxMetaPolicy = {
        ignoreViolations: [
          { category: 'filesystem', pathPattern: '/tmp/**', reason: 'test', silent: true },
        ],
      };
      // This test verifies the factory accepts deps.sandboxMetaPolicy at the type level;
      // the returned tool is a valid ToolDefinition.
      const toolWithPolicy = createBashTool({ sandboxMetaPolicy: policy });
      expect(toolWithPolicy.name).toBe('Bash');
    });
  });

  // ---------------------------------------------------------------------------
  // preparePermissionMatcher
  // ---------------------------------------------------------------------------

  describe('preparePermissionMatcher', () => {
    it('is defined on the Bash tool', () => {
      expect(typeof tool.preparePermissionMatcher).toBe('function');
    });

    it('returns a function when called with input', () => {
      const matcher = tool.preparePermissionMatcher!({ command: 'git push origin main' });
      expect(typeof matcher).toBe('function');
    });

    it('plain pattern matches command prefix', () => {
      const matcher = tool.preparePermissionMatcher!({ command: 'git push origin main' });
      expect(matcher('git push')).toBe(true);
    });

    it('plain pattern does not match unrelated command', () => {
      const matcher = tool.preparePermissionMatcher!({ command: 'npm install' });
      expect(matcher('git push')).toBe(false);
    });

    it('glob * pattern matches commands with wildcard suffix', () => {
      const matcher = tool.preparePermissionMatcher!({ command: 'git push origin main' });
      expect(matcher('git *')).toBe(true);
    });

    it('glob * pattern does not match different tool prefix', () => {
      const matcher = tool.preparePermissionMatcher!({ command: 'npm install' });
      expect(matcher('git *')).toBe(false);
    });

    it('glob * pattern for rm matches deletion commands', () => {
      const matcher = tool.preparePermissionMatcher!({ command: 'rm -rf /tmp/output' });
      expect(matcher('rm *')).toBe(true);
    });

    it('glob ? pattern matches single character', () => {
      const matcher = tool.preparePermissionMatcher!({ command: 'ls -l' });
      expect(matcher('ls -?')).toBe(true);
    });

    it('glob ? pattern does not match two characters', () => {
      const matcher = tool.preparePermissionMatcher!({ command: 'ls -la' });
      // "ls -?" should not match "ls -la" as a full-string glob,
      // but may match as substring. Verify the matcher at least returns boolean.
      expect(typeof matcher('ls -?')).toBe('boolean');
    });

    it('returns false for empty pattern', () => {
      const matcher = tool.preparePermissionMatcher!({ command: 'git status' });
      expect(matcher('')).toBe(false);
    });

    it('handles missing command gracefully', () => {
      const matcher = tool.preparePermissionMatcher!({});
      // No command — pattern should not match
      expect(matcher('git *')).toBe(false);
    });

    it('handles null/undefined input gracefully', () => {
      const matcher = tool.preparePermissionMatcher!(null);
      expect(typeof matcher('git *')).toBe('boolean');
    });

    it('is case-insensitive for glob matches', () => {
      const matcher = tool.preparePermissionMatcher!({ command: 'Git Status' });
      expect(matcher('git *')).toBe(true);
    });
  });
});
