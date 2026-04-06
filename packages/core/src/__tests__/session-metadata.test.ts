import { describe, expect, test } from 'bun:test';
import type { SessionInfo } from '../session-manager';

describe('SessionInfo metadata fields', () => {
  test('supports git branch', () => {
    const info: Partial<SessionInfo> = { gitBranch: 'feat/test' };
    expect(info.gitBranch).toBe('feat/test');
  });

  test('supports project path', () => {
    const info: Partial<SessionInfo> = { projectPath: '/home/user/project' };
    expect(info.projectPath).toBe('/home/user/project');
  });

  test('supports PR tracking', () => {
    const info: Partial<SessionInfo> = {
      prNumber: 42,
      prUrl: 'https://github.com/org/repo/pull/42',
      prRepository: 'org/repo',
    };
    expect(info.prNumber).toBe(42);
    expect(info.prUrl).toContain('pull/42');
  });

  test('supports worktree session', () => {
    const info: Partial<SessionInfo> = {
      worktreeSession: { branch: 'feature', path: '/tmp/wt' },
    };
    expect(info.worktreeSession?.branch).toBe('feature');
  });

  test('supports coordinator mode', () => {
    const info: Partial<SessionInfo> = { mode: 'coordinator' };
    expect(info.mode).toBe('coordinator');
  });
});
