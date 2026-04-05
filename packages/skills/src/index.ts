import { existsSync, readFileSync, readdirSync } from 'fs';
import { basename, join } from 'path';
import { homedir } from 'os';
import { PluginLoader } from '@open-agent/plugins';
import { loadMarkdownConfig } from '@open-agent/core';

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

// ---------------------------------------------------------------------------
// User-defined skills via ~/.claude/skills/*.md and <cwd>/.claude/skills/*.md
// ---------------------------------------------------------------------------

/**
 * Coerce a frontmatter value for the userInvocable field.
 * The core frontmatter parser returns booleans for `true`/`false` literals, but
 * older YAML-like files may store the value as a string.
 */
function coerceUserInvocable(
  raw: string | boolean | number | string[] | undefined,
): boolean | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number') return raw !== 0;
  if (typeof raw === 'string') {
    const lower = raw.toLowerCase();
    if (lower === 'false' || lower === '0' || lower === 'no') return false;
    return true;
  }
  return undefined;
}

/**
 * Load user-defined skill definitions from:
 *   - `<home>/.claude/skills/*.md`  (user layer)
 *   - `<cwd>/.claude/skills/*.md`   (project layer, takes precedence)
 *
 * The returned array contains `SkillDefinition` objects that can be passed
 * to `SkillRegistry.register()`. If a project-layer file and a user-layer
 * file share the same name, the project layer wins (handled by `loadMarkdownConfig`).
 */
export async function loadUserSkills(
  cwd: string,
  home?: string,
): Promise<SkillDefinition[]> {
  const entries = await loadMarkdownConfig({ subdir: 'skills', cwd, home });

  return entries.map((entry) => {
    const fm = entry.frontmatter;

    const name = (fm.name as string | undefined) ?? entry.name;
    const description = (fm.description as string | undefined) ?? '';
    const userInvocable = coerceUserInvocable(
      (fm.userInvocable ?? fm['user-invocable']) as
        | string
        | boolean
        | number
        | undefined,
    );

    const allowedToolsRaw = fm.allowedTools ?? fm['allowed-tools'];
    const disallowedToolsRaw = fm.disallowedTools ?? fm['disallowed-tools'];
    const activationKeywordsRaw = fm.activationKeywords;

    const toStringArray = (
      v: string | boolean | number | string[] | undefined,
    ): string[] | undefined => {
      if (!v) return undefined;
      if (Array.isArray(v)) return v.length > 0 ? v : undefined;
      if (typeof v === 'string') {
        const items = v
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        return items.length > 0 ? items : undefined;
      }
      return undefined;
    };

    const def: SkillDefinition = {
      name,
      description,
      prompt: entry.body,
      source: 'local',
      sourceLabel: entry.source === 'project' ? entry.filePath : entry.filePath,
      path: entry.filePath,
      allowedTools: toStringArray(allowedToolsRaw),
      disallowedTools: toStringArray(disallowedToolsRaw),
      activationKeywords: toStringArray(activationKeywordsRaw),
      ...(userInvocable !== undefined ? { userInvocable } : {}),
    };

    return def;
  });
}

/**
 * Augment an existing `SkillRegistry` with user-defined markdown skills.
 * Loaded skills override bundled skills with the same name (user-defined
 * project skills take priority over built-in defaults).
 *
 * This is intentionally free-standing rather than wired into `SkillRegistry.load()`
 * to keep the load path synchronous and allow callers to control when async I/O
 * occurs during initialisation.
 *
 * @param registry - The registry to augment in place.
 * @param cwd      - Project root directory.
 * @param home     - User home directory (defaults to `os.homedir()`).
 */
export async function augmentRegistryWithUserSkills(
  registry: SkillRegistry,
  cwd: string,
  home?: string,
): Promise<void> {
  const skills = await loadUserSkills(cwd, home);
  for (const skill of skills) {
    registry.register(skill);
  }
}
