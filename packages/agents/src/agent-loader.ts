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
   * Returns the hardcoded built-in agent definitions for the essential agent types.
   * These are always available regardless of any on-disk configuration.
   *
   * Included types:
   *  - Explore       : read-only codebase exploration (no Edit/Write/Task tools)
   *  - Plan          : planning agent (no Edit/Write tools)
   *  - code-writer   : full-capability code writing agent
   *  - general-purpose: all tools available
   */
  getBuiltinAgents(): Record<string, AgentDefinition> {
    return {
      Explore: {
        description: 'Read-only agent for exploring and understanding codebases without making any modifications.',
        tools: ['Read', 'Glob', 'Grep', 'Bash'],
        disallowedTools: ['Edit', 'Write', 'Task'],
        prompt:
          'You are a read-only exploration agent. Your job is to search, read, and understand code in order to answer questions accurately. You MUST NOT modify any files. Use Read, Glob, Grep, and Bash (for inspection commands only) to gather information.',
      },
      Plan: {
        description: 'Planning agent that designs implementation strategies without writing code.',
        tools: ['Read', 'Glob', 'Grep', 'Bash'],
        disallowedTools: ['Edit', 'Write'],
        prompt:
          'You are a planning agent. Your role is to design clear implementation strategies, identify the relevant files and functions, and produce an actionable plan. You MUST NOT write or edit any files. Focus on analysis and structured planning output.',
      },
      'code-writer': {
        description: 'Full-capability agent for writing new code and implementing features.',
        prompt:
          'You are a code writing agent. Implement features, create new functions, and write production-quality code as requested. Use all available tools to read existing code, make edits, run tests, and verify your work.',
      },
      'general-purpose': {
        description: 'General-purpose agent with all tools available for complex, multi-step tasks.',
        prompt:
          'You are a general-purpose agent. Handle complex, multi-step tasks autonomously. Use all available tools as needed to research, plan, implement, test, and verify your work.',
      },
    };
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

    // Simple YAML parsing (key: value pairs and inline arrays)
    for (const line of frontmatter.split('\n')) {
      const match = line.match(/^(\w+):\s*(.+)$/);
      if (match) {
        const [, key, value] = match;
        // Handle inline arrays: [a, b, c]
        if (value.startsWith('[') && value.endsWith(']')) {
          meta[key] = value
            .slice(1, -1)
            .split(',')
            .map(s => s.trim().replace(/['"]/g, ''));
        } else {
          meta[key] = value.replace(/['"]/g, '').trim();
        }
      }
    }

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
