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
    expect(policy.enforcedFeatures).toEqual({
      network: false,
      writePaths: false,
      readPaths: false,
    });
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
    expect(policy.denyReadPaths).toEqual([join(tmpDir, 'blocked')]);
    expect(policy.allowWritePaths).toEqual([join(tmpDir, 'allowed')]);
    expect(policy.denyWritePaths).toEqual([join(tmpDir, 'blocked')]);
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
      command: 'echo "$OPEN_AGENT_SANDBOX|$OPEN_AGENT_SANDBOX_NETWORK_DISABLED|$OPEN_AGENT_SANDBOX_EXECUTION_ENGINE|$OPEN_AGENT_SANDBOX_ENFORCED_FEATURES"',
      [BASH_SANDBOX_POLICY_FIELD]: policy,
    }, ctx());

    expect(result).toContain(`1|1|${policy.executionEngine}|network`);
  });

  it('blocks network commands when network is disabled', async () => {
    const policy = buildBashSandboxPolicy({
      sandbox: { enabled: true, network: { disabled: true } },
      cwd: tmpDir,
    });

    await expect(
      bash.execute({
        command: 'curl https://example.com',
        [BASH_SANDBOX_POLICY_FIELD]: policy,
      }, ctx()),
    ).rejects.toThrow('network access is disabled');
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

    await expect(
      bash.execute({
        command: 'echo "blocked" > ./blocked.txt',
        [BASH_SANDBOX_POLICY_FIELD]: policy,
      }, ctx()),
    ).rejects.toThrow('outside allowed paths');
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
  });
});
