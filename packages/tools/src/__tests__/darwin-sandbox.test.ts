import { describe, expect, test } from 'bun:test';
import {
  buildDarwinSandboxProfile,
  isDarwinSandboxAvailable,
  wrapWithDarwinSandbox,
  detectDarwinSandboxViolation,
} from '../sandbox/darwin-runner';

// Re-export from the runner (it re-exports from profile).
// If not, import directly:
// import { buildDarwinSandboxProfile, isDarwinSandboxAvailable } from '../sandbox/darwin-profile';

describe('buildDarwinSandboxProfile', () => {
  test('default profile denies writes, allows reads, allows network', () => {
    const p = buildDarwinSandboxProfile();
    expect(p).toContain('(version 1)');
    expect(p).toContain('(deny default)');
    expect(p).toContain('(allow file-read*)');
    expect(p).toContain('(deny file-write*)');
    expect(p).toContain('(allow file-write* (subpath "/tmp"))');
    expect(p).toContain('(allow network*)');
    expect(p).toContain('(allow process-exec*)');
  });

  test('writablePaths are included', () => {
    const p = buildDarwinSandboxProfile({ writablePaths: ['/Users/me/workspace'] });
    expect(p).toContain('(allow file-write* (subpath "/Users/me/workspace"))');
  });

  test('blockNetwork denies network but allows unix sockets by default', () => {
    const p = buildDarwinSandboxProfile({ blockNetwork: true });
    expect(p).toContain('(deny network*)');
    expect(p).toContain('(allow network* (remote unix-socket))');
  });

  test('blockNetwork + !allowUnixSockets denies everything', () => {
    const p = buildDarwinSandboxProfile({ blockNetwork: true, allowUnixSockets: false });
    expect(p).toContain('(deny network*)');
    expect(p).not.toContain('(allow network* (remote unix-socket))');
  });

  test('deniedReadPaths generates deny file-read rules', () => {
    const p = buildDarwinSandboxProfile({
      deniedReadPaths: ['/Users/me/.ssh', '/Users/me/.aws'],
    });
    expect(p).toContain('(deny file-read* (subpath "/Users/me/.ssh"))');
    expect(p).toContain('(deny file-read* (subpath "/Users/me/.aws"))');
  });

  test('allowProcessExec=false blocks exec and fork', () => {
    const p = buildDarwinSandboxProfile({ allowProcessExec: false });
    expect(p).toContain('(deny process-exec*)');
    expect(p).toContain('(deny process-fork)');
    expect(p).not.toContain('(allow process-exec*)');
  });

  test('paths with special chars are quoted safely', () => {
    const p = buildDarwinSandboxProfile({
      writablePaths: ['/Users/me/weird "path" name'],
    });
    expect(p).toContain('\\"path\\"');
  });
});

describe('isDarwinSandboxAvailable', () => {
  test('returns true on darwin, false elsewhere', () => {
    const actual = isDarwinSandboxAvailable();
    expect(actual).toBe(process.platform === 'darwin');
  });
});

describe('wrapWithDarwinSandbox', () => {
  test('on darwin, returns sandbox-exec argv and cleanup', async () => {
    if (!isDarwinSandboxAvailable()) {
      // Skip on non-darwin CI
      return;
    }
    const result = await wrapWithDarwinSandbox(['echo', 'hi'], { writablePaths: ['/tmp/test'] });
    expect(result.argv[0]).toBe('sandbox-exec');
    expect(result.argv[1]).toBe('-f');
    expect(result.argv[2]).toMatch(/profile\.sb$/);
    expect(result.argv[3]).toBe('echo');
    expect(result.argv[4]).toBe('hi');
    expect(result.profile).toContain('/tmp/test');
    await result.cleanup();
  });

  test('throws on non-darwin', async () => {
    if (isDarwinSandboxAvailable()) {
      return; // can't test this branch on darwin
    }
    await expect(wrapWithDarwinSandbox(['echo'])).rejects.toThrow(/only available on macOS/);
  });

  test('throws on empty command', async () => {
    if (!isDarwinSandboxAvailable()) {
      return;
    }
    await expect(wrapWithDarwinSandbox([])).rejects.toThrow(/non-empty/);
  });
});

describe('detectDarwinSandboxViolation', () => {
  test('catches bare deny file-write message', () => {
    const result = detectDarwinSandboxViolation('deny file-write-data /etc/passwd');
    expect(result).not.toBeNull();
    expect(result).toContain('deny');
  });

  test('catches Sandbox: process deny message', () => {
    const result = detectDarwinSandboxViolation('Sandbox: bash(1234) deny(1) file-write-data /etc');
    expect(result).not.toBeNull();
    expect(result).toContain('Sandbox');
  });

  test('returns null on clean stderr', () => {
    expect(detectDarwinSandboxViolation('normal output here')).toBeNull();
  });

  test('catches deny file-read message', () => {
    const result = detectDarwinSandboxViolation('deny file-read-data /root/.ssh/id_rsa');
    expect(result).not.toBeNull();
    expect(result).toContain('deny');
  });

  test('catches deny network message', () => {
    const result = detectDarwinSandboxViolation('deny network-outbound 1.2.3.4:443');
    expect(result).not.toBeNull();
    expect(result).toContain('deny');
  });

  test('catches Operation not permitted', () => {
    const result = detectDarwinSandboxViolation('bash: /etc/hosts: Operation not permitted');
    expect(result).not.toBeNull();
    expect(result).toContain('Operation not permitted');
  });

  test('returns null on empty string', () => {
    expect(detectDarwinSandboxViolation('')).toBeNull();
  });
});
