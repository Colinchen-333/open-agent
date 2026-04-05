import { existsSync, readFileSync, readdirSync } from 'fs';
import { basename, join } from 'path';
import { homedir } from 'os';
import { PluginLoader } from '@open-agent/plugins';

export interface SkillDefinition {
  name: string;
  description: string;
  prompt: string;
  source: 'local' | 'plugin';
  sourceLabel: string;
  path?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  activationKeywords?: string[];
  /**
   * When false, the skill is hidden from the user-facing /skills list and
   * cannot be directly invoked by the user. Defaults to true when absent.
   */
  userInvocable?: boolean;
}

export interface SkillCatalogEntry {
  name: string;
  description: string;
  source: string;
  path?: string;
  /**
   * When false, the skill is hidden from the user-facing /skills list and
   * cannot be directly invoked by the user. Defaults to true when absent.
   */
  userInvocable?: boolean;
}

export interface ResolvedSkillInvocation {
  name: string;
  description: string;
  prompt: string;
  source: string;
  path?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
}

export interface SkillRegistryOptions {
  cwd: string;
  skillDirectories?: string[];
  includePluginSkills?: boolean;
  pluginDirectory?: string;
}

function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};

  const meta: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const m = line.match(/^([^:]+):\s*(.+)$/);
    if (m) meta[m[1].trim()] = m[2].trim().replace(/^['"]|['"]$/g, '');
  }
  return meta;
}

function stripFrontmatter(content: string): string {
  const match = content.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
  return match ? match[1].trim() : content.trim();
}

function normalizeList(value?: string): string[] | undefined {
  if (!value) return undefined;
  const items = value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function expandSkillPrompt(prompt: string, args?: string): string {
  if (!args) return prompt;

  let expanded = prompt
    .replace(/\$ARGUMENTS/g, args)
    .replace(/\{\{args\}\}/g, args)
    .replace(/\{args\}/g, args);

  if (expanded === prompt) {
    expanded = `${expanded}\n\n${args}`;
  }
  return expanded;
}

function parseUserInvocable(value?: string): boolean | undefined {
  if (value === undefined) return undefined;
  const lower = value.toLowerCase();
  if (lower === 'false' || lower === '0' || lower === 'no') return false;
  return true;
}

function parseSkillMarkdown(
  content: string,
  filePath: string,
  source: SkillDefinition['source'],
  sourceLabel: string,
): SkillDefinition {
  const frontmatter = parseFrontmatter(content);
  const prompt = stripFrontmatter(content);
  const userInvocable = parseUserInvocable(
    frontmatter.userInvocable ?? frontmatter['user-invocable'],
  );
  return {
    name: frontmatter.name || basename(filePath).replace(/\.md$/, ''),
    description: frontmatter.description || '',
    prompt,
    source,
    sourceLabel,
    path: filePath,
    allowedTools: normalizeList(frontmatter.allowedTools ?? frontmatter['allowed-tools']),
    disallowedTools: normalizeList(frontmatter.disallowedTools ?? frontmatter['disallowed-tools']),
    activationKeywords: normalizeList(frontmatter.activationKeywords),
    ...(userInvocable !== undefined ? { userInvocable } : {}),
  };
}

export class SkillRegistry {
  private readonly options: SkillRegistryOptions;
  private readonly skills = new Map<string, SkillDefinition>();

  constructor(options: SkillRegistryOptions) {
    this.options = options;
  }

  load(): void {
    this.loadLocalSkills();
    if (this.options.includePluginSkills !== false) {
      this.loadPluginSkills();
    }
  }

  register(skill: SkillDefinition): void {
    this.skills.set(skill.name, skill);
  }

  list(): SkillCatalogEntry[] {
    return [...this.skills.values()]
      .map((skill) => ({
        name: skill.name,
        description: skill.description,
        source: skill.sourceLabel,
        ...(skill.path ? { path: skill.path } : {}),
        ...(skill.userInvocable === false ? { userInvocable: false } : {}),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string): SkillDefinition | undefined {
    return this.skills.get(name);
  }

  resolve(name: string, args?: string): ResolvedSkillInvocation | null {
    const skill = this.skills.get(name);
    if (!skill) return null;

    return {
      name: skill.name,
      description: skill.description,
      prompt: expandSkillPrompt(skill.prompt, args),
      source: skill.sourceLabel,
      ...(skill.path ? { path: skill.path } : {}),
      ...(skill.allowedTools ? { allowedTools: [...skill.allowedTools] } : {}),
      ...(skill.disallowedTools ? { disallowedTools: [...skill.disallowedTools] } : {}),
    };
  }

  private loadLocalSkills(): void {
    const directories = [...new Set([
      ...(this.options.skillDirectories ?? []),
      join(homedir(), '.open-agent', 'skills'),
      join(this.options.cwd, '.open-agent', 'skills'),
    ])];

    for (const dir of directories) {
      if (!existsSync(dir)) continue;
      for (const file of readdirSync(dir).filter((entry) => entry.endsWith('.md'))) {
        const fullPath = join(dir, file);
        const content = readFileSync(fullPath, 'utf-8');
        this.register(parseSkillMarkdown(content, fullPath, 'local', dir));
      }
    }
  }

  private loadPluginSkills(): void {
    const loader = new PluginLoader();
    loader.loadAllFromDirectory(this.options.pluginDirectory);
    for (const plugin of loader.getAll()) {
      for (const skill of plugin.manifest.skills ?? []) {
        this.register({
          name: skill.name,
          description: skill.description,
          prompt: skill.prompt,
          source: 'plugin',
          sourceLabel: `plugin:${plugin.manifest.name}`,
          allowedTools: skill.allowedTools,
          activationKeywords: skill.activationKeywords,
        });
      }
    }
  }
}
