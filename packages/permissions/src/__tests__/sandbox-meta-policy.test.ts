import { describe, expect, test } from 'bun:test';
import {
  isSandboxEnabledOnPlatform,
  matchIgnoreRule,
  filterIgnoredFindings,
  enforceManagedReadPathsOnly,
  type SandboxMetaPolicy,
} from '../sandbox-meta-policy';

describe('isSandboxEnabledOnPlatform', () => {
  test('defaults to enabled on all platforms when enabledPlatforms absent', () => {
    expect(isSandboxEnabledOnPlatform({}, 'darwin')).toBe(true);
    expect(isSandboxEnabledOnPlatform({}, 'linux')).toBe(true);
    expect(isSandboxEnabledOnPlatform({}, 'win32')).toBe(true);
  });

  test('enforces enabledPlatforms list', () => {
    const policy: SandboxMetaPolicy = { enabledPlatforms: ['darwin'] };
    expect(isSandboxEnabledOnPlatform(policy, 'darwin')).toBe(true);
    expect(isSandboxEnabledOnPlatform(policy, 'linux')).toBe(false);
    expect(isSandboxEnabledOnPlatform(policy, 'win32')).toBe(false);
  });

  test('unknown platforms return false', () => {
    expect(isSandboxEnabledOnPlatform({ enabledPlatforms: ['darwin'] }, 'freebsd' as any)).toBe(false);
  });
});

describe('matchIgnoreRule', () => {
  test('returns null when no rules configured', () => {
    expect(matchIgnoreRule({ scope: 'filesystem', target: '/tmp/x' } as any, {})).toBeNull();
  });

  test('matches by category', () => {
    const policy: SandboxMetaPolicy = {
      ignoreViolations: [{ category: 'filesystem', reason: 'ok' }],
    };
    const rule = matchIgnoreRule({ scope: 'filesystem', target: '/etc/hosts' } as any, policy);
    expect(rule?.reason).toBe('ok');
  });

  test('category mismatch returns null', () => {
    const policy: SandboxMetaPolicy = {
      ignoreViolations: [{ category: 'network', reason: 'ok' }],
    };
    expect(matchIgnoreRule({ scope: 'filesystem', target: '/x' } as any, policy)).toBeNull();
  });

  test('pathPattern must match', () => {
    const policy: SandboxMetaPolicy = {
      ignoreViolations: [{ category: 'filesystem', pathPattern: '/tmp/**', reason: 'ok' }],
    };
    expect(matchIgnoreRule({ scope: 'filesystem', target: '/tmp/foo' } as any, policy)).not.toBeNull();
    expect(matchIgnoreRule({ scope: 'filesystem', target: '/tmp/nested/bar' } as any, policy)).not.toBeNull();
    expect(matchIgnoreRule({ scope: 'filesystem', target: '/etc/passwd' } as any, policy)).toBeNull();
  });

  test('single-star does not cross slashes', () => {
    const policy: SandboxMetaPolicy = {
      ignoreViolations: [{ category: 'filesystem', pathPattern: '/tmp/*', reason: 'ok' }],
    };
    expect(matchIgnoreRule({ scope: 'filesystem', target: '/tmp/foo' } as any, policy)).not.toBeNull();
    expect(matchIgnoreRule({ scope: 'filesystem', target: '/tmp/nested/bar' } as any, policy)).toBeNull();
  });
});

describe('filterIgnoredFindings', () => {
  test('keeps non-matched findings', () => {
    const findings = [
      { scope: 'filesystem', target: '/etc/hosts' },
      { scope: 'network', target: 'example.com' },
    ] as any[];
    const policy: SandboxMetaPolicy = {
      ignoreViolations: [{ category: 'network', reason: 'web ok' }],
    };
    const kept = filterIgnoredFindings(findings, policy);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.scope).toBe('filesystem');
  });

  test('empty policy returns everything', () => {
    const findings = [{ scope: 'filesystem', target: '/x' }] as any[];
    expect(filterIgnoredFindings(findings, {})).toHaveLength(1);
  });

  test('non-silent ignored findings trigger onIgnoredViolation callback', () => {
    const findings = [{ scope: 'filesystem', target: '/tmp/x' }] as any[];
    const policy: SandboxMetaPolicy = {
      ignoreViolations: [{ category: 'filesystem', reason: 'tmp ok', silent: false }],
    };
    const logged: string[] = [];
    filterIgnoredFindings(findings, policy, (f, r) => logged.push(r.reason));
    expect(logged).toEqual(['tmp ok']);
  });

  test('silent ignored findings do NOT trigger callback', () => {
    const findings = [{ scope: 'filesystem', target: '/tmp/x' }] as any[];
    const policy: SandboxMetaPolicy = {
      ignoreViolations: [{ category: 'filesystem', reason: 'tmp ok', silent: true }],
    };
    const logged: string[] = [];
    filterIgnoredFindings(findings, policy, (f, r) => logged.push(r.reason));
    expect(logged).toHaveLength(0);
  });
});

describe('enforceManagedReadPathsOnly', () => {
  test('passes through when policy flag is off', () => {
    const result = enforceManagedReadPathsOnly(['/a', '/b'], ['/c'], {});
    expect(result.allowed).toEqual(['/a', '/b']);
    expect(result.rejected).toEqual([]);
  });

  test('filters user paths not in managed set when flag is on', () => {
    const result = enforceManagedReadPathsOnly(
      ['/a', '/b', '/c'],
      ['/b', '/c', '/d'],
      { allowManagedReadPathsOnly: true },
    );
    expect(result.allowed).toEqual(['/b', '/c']);
    expect(result.rejected).toEqual(['/a']);
  });
});
