import { describe, it, expect, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { SettingsLoader } from '../settings-loader.js';

function writeJson(filePath: string, data: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(data), 'utf-8');
}

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('SettingsLoader', () => {
  it('falls back to .claude project settings when .open-agent settings are absent', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'open-agent-settings-claude-'));
    tempDirs.push(cwd);
    writeJson(join(cwd, '.claude', 'settings.json'), {
      permissions: {
        allow: [{ toolName: 'Read' }],
      },
    });

    const loader = new SettingsLoader();
    const loaded = loader.load(cwd, ['project']);
    expect(loaded.permissions?.allow).toEqual([{ toolName: 'Read' }]);
  });

  it('loads both .open-agent and .claude project settings when both exist', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'open-agent-settings-dual-project-'));
    tempDirs.push(cwd);
    writeJson(join(cwd, '.open-agent', 'settings.json'), {
      permissions: {
        allow: [{ toolName: 'Read' }],
      },
      env: { OPEN_AGENT_FLAG: '1' },
    });
    writeJson(join(cwd, '.claude', 'settings.json'), {
      permissions: {
        deny: [{ toolName: 'Bash', ruleContent: 'rm -rf' }],
      },
      sandbox: { enabled: true },
    });

    const loader = new SettingsLoader();
    const loaded = loader.load(cwd, ['project']);
    expect(loaded.permissions?.allow).toEqual([{ toolName: 'Read' }]);
    expect(loaded.permissions?.deny).toEqual([{ toolName: 'Bash', ruleContent: 'rm -rf' }]);
    expect(loaded.env).toEqual({ OPEN_AGENT_FLAG: '1' });
    expect(loaded.sandbox).toEqual({ enabled: true });
  });

  it('merges rules and applies higher-priority overrides for sandbox and path lists', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'open-agent-settings-merge-'));
    tempDirs.push(cwd);
    writeJson(join(cwd, '.open-agent', 'settings.json'), {
      permissions: {
        allow: [{ toolName: 'Read' }],
        ask: [{ toolName: 'Write' }],
        allowedPaths: ['/project'],
        deniedPaths: ['/project/deny'],
      },
      sandbox: { enabled: false },
    });
    writeJson(join(cwd, '.open-agent', 'settings.local.json'), {
      permissions: {
        deny: [{ toolName: 'Bash', ruleContent: 'rm -rf' }],
        allowedPaths: ['/local-only'],
      },
      sandbox: { enabled: true, autoAllowBashIfSandboxed: true },
    });

    const loader = new SettingsLoader();
    const loaded = loader.load(cwd, ['project', 'local']);
    expect(loaded.permissions?.allow).toEqual([{ toolName: 'Read' }]);
    expect(loaded.permissions?.ask).toEqual([{ toolName: 'Write' }]);
    expect(loaded.permissions?.deny).toEqual([{ toolName: 'Bash', ruleContent: 'rm -rf' }]);
    expect(loaded.permissions?.allowedPaths).toEqual(['/local-only']);
    expect(loaded.permissions?.deniedPaths).toEqual(['/project/deny']);
    expect(loaded.sandbox).toEqual({ enabled: true, autoAllowBashIfSandboxed: true });
  });

  it('skips malformed settings files and preserves valid sources', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'open-agent-settings-invalid-'));
    tempDirs.push(cwd);
    writeJson(join(cwd, '.open-agent', 'settings.json'), {
      permissions: {
        allow: [{ toolName: 'Read' }],
      },
    });
    mkdirSync(join(cwd, '.open-agent'), { recursive: true });
    writeFileSync(join(cwd, '.open-agent', 'settings.local.json'), '{"permissions":', 'utf-8');

    const loader = new SettingsLoader();
    const loaded = loader.load(cwd, ['project', 'local']);
    expect(loaded.permissions?.allow).toEqual([{ toolName: 'Read' }]);
    expect(loaded.permissions?.deny).toBeUndefined();
  });
});
