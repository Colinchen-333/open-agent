import { describe, it, expect, afterEach, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { SettingsLoader, loadLayeredSettings } from '../settings-loader.js';

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

// ---------------------------------------------------------------------------
// loadLayeredSettings — 6-layer hierarchy
// ---------------------------------------------------------------------------

test('6-layer precedence: flag > policy > project > local > user > defaults', async () => {
  const root = mkdtempSync(`${tmpdir()}/oa-settings-`);
  const home = mkdtempSync(`${tmpdir()}/oa-home-`);
  tempDirs.push(root, home);

  const project = join(root, 'proj');
  const local = join(project, '.claude', 'local');
  const projSettings = join(project, '.claude');
  const userSettings = join(home, '.claude');

  mkdirSync(local, { recursive: true });
  mkdirSync(projSettings, { recursive: true });
  mkdirSync(userSettings, { recursive: true });

  writeFileSync(
    join(userSettings, 'settings.json'),
    JSON.stringify({ model: 'user-model', verbose: true }),
  );
  writeFileSync(
    join(projSettings, 'settings.json'),
    JSON.stringify({ model: 'project-model' }),
  );
  writeFileSync(
    join(local, 'settings.json'),
    JSON.stringify({ permissionMode: 'plan' }),
  );

  const merged = await loadLayeredSettings({
    cwd: project,
    home,
    flagSettings: { model: 'flag-model' },
  });

  expect(merged.model).toBe('flag-model');       // flag wins over project and user
  expect(merged.permissionMode).toBe('plan');    // local wins over user
  expect(merged.verbose).toBe(true);             // user contributes when no higher layer overrides
});

test('loadLayeredSettings: deep-merge nested objects across layers', async () => {
  const root = mkdtempSync(`${tmpdir()}/oa-deep-`);
  const home = mkdtempSync(`${tmpdir()}/oa-deep-home-`);
  tempDirs.push(root, home);

  const project = join(root, 'proj');
  const projDir = join(project, '.claude');
  const userDir = join(home, '.claude');

  mkdirSync(projDir, { recursive: true });
  mkdirSync(userDir, { recursive: true });

  writeFileSync(
    join(userDir, 'settings.json'),
    JSON.stringify({ nested: { a: 1, b: 2 } }),
  );
  writeFileSync(
    join(projDir, 'settings.json'),
    JSON.stringify({ nested: { b: 99, c: 3 } }),
  );

  const merged = await loadLayeredSettings({ cwd: project, home });

  // project layer wins on 'b', user layer contributes 'a', project adds 'c'
  expect((merged.nested as Record<string, unknown>).a).toBe(1);
  expect((merged.nested as Record<string, unknown>).b).toBe(99);
  expect((merged.nested as Record<string, unknown>).c).toBe(3);
});

test('loadLayeredSettings: missing files are silently skipped', async () => {
  const root = mkdtempSync(`${tmpdir()}/oa-missing-`);
  const home = mkdtempSync(`${tmpdir()}/oa-missing-home-`);
  tempDirs.push(root, home);

  const project = join(root, 'proj-empty');
  mkdirSync(project, { recursive: true });

  // No settings files written — should return an empty object without throwing
  const merged = await loadLayeredSettings({
    cwd: project,
    home,
    flagSettings: { debug: true },
  });

  expect(merged.debug).toBe(true);
  expect(Object.keys(merged).length).toBe(1);
});

test('loadLayeredSettings: policy layer sits between project and flag', async () => {
  const root = mkdtempSync(`${tmpdir()}/oa-policy-`);
  const home = mkdtempSync(`${tmpdir()}/oa-policy-home-`);
  tempDirs.push(root, home);

  const project = join(root, 'proj');
  const projDir = join(project, '.claude');
  const policyFile = join(root, 'policy.json');

  mkdirSync(projDir, { recursive: true });

  writeFileSync(join(projDir, 'settings.json'), JSON.stringify({ level: 'project' }));
  writeFileSync(policyFile, JSON.stringify({ level: 'policy', enforced: true }));

  const merged = await loadLayeredSettings({
    cwd: project,
    home,
    policyPath: policyFile,
    flagSettings: { level: 'flag' },
  });

  expect(merged.level).toBe('flag');          // flag beats policy
  expect(merged.enforced).toBe(true);         // policy contributes when flag doesn't override
});
