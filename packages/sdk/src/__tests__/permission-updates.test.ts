import { describe, it, expect } from 'bun:test';
import { PermissionEngine } from '@open-agent/permissions';
import { applyPermissionUpdates } from '../permission-updates.js';

describe('applyPermissionUpdates', () => {
  it('applies addRules for session destination', () => {
    const engine = new PermissionEngine({ mode: 'default' });
    applyPermissionUpdates(engine, [
      {
        type: 'addRules',
        behavior: 'allow',
        destination: 'session',
        rules: [{ toolName: 'Read' }],
      },
    ]);
    const summary = engine.getSummary();
    expect(summary.allowRules).toEqual([{ toolName: 'Read' }]);
  });

  it('ignores non-session destination updates', () => {
    const engine = new PermissionEngine({ mode: 'default' });
    applyPermissionUpdates(engine, [
      {
        type: 'addRules',
        behavior: 'allow',
        destination: 'projectSettings',
        rules: [{ toolName: 'Read' }],
      },
      {
        type: 'setMode',
        destination: 'userSettings',
        mode: 'bypassPermissions',
      },
    ]);
    const summary = engine.getSummary();
    expect(summary.allowRules).toEqual([]);
    expect(summary.mode).toBe('default');
  });

  it('applies setMode for session destination', () => {
    const engine = new PermissionEngine({ mode: 'default' });
    applyPermissionUpdates(engine, [
      {
        type: 'setMode',
        destination: 'session',
        mode: 'acceptEdits',
      },
    ]);
    expect(engine.getMode()).toBe('acceptEdits');
  });

  it('applies add/remove directories for session destination', () => {
    const engine = new PermissionEngine({ mode: 'default' });
    applyPermissionUpdates(engine, [
      {
        type: 'addDirectories',
        destination: 'session',
        directories: ['/tmp/a', '/tmp/b'],
      },
      {
        type: 'removeDirectories',
        destination: 'session',
        directories: ['/tmp/a'],
      },
    ]);
    const summary = engine.getSummary();
    expect(summary.allowedPaths).toEqual(['/tmp/b']);
  });

  it('replaces and removes rules for session destination', () => {
    const engine = new PermissionEngine({ mode: 'default' });
    applyPermissionUpdates(engine, [
      {
        type: 'addRules',
        behavior: 'allow',
        destination: 'session',
        rules: [{ toolName: 'Write', ruleContent: '/tmp' }],
      },
      {
        type: 'replaceRules',
        behavior: 'deny',
        destination: 'session',
        rules: [{ toolName: 'Write', ruleContent: '/tmp' }],
      },
      {
        type: 'removeRules',
        behavior: 'deny',
        destination: 'session',
        rules: [{ toolName: 'Write', ruleContent: '/tmp' }],
      },
    ]);
    const summary = engine.getSummary();
    expect(summary.allowRules).toEqual([]);
    expect(summary.denyRules).toEqual([]);
  });
});
