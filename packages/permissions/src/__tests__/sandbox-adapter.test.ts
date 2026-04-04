import { randomUUID } from 'crypto';
import { describe, expect, it, beforeAll, afterAll } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  BASH_SANDBOX_POLICY_FIELD,
  buildBashSandboxPolicy,
} from '../sandbox-adapter.js';
import { createBashTool } from '../../../tools/src/bash.js';

describe('sandbox-adapter', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'open-agent-sandbox-adapter-'));
    mkdirSync(join(tmpDir, 'allowed'), { recursive: true });
    mkdirSync(join(tmpDir, 'blocked'), { recursive: true });
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns non-enforced policy when sandbox is disabled', () => {
    const policy = buildBashSandboxPolicy({
      sandbox: { enabled: false },
      cwd: tmpDir,
      dangerouslyDisableSandbox: true,
    });
    expect(policy.enforce).toBe(false);
    expect(policy.executionEngine).toBe('none');
    expect(policy.boundaryKind).toBe('none');
    expect(policy.enforcedFeatures).toEqual({
      network: false,
      writePaths: false,
      readPaths: false,
    });
    expect(policy.hardEnforcedFeatures).toEqual([]);
    expect(policy.policyOnlyFeatures).toEqual([]);
    expect(policy.bypassRequested).toBe(true);
    expect(policy.bypassAllowed).toBe(true);
  });

  it('maps read/write sandbox paths to absolute paths', () => {
    const policy = buildBashSandboxPolicy({
      sandbox: {
        enabled: true,
        filesystem: {
          denyRead: ['./blocked'],
          allowWrite: ['./allowed'],
          denyWrite: ['./blocked'],
        },
      },
      cwd: tmpDir,
    });

    expect(policy.enforce).toBe(true);
    expect(policy.executionEngine).toBe(process.platform === 'darwin' ? 'darwin-sandbox-exec' : 'none');
    expect(policy.enforcedFeatures).toEqual({
      network: false,
      writePaths: process.platform === 'darwin',
      readPaths: false,
    });
    expect(policy.boundaryKind).toBe(process.platform === 'darwin' ? 'mixed' : 'policy_only');
    expect(policy.hardEnforcedFeatures).toEqual(process.platform === 'darwin' ? ['writePaths'] : []);
    expect(policy.policyOnlyFeatures).toEqual(process.platform === 'darwin' ? ['readPaths'] : ['writePaths', 'readPaths']);
    expect(policy.denyReadPaths).toEqual([join(tmpDir, 'blocked')]);
    expect(policy.allowWritePaths).toEqual([join(tmpDir, 'allowed')]);
    expect(policy.denyWritePaths).toEqual([join(tmpDir, 'blocked')]);
    expect(policy.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        stage: 'policy',
        scope: 'filesystem',
        code: 'read_paths_policy_only',
        severity: 'warning',
        target: join(tmpDir, 'blocked'),
      }),
    ]));
  });

  it('sets networkDisabled when network.disabled=true', () => {
    const policy = buildBashSandboxPolicy({
      sandbox: {
        enabled: true,
        network: {
          disabled: true,
        },
      },
      cwd: tmpDir,
    });

    expect(policy.networkDisabled).toBe(true);
    expect(policy.hardEnforcedFeatures.includes('network')).toBe(process.platform === 'darwin');
  });

  it('requires explicit bypass approval when dangerouslyDisableSandbox=true', () => {
    const askPolicy = buildBashSandboxPolicy({
      sandbox: { enabled: true },
      cwd: tmpDir,
      dangerouslyDisableSandbox: true,
      permissionBehavior: 'ask',
    });
    const allowPolicy = buildBashSandboxPolicy({
      sandbox: { enabled: true },
      cwd: tmpDir,
      dangerouslyDisableSandbox: true,
      permissionBehavior: 'allow',
    });

    expect(askPolicy.bypassRequested).toBe(true);
    expect(askPolicy.bypassAllowed).toBe(false);
    expect(allowPolicy.bypassAllowed).toBe(true);
    expect(askPolicy.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        stage: 'policy',
        scope: 'sandbox',
        code: 'sandbox_bypass_blocked',
        severity: 'error',
      }),
    ]));
    if (process.platform === 'darwin') {
      expect(allowPolicy.findings ?? []).toEqual([]);
    } else {
      expect(allowPolicy.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({
          stage: 'policy',
          scope: 'sandbox',
          code: 'sandbox_execution_engine_unavailable',
          severity: 'warning',
        }),
      ]));
    }
  });

  it('surfaces an unavailable-engine warning when the execution boundary cannot be enforced', () => {
    const policy = buildBashSandboxPolicy({
      sandbox: { enabled: true },
      cwd: tmpDir,
    });

    if (process.platform !== 'darwin') {
      expect(policy.executionEngine).toBe('none');
      expect(policy.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({
          stage: 'policy',
          scope: 'sandbox',
          code: 'sandbox_execution_engine_unavailable',
          severity: 'warning',
        }),
      ]));
    } else {
      expect(policy.executionEngine).toBe('darwin-sandbox-exec');
    }
  });
});

describe('sandbox preflight via Bash tool', () => {
  let tmpDir: string;
  const bash = createBashTool();
  const supportsSandboxExec = process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec');

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'open-agent-sandbox-bash-'));
    mkdirSync(join(tmpDir, 'allowed'), { recursive: true });
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function ctx() {
    return {
      cwd: tmpDir,
      sessionId: `sandbox-${randomUUID()}`,
    };
  }

  it('injects sandbox env vars into bash execution', async () => {
    const policy = buildBashSandboxPolicy({
      sandbox: { enabled: true, network: { disabled: true } },
      cwd: tmpDir,
    });

    const result = await bash.execute({
      command: 'echo "$OPEN_AGENT_SANDBOX|$OPEN_AGENT_SANDBOX_NETWORK_DISABLED|$OPEN_AGENT_SANDBOX_EXECUTION_ENGINE|$OPEN_AGENT_SANDBOX_BOUNDARY_KIND|$OPEN_AGENT_SANDBOX_HARD_ENFORCED_FEATURES|$OPEN_AGENT_SANDBOX_POLICY_ONLY_FEATURES"',
      [BASH_SANDBOX_POLICY_FIELD]: policy,
    }, ctx());

    expect(result).toContain(`1|1|${policy.executionEngine}|${policy.boundaryKind}|${policy.hardEnforcedFeatures.join(',')}|${policy.policyOnlyFeatures.join(',')}`);
  });

  it('blocks network commands when network is disabled', async () => {
    const policy = buildBashSandboxPolicy({
      sandbox: { enabled: true, network: { disabled: true } },
      cwd: tmpDir,
    });

    let error: unknown;
    try {
      await bash.execute({
        command: 'curl https://example.com',
        [BASH_SANDBOX_POLICY_FIELD]: policy,
      }, ctx());
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('network access is disabled');
    expect((error as Error & { sandboxViolation?: unknown }).sandboxViolation).toEqual(expect.objectContaining({
      phase: 'preflight',
      code: 'network_disabled',
      feature: 'network',
      executionEngine: policy.executionEngine,
      boundaryKind: policy.boundaryKind,
    }));
  });

  it('blocks writes outside allowWrite paths before execution', async () => {
    const policy = buildBashSandboxPolicy({
      sandbox: {
        enabled: true,
        filesystem: {
          allowWrite: [join(tmpDir, 'allowed')],
        },
      },
      cwd: tmpDir,
    });

    let error: unknown;
    try {
      await bash.execute({
        command: 'echo "blocked" > ./blocked.txt',
        [BASH_SANDBOX_POLICY_FIELD]: policy,
      }, ctx());
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('outside allowed paths');
    expect((error as Error & { sandboxViolation?: unknown }).sandboxViolation).toEqual(expect.objectContaining({
      phase: 'preflight',
      code: 'write_outside_allowed_paths',
      feature: 'writePaths',
      executionEngine: policy.executionEngine,
      boundaryKind: policy.boundaryKind,
    }));
  });

  it('blocks unapproved dangerouslyDisableSandbox bypass', async () => {
    const policy = buildBashSandboxPolicy({
      sandbox: { enabled: true },
      cwd: tmpDir,
      dangerouslyDisableSandbox: true,
      permissionBehavior: 'ask',
    });

    await expect(
      bash.execute({
        command: 'echo "blocked"',
        dangerouslyDisableSandbox: true,
        [BASH_SANDBOX_POLICY_FIELD]: policy,
      }, ctx()),
    ).rejects.toThrow('bypass');
  });

  it('enforces network restrictions at execution time for commands preflight cannot classify', async () => {
    if (!supportsSandboxExec) {
      return;
    }

    const policy = buildBashSandboxPolicy({
      sandbox: { enabled: true, network: { disabled: true } },
      cwd: tmpDir,
    });

    const result = await bash.execute({
      command: 'python3 -c "import socket; s=socket.socket(); s.settimeout(2); s.connect((\'1.1.1.1\', 80))" && echo "network-allowed"',
      [BASH_SANDBOX_POLICY_FIELD]: policy,
    }, ctx());

    expect(result).not.toContain('network-allowed');
    expect(result).toContain('Operation not permitted');
  });

  it('enforces filesystem restrictions at execution time for commands preflight cannot classify', async () => {
    if (!supportsSandboxExec) {
      return;
    }

    const policy = buildBashSandboxPolicy({
      sandbox: {
        enabled: true,
        filesystem: {
          allowWrite: [join(tmpDir, 'allowed')],
        },
      },
      cwd: tmpDir,
    });
    const blockedPath = join(tmpDir, 'python-blocked.txt');

    const result = await bash.execute({
      command: 'PYTHONDONTWRITEBYTECODE=1 python3 -c "from pathlib import Path; Path(\'python-blocked.txt\').write_text(\'blocked\'); print(\'write-allowed\')"',
      [BASH_SANDBOX_POLICY_FIELD]: policy,
    }, ctx());

    expect(result).not.toContain('write-allowed');
    expect(result).toContain('exit code');
    expect(() => readFileSync(blockedPath, 'utf-8')).toThrow();
  });

  it('surfaces denyRead as policy metadata without claiming execution enforcement', async () => {
    const blockedPath = join(tmpDir, 'blocked', 'secret.txt');
    mkdirSync(join(tmpDir, 'blocked'), { recursive: true });
    writeFileSync(blockedPath, 'top-secret', 'utf-8');

    const policy = buildBashSandboxPolicy({
      sandbox: {
        enabled: true,
        filesystem: {
          denyRead: [join(tmpDir, 'blocked')],
        },
      },
      cwd: tmpDir,
    });

    expect(policy.denyReadPaths).toEqual([join(tmpDir, 'blocked')]);
    expect(policy.enforcedFeatures.readPaths).toBe(false);
    expect(policy.policyOnlyFeatures).toContain('readPaths');
  });
});
