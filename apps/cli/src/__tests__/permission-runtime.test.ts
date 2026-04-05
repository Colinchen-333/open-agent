import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  BASH_SANDBOX_POLICY_FIELD,
  type PermissionRequest,
  type SettingsFile,
} from '@open-agent/permissions';
import { createCliPermissionRuntime } from '../permission-runtime.js';

function makeTempCwd(prefix: string): { cwd: string; cleanup(): void } {
  const cwd = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(cwd, '.open-agent'), { recursive: true });
  return {
    cwd,
    cleanup(): void {
      rmSync(cwd, { recursive: true, force: true });
    },
  };
}

function writeSettings(cwd: string, value: unknown): void {
  writeFileSync(join(cwd, '.open-agent', 'settings.json'), JSON.stringify(value), 'utf-8');
}

function bashRequest(command: string): PermissionRequest {
  return {
    toolName: 'Bash',
    toolUseId: 'tool-use-1',
    input: {
      command,
    },
  };
}

describe('createCliPermissionRuntime', () => {
  it('injects bash sandbox policy from merged settings and preserves prompt tool wiring', async () => {
    const temp = makeTempCwd('open-agent-cli-permissions-');
    try {
      writeSettings(temp.cwd, {
        permissions: {
          allow: [{ toolName: 'Bash', ruleContent: 'echo' }],
          deniedPaths: ['/secret'],
        },
        sandbox: {
          enabled: true,
          filesystem: {
            denyRead: ['/secret'],
          },
        },
      });

      const runtime = createCliPermissionRuntime({
        cwd: temp.cwd,
        mode: 'default',
        permissionPromptToolName: 'mcp__permissions__prompt',
      });

      const request = bashRequest('echo hello');
      const decision = await runtime.permissionEngine.evaluate(request);
      const policy = request.input[BASH_SANDBOX_POLICY_FIELD];

      expect(decision.behavior).toBe('allow');
      expect(runtime.permissionEngine.getPermissionPromptToolName()).toBe('mcp__permissions__prompt');
      expect(policy).toMatchObject({
        enforce: true,
        denyReadPaths: ['/secret'],
      });
    } finally {
      temp.cleanup();
    }
  });

  it('refreshes CLI permission and sandbox state from disk without rebuilding callers', async () => {
    const temp = makeTempCwd('open-agent-cli-permissions-refresh-');
    try {
      writeSettings(temp.cwd, {
        permissions: {
          allow: [{ toolName: 'Write' }],
          allowedPaths: ['/workspace'],
        },
        sandbox: {
          enabled: true,
          filesystem: {
            denyRead: ['/secret-a'],
          },
        },
      });

      const runtime = createCliPermissionRuntime({
        cwd: temp.cwd,
        mode: 'default',
        additionalDirectories: [join(temp.cwd, 'extra')],
      });

      expect(runtime.permissionEngine.getSummary()).toMatchObject({
        allowRules: [{ toolName: 'Write' }],
        allowedPaths: ['/workspace', join(temp.cwd, 'extra')],
      });

      writeSettings(temp.cwd, {
        permissions: {
          deny: [{ toolName: 'Write' }],
          deniedPaths: ['/blocked'],
        },
        sandbox: {
          enabled: true,
          filesystem: {
            denyRead: ['/secret-b'],
          },
        },
      });

      runtime.refreshFromSettings();

      const request = bashRequest('cat /secret-b/token.txt');
      await runtime.permissionEngine.evaluate(request);

      expect(runtime.permissionEngine.getSummary()).toMatchObject({
        allowRules: [],
        denyRules: [{ toolName: 'Write' }],
        deniedPaths: ['/blocked'],
        allowedPaths: [temp.cwd, join(temp.cwd, 'extra')],
      });
      expect(request.input[BASH_SANDBOX_POLICY_FIELD]).toMatchObject({
        denyReadPaths: ['/secret-b', '/blocked'],
        denyWritePaths: ['/blocked'],
      });
    } finally {
      temp.cleanup();
    }
  });

  it('preserves session-scoped allow rules and mode across settings refresh', () => {
    const temp = makeTempCwd('open-agent-cli-permissions-session-');
    try {
      writeSettings(temp.cwd, {
        permissions: {
          deny: [{ toolName: 'Write' }],
        },
      });

      const runtime = createCliPermissionRuntime({
        cwd: temp.cwd,
        mode: 'default',
      });

      runtime.permissionEngine.addRule('allow', { toolName: 'Bash', ruleContent: 'echo' });
      runtime.permissionEngine.setMode('acceptEdits');

      writeSettings(temp.cwd, {
        permissions: {
          deny: [{ toolName: 'Read' }],
        },
      });

      runtime.refreshFromSettings();

      expect(runtime.permissionEngine.getSummary()).toMatchObject({
        mode: 'acceptEdits',
        allowRules: [{ toolName: 'Bash', ruleContent: 'echo' }],
        denyRules: [{ toolName: 'Read' }],
      });
    } finally {
      temp.cleanup();
    }
  });

  it('preserves session-scoped rule removals across settings refresh', () => {
    const temp = makeTempCwd('open-agent-cli-permissions-remove-');
    try {
      writeSettings(temp.cwd, {
        permissions: {
          allow: [{ toolName: 'Bash', ruleContent: 'echo' }],
        },
      });

      const runtime = createCliPermissionRuntime({
        cwd: temp.cwd,
        mode: 'default',
      });

      runtime.permissionEngine.removeRule('allow', { toolName: 'Bash', ruleContent: 'echo' });
      runtime.refreshFromSettings();

      expect(runtime.permissionEngine.getSummary().allowRules).toEqual([]);
    } finally {
      temp.cleanup();
    }
  });

  it('invokes watch refresh callbacks with reloaded settings payload', () => {
    const settingsQueue: SettingsFile[] = [
      {
        permissions: {
          allow: [{ toolName: 'Read' }],
        },
      },
      {
        permissions: {
          deny: [{ toolName: 'Write' }],
        },
      },
    ];
    let listener: ((source: 'watch' | 'manual' | 'policy' | 'user' | 'project' | 'local') => void) | null = null;
    const fakeLoader = {
      load() {
        return settingsQueue.shift() ?? {};
      },
      getCandidatePaths() {
        return [];
      },
    };
    const fakeDetector = {
      subscribe(next: typeof listener) {
        listener = next;
        return () => {
          listener = null;
        };
      },
      watch() {
        return {
          close() {},
        };
      },
    };

    const runtime = createCliPermissionRuntime({
      cwd: '/tmp',
      mode: 'default',
      settingsLoader: fakeLoader as any,
      settingsChangeDetector: fakeDetector as any,
    });
    const observed: SettingsFile[] = [];
    const subscription = runtime.watchSettings(['project'], {
      onRefresh(settings) {
        observed.push(settings);
      },
    });

    listener?.('watch');

    expect(observed).toEqual([{
      permissions: {
        deny: [{ toolName: 'Write' }],
      },
    }]);
    expect(runtime.permissionEngine.getSummary().denyRules).toEqual([{ toolName: 'Write' }]);
    subscription.close();
  });
});
