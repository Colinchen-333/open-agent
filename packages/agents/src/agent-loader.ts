import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { AgentDefinition } from '@open-agent/core';
import { BUILTIN_AGENT_TYPES } from './types';

export class AgentLoader {
  private agents: Map<string, AgentDefinition> = new Map();

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
  loadFromDirectory(dir: string): void {
    if (!existsSync(dir)) return;
    const files = readdirSync(dir).filter(f => f.endsWith('.md'));

    for (const file of files) {
      const content = readFileSync(join(dir, file), 'utf-8');
      const agent = this.parseAgentMd(content);
      if (agent) {
        const name = file.replace('.md', '');
        this.agents.set(name, agent);
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
    this.loadFromDirectory(join(homedir(), '.open-agent', 'agents'));
    // 3. Project-level agents (.open-agent/agents/) overlay everything above
    this.loadFromDirectory(join(cwd, '.open-agent', 'agents'));
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

      // Key-value pair
      const kvMatch = line.match(/^(\w+):\s*(.*)$/);
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

    return {
      description: (meta.description as string) || '',
      tools: meta.tools as string[] | undefined,
      disallowedTools: meta.disallowedTools as string[] | undefined,
      prompt: body.trim(),
      model: meta.model as AgentDefinition['model'],
      maxTurns: meta.maxTurns ? parseInt(meta.maxTurns as string, 10) : undefined,
    };
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
}
