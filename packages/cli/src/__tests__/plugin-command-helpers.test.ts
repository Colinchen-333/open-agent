import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PluginCommandHelpers } from '../plugin-command-helpers.js';

function createPlugin(
  pluginRoot: string,
  name: string,
  options?: { version?: string; withSkill?: boolean },
): void {
  const version = options?.version ?? '1.0.0';
  const pluginDir = join(pluginRoot, name);
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(
    join(pluginDir, 'plugin.json'),
    JSON.stringify({
      name,
      version,
      description: `${name} plugin`,
      commands: [{ name: `${name}-cmd`, description: `${name} command`, prompt: 'run' }],
    }, null, 2),
    'utf-8',
  );

  if (options?.withSkill) {
    const skillsDir = join(pluginDir, 'skills');
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(
      join(skillsDir, `${name}.md`),
      [
        '---',
        `name: ${name}-skill`,
        `description: ${name} skill`,
        '---',
        '',
        `Use ${name}.`,
      ].join('\n'),
      'utf-8',
    );
  }
}

describe('PluginCommandHelpers', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lists plugins and includes session persistence note', () => {
    const root = mkdtempSync(join(tmpdir(), 'open-agent-plugin-helpers-'));
    tempDirs.push(root);
    const pluginDir = join(root, 'plugins');
    mkdirSync(pluginDir, { recursive: true });
    createPlugin(pluginDir, 'alpha', { withSkill: true });
    createPlugin(pluginDir, 'beta');

    const helpers = new PluginCommandHelpers({
      cwd: root,
      pluginDirectory: pluginDir,
      skillDirectories: [],
    });

    const result = helpers.listPlugins();
    expect(result.ok).toBe(true);
    expect(result.data.totalPlugins).toBe(2);
    expect(result.data.enabledPlugins).toBe(2);
    expect(result.data.disabledPlugins).toBe(0);
    expect(result.data.discoveredPluginSkillCount).toBe(1);
    expect(result.output).toContain('Persistence: session');
    expect(result.output).toContain('session-only');
  });

  it('disable/enable only affects session state and reports scope clearly', () => {
    const root = mkdtempSync(join(tmpdir(), 'open-agent-plugin-helpers-'));
    tempDirs.push(root);
    const pluginDir = join(root, 'plugins');
    mkdirSync(pluginDir, { recursive: true });
    createPlugin(pluginDir, 'alpha');

    const helpers = new PluginCommandHelpers({ cwd: root, pluginDirectory: pluginDir });

    const disabled = helpers.disablePlugin('alpha');
    expect(disabled.ok).toBe(true);
    expect(disabled.data.enabled).toBe(false);
    expect(disabled.output).toContain('Persistence scope: session');
    expect(disabled.output).toContain('resets after process restart');

    const listedAfterDisable = helpers.listPlugins();
    expect(listedAfterDisable.data.disabledPlugins).toBe(1);
    expect(listedAfterDisable.data.sessionDisabledPlugins).toEqual(['alpha']);

    const enabled = helpers.enablePlugin('alpha');
    expect(enabled.ok).toBe(true);
    expect(enabled.data.enabled).toBe(true);

    const listedAfterEnable = helpers.listPlugins();
    expect(listedAfterEnable.data.disabledPlugins).toBe(0);
    expect(listedAfterEnable.data.sessionDisabledPlugins).toEqual([]);
  });

  it('reapplies session disable overrides after reload', () => {
    const root = mkdtempSync(join(tmpdir(), 'open-agent-plugin-helpers-'));
    tempDirs.push(root);
    const pluginDir = join(root, 'plugins');
    mkdirSync(pluginDir, { recursive: true });
    createPlugin(pluginDir, 'alpha');
    createPlugin(pluginDir, 'beta');

    const helpers = new PluginCommandHelpers({ cwd: root, pluginDirectory: pluginDir });
    const disabled = helpers.disablePlugin('beta');
    expect(disabled.ok).toBe(true);

    const reloaded = helpers.reloadPlugins();
    expect(reloaded.ok).toBe(true);
    expect(reloaded.output).toContain('Reapplied 1 session disable override(s).');
    expect(reloaded.data.disabledPlugins).toBe(1);
    expect(reloaded.data.sessionDisabledPlugins).toEqual(['beta']);
  });

  it('returns helpful error message for unknown plugin', () => {
    const root = mkdtempSync(join(tmpdir(), 'open-agent-plugin-helpers-'));
    tempDirs.push(root);
    const pluginDir = join(root, 'plugins');
    mkdirSync(pluginDir, { recursive: true });
    createPlugin(pluginDir, 'alpha');

    const helpers = new PluginCommandHelpers({ cwd: root, pluginDirectory: pluginDir });
    const result = helpers.disablePlugin('not-exist');
    expect(result.ok).toBe(false);
    expect(result.output).toContain('Plugin not found: not-exist');
    expect(result.output).toContain('Available plugins: alpha');
  });
});
