import { describe, expect, test } from 'bun:test';
import {
  buildBwrapCommand,
  sandboxConfigToLinux,
} from '../sandbox/linux-sandbox';

describe('buildBwrapCommand', () => {
  test('produces valid bwrap command array', () => {
    const args = buildBwrapCommand('echo hello', { cwd: '/work' });
    expect(args[0]).toBe('bwrap');
    expect(args).toContain('--unshare-pid');
    expect(args).toContain('--die-with-parent');
    // Last three args should be the shell command
    expect(args.slice(-3)).toEqual(['/bin/sh', '-c', 'echo hello']);
  });

  test('unshares network by default', () => {
    const args = buildBwrapCommand('ls', { cwd: '/work' });
    expect(args).toContain('--unshare-net');
  });

  test('does NOT unshare network when allowNetwork is true', () => {
    const args = buildBwrapCommand('curl example.com', {
      cwd: '/work',
      allowNetwork: true,
    });
    expect(args).not.toContain('--unshare-net');
  });

  test('binds cwd as writable', () => {
    const args = buildBwrapCommand('ls', { cwd: '/my/project' });
    const bindIdx = args.indexOf('--bind');
    expect(bindIdx).toBeGreaterThan(-1);
    expect(args[bindIdx + 1]).toBe('/my/project');
    expect(args[bindIdx + 2]).toBe('/my/project');
  });

  test('sets chdir to cwd', () => {
    const args = buildBwrapCommand('pwd', { cwd: '/work' });
    const idx = args.indexOf('--chdir');
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe('/work');
  });

  test('mounts default read-only paths', () => {
    const args = buildBwrapCommand('ls', { cwd: '/work' });
    // Should try to bind /usr, /bin, /etc etc.
    expect(args).toContain('--ro-bind-try');
    const roBindTryIndices = args.reduce<number[]>(
      (acc, v, i) => (v === '--ro-bind-try' ? [...acc, i] : acc),
      [],
    );
    expect(roBindTryIndices.length).toBeGreaterThan(3);
  });

  test('adds user-specified read-only paths', () => {
    const args = buildBwrapCommand('ls', {
      cwd: '/work',
      allowRead: ['/data/readonly'],
    });
    // Find the ro-bind-try for /data/readonly (format: --ro-bind-try src dest)
    let found = false;
    for (let i = 0; i < args.length - 2; i++) {
      if (
        args[i] === '--ro-bind-try' &&
        args[i + 1] === '/data/readonly' &&
        args[i + 2] === '/data/readonly'
      ) {
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  });

  test('adds user-specified writable paths', () => {
    const args = buildBwrapCommand('ls', {
      cwd: '/work',
      allowWrite: ['/output'],
    });
    // Find --bind for /output (not --ro-bind-try)
    let found = false;
    for (let i = 0; i < args.length - 2; i++) {
      if (args[i] === '--bind' && args[i + 1] === '/output') {
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  });

  test('excludes denied read paths', () => {
    const args = buildBwrapCommand('ls', {
      cwd: '/work',
      allowRead: ['/data/secret', '/data/ok'],
      denyRead: ['/data/secret'],
    });
    // /data/secret should NOT appear as a ro-bind-try target
    let secretBound = false;
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === '--ro-bind-try' && args[i + 1] === '/data/secret') {
        secretBound = true;
      }
    }
    expect(secretBound).toBe(false);
  });

  test('passes environment variables', () => {
    const args = buildBwrapCommand('echo $FOO', {
      cwd: '/work',
      env: { FOO: 'bar', BAZ: 'qux' },
    });
    // Should have --setenv FOO bar
    const fooIdx = args.indexOf('FOO');
    expect(fooIdx).toBeGreaterThan(-1);
    expect(args[fooIdx - 1]).toBe('--setenv');
    expect(args[fooIdx + 1]).toBe('bar');
  });

  test('sets PATH and TERM', () => {
    const args = buildBwrapCommand('ls', { cwd: '/work' });
    const pathIdx = args.indexOf('PATH');
    expect(pathIdx).toBeGreaterThan(-1);
    expect(args[pathIdx - 1]).toBe('--setenv');
  });
});

describe('sandboxConfigToLinux', () => {
  test('converts basic config', () => {
    const config = sandboxConfigToLinux({ enabled: true }, '/work');
    expect(config.cwd).toBe('/work');
    expect(config.allowNetwork).toBe(false);
  });

  test('enables network when domains are specified', () => {
    const config = sandboxConfigToLinux(
      {
        network: { allowedDomains: ['example.com'] },
      },
      '/work',
    );
    expect(config.allowNetwork).toBe(true);
  });

  test('passes through filesystem config', () => {
    const config = sandboxConfigToLinux(
      {
        filesystem: {
          allowWrite: ['/tmp/out'],
          denyRead: ['/secret'],
          allowRead: ['/data'],
        },
      },
      '/work',
    );
    expect(config.allowWrite).toEqual(['/tmp/out']);
    expect(config.denyRead).toEqual(['/secret']);
    expect(config.allowRead).toEqual(['/data']);
  });
});
