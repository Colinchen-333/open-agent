import { join } from 'path';
import { homedir } from 'os';
import { PluginLoader } from '@open-agent/plugins';
import type { LoadedPlugin } from '@open-agent/plugins';
import { SkillRegistry } from '@open-agent/skills';

export interface PluginCommandHelpersOptions {
  cwd: string;
  pluginDirectory?: string;
  skillDirectories?: string[];
}

export interface PluginSnapshot {
  name: string;
  version: string;
  enabled: boolean;
  description?: string;
  author?: string;
  path: string;
  skills: number;
  commands: number;
  agents: number;
  mcpServers: number;
  hooks: number;
}

export interface PluginListData {
  pluginDirectory: string;
  totalPlugins: number;
  enabledPlugins: number;
  disabledPlugins: number;
  enabledPluginSkillCount: number;
  discoveredPluginSkillCount: number;
  sessionDisabledPlugins: string[];
  persistence: 'session';
  persistenceNote: string;
  plugins: PluginSnapshot[];
}

export interface PluginCommandResult<T = undefined> {
  ok: boolean;
  output: string;
  data: T;
}

export interface PluginToggleData {
  pluginName: string;
  enabled: boolean;
  persistence: 'session';
  sessionDisabledPlugins: string[];
}

const SESSION_PERSISTENCE_NOTE =
  'Plugin enable/disable state is session-only. It is not persisted to settings.json, and resets after process restart.';

export class PluginCommandHelpers {
  private readonly cwd: string;
  private readonly pluginDirectory: string;
  private readonly skillDirectories: string[] | undefined;
  private loader: PluginLoader | null = null;
  private readonly sessionDisabledPlugins = new Set<string>();

  constructor(options: PluginCommandHelpersOptions) {
    this.cwd = options.cwd;
    this.pluginDirectory = options.pluginDirectory ?? join(homedir(), '.open-agent', 'plugins');
    this.skillDirectories = options.skillDirectories;
  }

  listPlugins(): PluginCommandResult<PluginListData> {
    const snapshot = this.getSnapshot();
    return {
      ok: true,
      output: this.formatPluginList(snapshot),
      data: snapshot,
    };
  }

  reloadPlugins(): PluginCommandResult<PluginListData> {
    this.loader = this.createAndLoadLoader();
    const snapshot = this.getSnapshot();
    const lines = [
      `Reloaded plugins from: ${this.pluginDirectory}`,
      `Detected ${snapshot.totalPlugins} plugin(s).`,
      this.sessionDisabledPlugins.size > 0
        ? `Reapplied ${this.sessionDisabledPlugins.size} session disable override(s).`
        : 'No session disable overrides to reapply.',
      '',
      this.formatPluginList(snapshot),
    ];
    return {
      ok: true,
      output: lines.join('\n'),
      data: snapshot,
    };
  }

  enablePlugin(pluginName: string): PluginCommandResult<PluginToggleData> {
    return this.setPluginEnabled(pluginName, true);
  }

  disablePlugin(pluginName: string): PluginCommandResult<PluginToggleData> {
    return this.setPluginEnabled(pluginName, false);
  }

  private setPluginEnabled(pluginName: string, enabled: boolean): PluginCommandResult<PluginToggleData> {
    const trimmed = pluginName.trim();
    if (!trimmed) {
      return {
        ok: false,
        output: 'Plugin name is required. Usage: /plugin <enable|disable> <name>',
        data: undefined,
      } as PluginCommandResult<PluginToggleData>;
    }

    this.ensureLoader();
    const resolvedName = this.resolvePluginName(trimmed);
    if (!resolvedName) {
      const names = this.loader!.getAll().map((plugin) => plugin.manifest.name).sort();
      const suffix = names.length > 0
        ? `\nAvailable plugins: ${names.join(', ')}`
        : '\nNo plugins are currently loaded.';
      return {
        ok: false,
        output: `Plugin not found: ${trimmed}${suffix}`,
        data: undefined,
      } as PluginCommandResult<PluginToggleData>;
    }

    this.loader!.setEnabled(resolvedName, enabled);
    if (enabled) {
      this.sessionDisabledPlugins.delete(resolvedName);
    } else {
      this.sessionDisabledPlugins.add(resolvedName);
    }

    const payload: PluginToggleData = {
      pluginName: resolvedName,
      enabled,
      persistence: 'session',
      sessionDisabledPlugins: this.getSessionDisabledPlugins(),
    };

    const lines = [
      `${enabled ? 'Enabled' : 'Disabled'} plugin: ${resolvedName}`,
      'Persistence scope: session',
      SESSION_PERSISTENCE_NOTE,
    ];

    return {
      ok: true,
      output: lines.join('\n'),
      data: payload,
    };
  }

  private getSnapshot(): PluginListData {
    this.ensureLoader();
    const plugins = this.loader!.getAll().map((plugin) => this.toPluginSnapshot(plugin));
    const enabledPlugins = plugins.filter((plugin) => plugin.enabled).length;
    const discoveredPluginSkillCount = this.getDiscoveredPluginSkillCount();

    return {
      pluginDirectory: this.pluginDirectory,
      totalPlugins: plugins.length,
      enabledPlugins,
      disabledPlugins: plugins.length - enabledPlugins,
      enabledPluginSkillCount: this.loader!.getAllSkills().length,
      discoveredPluginSkillCount,
      sessionDisabledPlugins: this.getSessionDisabledPlugins(),
      persistence: 'session',
      persistenceNote: SESSION_PERSISTENCE_NOTE,
      plugins: plugins.sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  private ensureLoader(): void {
    if (!this.loader) {
      this.loader = this.createAndLoadLoader();
    }
  }

  private createAndLoadLoader(): PluginLoader {
    const loader = new PluginLoader();
    loader.loadAllFromDirectory(this.pluginDirectory);
    for (const disabledPlugin of this.sessionDisabledPlugins) {
      loader.setEnabled(disabledPlugin, false);
    }
    return loader;
  }

  private resolvePluginName(name: string): string | null {
    const plugins = this.loader!.getAll();
    const exact = plugins.find((plugin) => plugin.manifest.name === name);
    if (exact) return exact.manifest.name;

    const normalized = name.toLowerCase();
    const insensitive = plugins.find((plugin) => plugin.manifest.name.toLowerCase() === normalized);
    return insensitive?.manifest.name ?? null;
  }

  private getDiscoveredPluginSkillCount(): number {
    const skillRegistry = new SkillRegistry({
      cwd: this.cwd,
      pluginDirectory: this.pluginDirectory,
      skillDirectories: this.skillDirectories,
      includePluginSkills: true,
    });
    skillRegistry.load();
    return skillRegistry
      .list()
      .filter((entry) => entry.source.startsWith('plugin:'))
      .length;
  }

  private toPluginSnapshot(plugin: LoadedPlugin): PluginSnapshot {
    return {
      name: plugin.manifest.name,
      version: plugin.manifest.version,
      enabled: plugin.enabled,
      description: plugin.manifest.description,
      author: plugin.manifest.author,
      path: plugin.path,
      skills: plugin.manifest.skills?.length ?? 0,
      commands: plugin.manifest.commands?.length ?? 0,
      agents: Object.keys(plugin.manifest.agents ?? {}).length,
      mcpServers: Object.keys(plugin.manifest.mcpServers ?? {}).length,
      hooks: Object.keys(plugin.manifest.hooks ?? {}).length,
    };
  }

  private getSessionDisabledPlugins(): string[] {
    return [...this.sessionDisabledPlugins].sort((a, b) => a.localeCompare(b));
  }

  private formatPluginList(snapshot: PluginListData): string {
    if (snapshot.totalPlugins === 0) {
      return [
        `No plugins found in: ${snapshot.pluginDirectory}`,
        '',
        `Persistence: ${snapshot.persistence}`,
        snapshot.persistenceNote,
      ].join('\n');
    }

    const lines: string[] = [];
    lines.push(`Plugins (${snapshot.totalPlugins}) from ${snapshot.pluginDirectory}:`);
    for (const plugin of snapshot.plugins) {
      lines.push(
        `  - ${plugin.name}@${plugin.version} [${plugin.enabled ? 'enabled' : 'disabled'}] ` +
        `skills:${plugin.skills} commands:${plugin.commands} agents:${plugin.agents} ` +
        `mcp:${plugin.mcpServers} hooks:${plugin.hooks}`,
      );
    }
    lines.push('');
    lines.push(
      `Enabled: ${snapshot.enabledPlugins} | Disabled: ${snapshot.disabledPlugins}`,
    );
    lines.push(
      `Enabled plugin skills (PluginLoader): ${snapshot.enabledPluginSkillCount}`,
    );
    lines.push(
      `Discovered plugin skills on disk (SkillRegistry): ${snapshot.discoveredPluginSkillCount}`,
    );
    if (snapshot.sessionDisabledPlugins.length > 0) {
      lines.push(
        `Session disabled plugins: ${snapshot.sessionDisabledPlugins.join(', ')}`,
      );
    }
    lines.push(`Persistence: ${snapshot.persistence}`);
    lines.push(snapshot.persistenceNote);
    return lines.join('\n');
  }
}

export function createPluginCommandHelpers(
  options: PluginCommandHelpersOptions,
): PluginCommandHelpers {
  return new PluginCommandHelpers(options);
}
