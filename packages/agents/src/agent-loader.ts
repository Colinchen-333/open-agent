import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { AgentDefinition } from '@open-agent/core';
import { loadMarkdownConfig } from '@open-agent/core';
import { BUILTIN_AGENT_TYPES } from './types';

export interface AgentLoaderDiagnostic {
  code: 'agent_invalid_definition' | 'agent_parse_failed' | 'agent_override';
  message: string;
  severity: 'warning' | 'error';
  source: 'agent';
  agentName?: string;
  filePath?: string;
  layer?: 'builtin' | 'user' | 'project';
}

export class AgentLoader {
  private agents: Map<string, AgentDefinition> = new Map();
  private diagnostics: AgentLoaderDiagnostic[] = [];

  constructor() {
    // Load built-in agents
    for (const [name, def] of Object.entries(BUILTIN_AGENT_TYPES)) {
      this.agents.set(name, def);
    }
  }

  /**
   * Returns the hardcoded built-in agent definitions for all built-in agent types.
   * These are always available regardless of any on-disk configuration.
   */
  getBuiltinAgents(): Record<string, AgentDefinition> {
    return { ...BUILTIN_AGENT_TYPES };
  }

  // Load custom agents from .md files in a directory
  loadFromDirectory(dir: string, layer: 'user' | 'project' = 'project'): void {
    if (!existsSync(dir)) return;
    const files = readdirSync(dir).filter(f => f.endsWith('.md'));

    for (const file of files) {
      const filePath = join(dir, file);
      const name = file.replace('.md', '');
      try {
        const content = readFileSync(filePath, 'utf-8');
        const agent = this.parseAgentMd(content);
        if (agent) {
          if (!this.isValidAgentDefinition(agent)) {
            this.diagnostics.push({
              code: 'agent_invalid_definition',
              message: `Agent "${name}" from ${filePath} is missing required schema fields.`,
              severity: 'warning',
              source: 'agent',
              agentName: name,
              filePath,
              layer,
            });
            continue;
          }
          if (this.agents.has(name)) {
            this.diagnostics.push({
              code: 'agent_override',
              message: `Agent "${name}" from ${filePath} overrides an earlier ${this.isBuiltinAgent(name) ? 'builtin' : 'loaded'} definition.`,
              severity: 'warning',
              source: 'agent',
              agentName: name,
              filePath,
              layer,
            });
          }
          this.agents.set(name, agent);
        }
      } catch {
        this.diagnostics.push({
          code: 'agent_parse_failed',
          message: `Failed to parse agent "${name}" from ${filePath}.`,
          severity: 'warning',
          source: 'agent',
          agentName: name,
          filePath,
          layer,
        });
      }
    }
  }

  // Load agents from default directories.
  // Built-in agents are registered first so that on-disk definitions can override them.
  loadDefaults(cwd: string): void {
    // 1. Register built-in agents as the base layer
    for (const [name, def] of Object.entries(this.getBuiltinAgents())) {
      this.agents.set(name, def);
    }
    // 2. User-level agents (~/.open-agent/agents/) overlay built-ins
    this.loadFromDirectory(join(homedir(), '.open-agent', 'agents'), 'user');
    // 3. Project-level agents (.open-agent/agents/) overlay everything above
    this.loadFromDirectory(join(cwd, '.open-agent', 'agents'), 'project');
  }

  // Parse .md format agent definition (YAML frontmatter + prompt body)
  private parseAgentMd(content: string): AgentDefinition | null {
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!frontmatterMatch) {
      // No frontmatter — treat entire content as prompt
      return { description: '', prompt: content.trim() };
    }

    const [, frontmatter, body] = frontmatterMatch;
    const meta: Record<string, unknown> = {};

    // Simple YAML parsing (key: value pairs, inline arrays, block sequences)
    const fmLines = frontmatter.split('\n');
    let currentKey: string | null = null;
    let blockList: string[] | null = null;

    const flushBlockList = () => {
      if (currentKey && blockList) {
        meta[currentKey] = blockList;
        blockList = null;
        currentKey = null;
      }
    };

    for (const line of fmLines) {
      // Block sequence item: "  - value"
      const listItemMatch = line.match(/^\s+-\s+(.+)$/);
      if (listItemMatch && currentKey) {
        if (!blockList) blockList = [];
        blockList.push(listItemMatch[1].replace(/['"]/g, '').trim());
        continue;
      }

      // Key-value pair (supports both camelCase and kebab-case keys)
      const kvMatch = line.match(/^([\w-]+):\s*(.*)$/);
      if (kvMatch) {
        flushBlockList();
        const [, key, value] = kvMatch;
        if (!value.trim()) {
          // Empty value — expect block sequence on subsequent lines
          currentKey = key;
          blockList = [];
        } else if (value.startsWith('[') && value.endsWith(']')) {
          // Inline array: [a, b, c]
          meta[key] = value
            .slice(1, -1)
            .split(',')
            .map(s => s.trim().replace(/['"]/g, ''));
        } else {
          meta[key] = value.replace(/['"]/g, '').trim();
        }
      }
    }
    flushBlockList();

    const effort = typeof meta.effort === 'string' && ['low', 'medium', 'high', 'max'].includes(meta.effort)
      ? (meta.effort as AgentDefinition['effort'])
      : undefined;

    const permissionMode = typeof meta.permissionMode === 'string' || typeof meta['permission-mode'] === 'string'
      ? ((meta.permissionMode ?? meta['permission-mode']) as AgentDefinition['permissionMode'])
      : undefined;

    const mcpServersParsed = Array.isArray(meta.mcpServers)
      ? (meta.mcpServers as string[])
      : Array.isArray(meta['mcp-servers'])
        ? (meta['mcp-servers'] as string[])
        : undefined;

    const memory = typeof meta.memory === 'string' ? meta.memory : undefined;

    const background = typeof meta.background === 'boolean'
      ? meta.background
      : typeof meta.background === 'string'
        ? (meta.background as string).toLowerCase() === 'true'
        : undefined;

    const requiredMcpServers = Array.isArray(meta.requiredMcpServers)
      ? (meta.requiredMcpServers as string[])
      : Array.isArray(meta['required-mcp-servers'])
        ? (meta['required-mcp-servers'] as string[])
        : undefined;

    const omitClaudeMd = typeof meta.omitClaudeMd === 'boolean'
      ? meta.omitClaudeMd
      : typeof meta['omit-claude-md'] === 'boolean'
        ? (meta['omit-claude-md'] as boolean)
        : typeof meta.omitClaudeMd === 'string'
          ? (meta.omitClaudeMd as string).toLowerCase() === 'true'
          : undefined;

    const hooks = (meta.hooks && typeof meta.hooks === 'object' && !Array.isArray(meta.hooks))
      ? (meta.hooks as Record<string, unknown>)
      : undefined;

    return {
      description: (meta.description as string) || '',
      tools: meta.tools as string[] | undefined,
      disallowedTools: meta.disallowedTools as string[] | undefined,
      prompt: body.trim(),
      model: meta.model as AgentDefinition['model'],
      maxTurns: meta.maxTurns ? parseInt(meta.maxTurns as string, 10) : undefined,
      ...(effort !== undefined && { effort }),
      ...(permissionMode !== undefined && { permissionMode }),
      ...(mcpServersParsed !== undefined && { mcpServers: mcpServersParsed }),
      ...(memory !== undefined && { memory }),
      ...(background !== undefined && { background }),
      ...(requiredMcpServers !== undefined && { requiredMcpServers }),
      ...(omitClaudeMd !== undefined && { omitClaudeMd }),
      ...(hooks !== undefined && { hooks }),
    };
  }

  private isValidAgentDefinition(definition: AgentDefinition): boolean {
    if (!definition || typeof definition !== 'object') return false;
    if (typeof definition.description !== 'string') return false;
    if (typeof definition.prompt !== 'string' || definition.prompt.trim().length === 0) return false;
    if (definition.tools !== undefined && !Array.isArray(definition.tools)) return false;
    if (definition.disallowedTools !== undefined && !Array.isArray(definition.disallowedTools)) return false;
    if (definition.skills !== undefined && !Array.isArray(definition.skills)) return false;
    return true;
  }

  private isBuiltinAgent(name: string): boolean {
    return Object.prototype.hasOwnProperty.call(BUILTIN_AGENT_TYPES, name);
  }

  // Programmatically register an agent
  register(name: string, definition: AgentDefinition): void {
    this.agents.set(name, definition);
  }

  get(name: string): AgentDefinition | undefined {
    return this.agents.get(name);
  }

  list(): [string, AgentDefinition][] {
    return Array.from(this.agents.entries());
  }

  getDiagnostics(): AgentLoaderDiagnostic[] {
    return this.diagnostics.map((entry) => ({ ...entry }));
  }
}

/**
 * Load user-defined agents from the two standard `.claude/agents/` directories
 * using the shared markdown config loader infrastructure.
 *
 * - `<home>/.claude/agents/*.md`  (user layer)
 * - `<cwd>/.claude/agents/*.md`   (project layer — wins on name collision)
 *
 * This is an additive alternative to `AgentLoader.loadDefaults()`. It returns
 * plain `AgentDefinition` objects without the diagnostic machinery of the class.
 */
export async function loadUserAgents(
  cwd: string,
  home?: string,
): Promise<AgentDefinition[]> {
  const entries = await loadMarkdownConfig({ subdir: 'agents', cwd, home });

  return entries.map(entry => {
    const fm = entry.frontmatter;

    const tools = Array.isArray(fm.tools)
      ? (fm.tools as string[])
      : undefined;

    const disallowedTools = Array.isArray(fm.disallowedTools)
      ? (fm.disallowedTools as string[])
      : undefined;

    const skills = Array.isArray(fm.skills)
      ? (fm.skills as string[])
      : undefined;

    const effort = typeof fm.effort === 'string' && ['low', 'medium', 'high', 'max'].includes(fm.effort)
      ? (fm.effort as AgentDefinition['effort'])
      : undefined;

    const permissionMode = typeof fm.permissionMode === 'string' || typeof fm['permission-mode'] === 'string'
      ? ((fm.permissionMode ?? fm['permission-mode']) as AgentDefinition['permissionMode'])
      : undefined;

    const mcpServers = Array.isArray(fm.mcpServers)
      ? (fm.mcpServers as string[])
      : Array.isArray(fm['mcp-servers'])
        ? (fm['mcp-servers'] as string[])
        : undefined;

    const memory = typeof fm.memory === 'string' ? fm.memory : undefined;

    const background = typeof fm.background === 'boolean'
      ? fm.background
      : typeof fm.background === 'string'
        ? (fm.background as string).toLowerCase() === 'true'
        : undefined;

    const requiredMcpServers = Array.isArray(fm.requiredMcpServers)
      ? (fm.requiredMcpServers as string[])
      : Array.isArray(fm['required-mcp-servers'])
        ? (fm['required-mcp-servers'] as string[])
        : undefined;

    const omitClaudeMd = typeof fm.omitClaudeMd === 'boolean'
      ? fm.omitClaudeMd
      : typeof fm['omit-claude-md'] === 'boolean'
        ? (fm['omit-claude-md'] as boolean)
        : typeof fm.omitClaudeMd === 'string'
          ? (fm.omitClaudeMd as string).toLowerCase() === 'true'
          : undefined;

    const hooks = (fm.hooks && typeof fm.hooks === 'object' && !Array.isArray(fm.hooks))
      ? (fm.hooks as Record<string, unknown>)
      : undefined;

    return {
      name: typeof fm.name === 'string' ? fm.name : entry.name,
      description: typeof fm.description === 'string' ? fm.description : '',
      prompt: entry.body,
      tools,
      disallowedTools,
      skills,
      model: typeof fm.model === 'string'
        ? (fm.model as AgentDefinition['model'])
        : undefined,
      maxTurns: typeof fm.maxTurns === 'number'
        ? fm.maxTurns
        : typeof fm.maxTurns === 'string'
          ? parseInt(fm.maxTurns, 10)
          : undefined,
      mode: typeof fm.mode === 'string'
        ? (fm.mode as AgentDefinition['mode'])
        : undefined,
      isolation: typeof fm.isolation === 'string'
        ? (fm.isolation as AgentDefinition['isolation'])
        : undefined,
      allowBackgroundExecution: typeof fm.allowBackgroundExecution === 'boolean'
        ? fm.allowBackgroundExecution
        : undefined,
      ...(effort !== undefined && { effort }),
      ...(permissionMode !== undefined && { permissionMode }),
      ...(mcpServers !== undefined && { mcpServers }),
      ...(memory !== undefined && { memory }),
      ...(background !== undefined && { background }),
      ...(requiredMcpServers !== undefined && { requiredMcpServers }),
      ...(omitClaudeMd !== undefined && { omitClaudeMd }),
      ...(hooks !== undefined && { hooks }),
    } satisfies AgentDefinition;
  });
}
