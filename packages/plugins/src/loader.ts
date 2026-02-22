import { existsSync, readFileSync, readdirSync } from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';
import type { AgentDefinition } from '@open-agent/core';
import type { PluginManifest, LoadedPlugin, SkillDefinition, CommandDefinition } from './types.js';

export class PluginLoader {
  private plugins: Map<string, LoadedPlugin> = new Map();

  // 从目录加载插件
  loadPlugin(pluginPath: string): LoadedPlugin | null {
    const absPath = resolve(pluginPath);

    // 查找 manifest
    const manifestPath = join(absPath, 'plugin.json');
    if (!existsSync(manifestPath)) {
      console.warn(`Plugin manifest not found: ${manifestPath}`);
      return null;
    }

    try {
      const manifest: PluginManifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));

      // 加载 skills（从 skills/ 目录读取 .md 文件）
      const skillsDir = join(absPath, 'skills');
      if (existsSync(skillsDir)) {
        manifest.skills = manifest.skills || [];
        for (const file of readdirSync(skillsDir).filter((f) => f.endsWith('.md'))) {
          const skill = this.parseSkillMd(join(skillsDir, file));
          if (skill) manifest.skills.push(skill);
        }
      }

      // 加载 commands（从 commands/ 目录读取 .md 文件）
      const commandsDir = join(absPath, 'commands');
      if (existsSync(commandsDir)) {
        manifest.commands = manifest.commands || [];
        for (const file of readdirSync(commandsDir).filter((f) => f.endsWith('.md'))) {
          const cmd = this.parseCommandMd(join(commandsDir, file));
          if (cmd) manifest.commands.push(cmd);
        }
      }

      // 加载 agents（从 agents/ 目录读取 .md 文件）
      const agentsDir = join(absPath, 'agents');
      if (existsSync(agentsDir)) {
        manifest.agents = manifest.agents || {};
        for (const file of readdirSync(agentsDir).filter((f) => f.endsWith('.md'))) {
          const name = file.replace('.md', '');
          const agent = this.parseAgentMd(join(agentsDir, file));
          if (agent) manifest.agents[name] = agent;
        }
      }

      // 加载 hooks 配置
      const hooksPath = join(absPath, 'hooks', 'hooks.json');
      if (existsSync(hooksPath)) {
        try {
          manifest.hooks = JSON.parse(readFileSync(hooksPath, 'utf-8'));
        } catch {
          // 忽略无效的 hooks.json，继续加载插件
        }
      }

      const plugin: LoadedPlugin = { manifest, path: absPath, enabled: true };
      this.plugins.set(manifest.name, plugin);
      return plugin;
    } catch (error) {
      console.error(`Failed to load plugin from ${absPath}:`, error);
      return null;
    }
  }

  // 从全局插件目录加载所有插件
  loadAllFromDirectory(dir?: string): void {
    const pluginDir = dir || join(homedir(), '.open-agent', 'plugins');
    if (!existsSync(pluginDir)) return;

    for (const entry of readdirSync(pluginDir)) {
      const fullPath = join(pluginDir, entry);
      if (existsSync(join(fullPath, 'plugin.json'))) {
        this.loadPlugin(fullPath);
      }
    }
  }

  // 解析 skill .md
  private parseSkillMd(filePath: string): SkillDefinition | null {
    const content = readFileSync(filePath, 'utf-8');
    const frontmatter = this.parseFrontmatter(content);
    const body = this.getBody(content);

    return {
      name: frontmatter['name'] || filePath.split('/').pop()?.replace('.md', '') || '',
      description: frontmatter['description'] || '',
      version: frontmatter['version'],
      prompt: body,
      activationKeywords: frontmatter['activationKeywords']
        ?.split(',')
        .map((s: string) => s.trim()),
      allowedTools: frontmatter['allowedTools']?.split(',').map((s: string) => s.trim()),
    };
  }

  // 解析 command .md
  private parseCommandMd(filePath: string): CommandDefinition | null {
    const content = readFileSync(filePath, 'utf-8');
    const frontmatter = this.parseFrontmatter(content);
    const body = this.getBody(content);

    return {
      name: frontmatter['name'] || filePath.split('/').pop()?.replace('.md', '') || '',
      description: frontmatter['description'] || '',
      argumentHint: frontmatter['argument-hint'],
      prompt: body,
      allowedTools: frontmatter['allowed-tools']?.split(',').map((s: string) => s.trim()),
    };
  }

  // 解析 agent .md
  private parseAgentMd(filePath: string): AgentDefinition | null {
    const content = readFileSync(filePath, 'utf-8');
    const frontmatter = this.parseFrontmatter(content);
    const body = this.getBody(content);

    return {
      description: frontmatter['description'] || '',
      tools: frontmatter['tools']?.split(',').map((s: string) => s.trim()),
      disallowedTools: frontmatter['disallowedTools']?.split(',').map((s: string) => s.trim()),
      prompt: body,
      model: frontmatter['model'] as AgentDefinition['model'],
    };
  }

  // 简单 YAML frontmatter 解析
  private parseFrontmatter(content: string): Record<string, string> {
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return {};

    const meta: Record<string, string> = {};
    for (const line of match[1].split('\n')) {
      const m = line.match(/^([^:]+):\s*(.+)$/);
      if (m) meta[m[1].trim()] = m[2].trim().replace(/^['"]|['"]$/g, '');
    }
    return meta;
  }

  private getBody(content: string): string {
    const match = content.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
    return match ? match[1].trim() : content.trim();
  }

  // 获取所有加载的插件
  getAll(): LoadedPlugin[] {
    return Array.from(this.plugins.values());
  }

  getPlugin(name: string): LoadedPlugin | undefined {
    return this.plugins.get(name);
  }

  // 获取所有 skills（仅已启用的插件）
  getAllSkills(): SkillDefinition[] {
    return this.getAll()
      .filter((p) => p.enabled)
      .flatMap((p) => p.manifest.skills || []);
  }

  // 获取所有 commands（仅已启用的插件）
  getAllCommands(): CommandDefinition[] {
    return this.getAll()
      .filter((p) => p.enabled)
      .flatMap((p) => p.manifest.commands || []);
  }

  // 启用/禁用插件
  setEnabled(name: string, enabled: boolean): void {
    const plugin = this.plugins.get(name);
    if (plugin) plugin.enabled = enabled;
  }
}
