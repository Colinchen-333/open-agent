import { describe, expect, test } from 'bun:test';
import {
  buildBwrapCommand,
  buildNetworkFilterEnv,
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

  test('injects network filter env vars when allowedDomains specified', () => {
    const args = buildBwrapCommand('curl example.com', {
      cwd: '/work',
      allowNetwork: true,
      networkConfig: { allowedDomains: ['example.com', 'api.test.com'] },
    });
    // Should contain --setenv SANDBOX_ALLOWED_DOMAINS
    const idx = args.indexOf('SANDBOX_ALLOWED_DOMAINS');
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe('example.com,api.test.com');
  });

  test('injects denied domains env var', () => {
    const args = buildBwrapCommand('curl evil.com', {
      cwd: '/work',
      allowNetwork: true,
      networkConfig: { deniedDomains: ['evil.com'] },
    });
    const idx = args.indexOf('SANDBOX_DENIED_DOMAINS');
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe('evil.com');
  });

  test('does not inject network filter env vars when no networkConfig', () => {
    const args = buildBwrapCommand('curl example.com', {
      cwd: '/work',
      allowNetwork: true,
    });
    expect(args.indexOf('SANDBOX_ALLOWED_DOMAINS')).toBe(-1);
    expect(args.indexOf('SANDBOX_DENIED_DOMAINS')).toBe(-1);
  });
});

describe('buildNetworkFilterEnv', () => {
  test('generates allowed domains env var', () => {
    const env = buildNetworkFilterEnv({ allowedDomains: ['a.com', 'b.com'] });
    expect(env['SANDBOX_ALLOWED_DOMAINS']).toBe('a.com,b.com');
  });

  test('generates denied domains env var', () => {
    const env = buildNetworkFilterEnv({ deniedDomains: ['evil.com'] });
    expect(env['SANDBOX_DENIED_DOMAINS']).toBe('evil.com');
  });

  test('generates local binding env var', () => {
    const env = buildNetworkFilterEnv({ allowLocalBinding: true });
    expect(env['SANDBOX_ALLOW_LOCAL_BINDING']).toBe('1');
  });

  test('generates all unix sockets env var', () => {
    const env = buildNetworkFilterEnv({ allowAllUnixSockets: true });
    expect(env['SANDBOX_ALLOW_ALL_UNIX_SOCKETS']).toBe('1');
  });

  test('generates specific unix sockets env var', () => {
    const env = buildNetworkFilterEnv({ allowUnixSockets: ['/var/run/docker.sock'] });
    expect(env['SANDBOX_ALLOWED_UNIX_SOCKETS']).toBe('/var/run/docker.sock');
  });

  test('allowAllUnixSockets takes precedence over allowUnixSockets', () => {
    const env = buildNetworkFilterEnv({
      allowAllUnixSockets: true,
      allowUnixSockets: ['/var/run/docker.sock'],
    });
    expect(env['SANDBOX_ALLOW_ALL_UNIX_SOCKETS']).toBe('1');
    expect(env['SANDBOX_ALLOWED_UNIX_SOCKETS']).toBeUndefined();
  });

  test('empty config produces empty env', () => {
    const env = buildNetworkFilterEnv({});
    expect(Object.keys(env)).toHaveLength(0);
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

  test('preserves network config with domain lists', () => {
    const config = sandboxConfigToLinux(
      {
        network: {
          allowedDomains: ['example.com'],
          deniedDomains: ['evil.com'],
          allowLocalBinding: true,
        },
      },
      '/work',
    );
    expect(config.networkConfig).toBeDefined();
    expect(config.networkConfig!.allowedDomains).toEqual(['example.com']);
    expect(config.networkConfig!.deniedDomains).toEqual(['evil.com']);
    expect(config.networkConfig!.allowLocalBinding).toBe(true);
  });

  test('networkConfig is undefined when no network section', () => {
    const config = sandboxConfigToLinux({ enabled: true }, '/work');
    expect(config.networkConfig).toBeUndefined();
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
