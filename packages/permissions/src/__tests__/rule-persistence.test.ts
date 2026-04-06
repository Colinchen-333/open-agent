import { describe, expect, test } from 'bun:test';
import type { PersistedRule } from '../rule-persistence';

describe('PersistedRule type', () => {
  test('allow rule shape', () => {
    const rule: PersistedRule = {
      behavior: 'allow',
      toolName: 'Bash',
      ruleContent: 'git *',
      createdAt: new Date().toISOString(),
      scope: 'permanent',
    };
    expect(rule.behavior).toBe('allow');
    expect(rule.scope).toBe('permanent');
  });

  test('deny rule shape', () => {
    const rule: PersistedRule = {
      behavior: 'deny',
      toolName: 'Write',
      createdAt: new Date().toISOString(),
      scope: 'session',
    };
    expect(rule.behavior).toBe('deny');
    expect(rule.ruleContent).toBeUndefined();
  });

  test('scope differentiates persistence', () => {
    const permanent: PersistedRule = { behavior: 'allow', toolName: 'T', createdAt: '', scope: 'permanent' };
    const session: PersistedRule = { behavior: 'allow', toolName: 'T', createdAt: '', scope: 'session' };
    expect(permanent.scope).toBe('permanent');
    expect(session.scope).toBe('session');
  });
});
