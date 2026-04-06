import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { AgentLoader, loadUserAgents } from '../agent-loader.js';

describe('AgentLoader', () => {
  let loader: AgentLoader;
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'open-agent-agent-loader-'));
    loader = new AgentLoader();
    loader.loadDefaults(cwd);
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('loads all built-in agent types including verifier', () => {
    const agents = loader.list();
    const names = agents.map(([name]) => name);
    expect(names).toContain('Explore');
    expect(names).toContain('Plan');
    expect(names).toContain('code-writer');
    expect(names).toContain('general-purpose');
    expect(names).toContain('verifier');
    expect(names).toContain('architecture-logic-reviewer');
    expect(names).toContain('Bash');
    expect(names).toContain('open-agent-guide');
    expect(names).toContain('statusline-setup');
    expect(agents.length).toBeGreaterThanOrEqual(9);
  });

  describe('get()', () => {
    it('returns the correct agent by name', () => {
      const explore = loader.get('Explore');
      expect(explore).toBeDefined();
      expect(explore!.description).toContain('explor');
    });

    it('returns undefined for unknown agent', () => {
      expect(loader.get('non-existent-agent')).toBeUndefined();
    });
  });

  describe('list()', () => {
    it('returns all registered agents as [name, definition] pairs', () => {
      const agents = loader.list();
      expect(Array.isArray(agents)).toBe(true);
      for (const [name, def] of agents) {
        expect(typeof name).toBe('string');
        expect(typeof def.description).toBe('string');
        expect(typeof def.prompt).toBe('string');
      }
    });
  });

  describe('Explore agent', () => {
    it('has correct tools list', () => {
      const agent = loader.get('Explore')!;
      expect(agent.tools).toBeDefined();
      expect(agent.tools).toContain('Read');
      expect(agent.tools).toContain('Glob');
      expect(agent.tools).toContain('Grep');
      expect(agent.tools).toContain('Bash');
    });

    it('disallows Edit, Write, and Task tools', () => {
      const agent = loader.get('Explore')!;
      expect(agent.disallowedTools).toBeDefined();
      expect(agent.disallowedTools).toContain('Edit');
      expect(agent.disallowedTools).toContain('Write');
      expect(agent.disallowedTools).toContain('Task');
    });

    it('has mode set to default', () => {
      const agent = loader.get('Explore')!;
      expect(agent.mode).toBe('default');
    });

    it('allows background execution', () => {
      const agent = loader.get('Explore')!;
      expect(agent.allowBackgroundExecution).toBe(true);
    });
  });

  describe('Plan agent', () => {
    it('has correct tools list', () => {
      const agent = loader.get('Plan')!;
      expect(agent.tools).toContain('Read');
      expect(agent.tools).toContain('Glob');
      expect(agent.tools).toContain('Grep');
    });

    it('disallows Edit and Write tools', () => {
      const agent = loader.get('Plan')!;
      expect(agent.disallowedTools).toContain('Edit');
      expect(agent.disallowedTools).toContain('Write');
    });

    it('has mode set to plan', () => {
      const agent = loader.get('Plan')!;
      expect(agent.mode).toBe('plan');
    });
  });

  describe('Bash agent', () => {
    it('only has Bash tool', () => {
      const agent = loader.get('Bash')!;
      expect(agent).toBeDefined();
      expect(agent.tools).toBeDefined();
      expect(agent.tools!.length).toBe(1);
      expect(agent.tools![0]).toBe('Bash');
    });

    it('has mode set to bypassPermissions', () => {
      const agent = loader.get('Bash')!;
      expect(agent.mode).toBe('bypassPermissions');
    });

    it('has maxTurns set to 10', () => {
      const agent = loader.get('Bash')!;
      expect(agent.maxTurns).toBe(10);
    });

    it('has model set to inherit', () => {
      const agent = loader.get('Bash')!;
      expect(agent.model).toBe('inherit');
    });
  });

  describe('open-agent-guide agent', () => {
    it('has correct tools including WebSearch', () => {
      const agent = loader.get('open-agent-guide')!;
      expect(agent).toBeDefined();
      expect(agent.tools).toContain('Glob');
      expect(agent.tools).toContain('Grep');
      expect(agent.tools).toContain('Read');
      expect(agent.tools).toContain('WebFetch');
      expect(agent.tools).toContain('WebSearch');
    });

    it('disallows Edit, Write, Bash, and Task', () => {
      const agent = loader.get('open-agent-guide')!;
      expect(agent.disallowedTools).toContain('Edit');
      expect(agent.disallowedTools).toContain('Write');
      expect(agent.disallowedTools).toContain('Bash');
      expect(agent.disallowedTools).toContain('Task');
    });

    it('has model set to haiku', () => {
      const agent = loader.get('open-agent-guide')!;
      expect(agent.model).toBe('haiku');
    });

    it('has mode set to default', () => {
      const agent = loader.get('open-agent-guide')!;
      expect(agent.mode).toBe('default');
    });

    it('has maxTurns set to 15', () => {
      const agent = loader.get('open-agent-guide')!;
      expect(agent.maxTurns).toBe(15);
    });
  });

  describe('statusline-setup agent', () => {
    it('has Read and Edit tools', () => {
      const agent = loader.get('statusline-setup')!;
      expect(agent).toBeDefined();
      expect(agent.tools).toContain('Read');
      expect(agent.tools).toContain('Edit');
    });

    it('has mode set to acceptEdits', () => {
      const agent = loader.get('statusline-setup')!;
      expect(agent.mode).toBe('acceptEdits');
    });

    it('has model set to haiku', () => {
      const agent = loader.get('statusline-setup')!;
      expect(agent.model).toBe('haiku');
    });

    it('has maxTurns set to 5', () => {
      const agent = loader.get('statusline-setup')!;
      expect(agent.maxTurns).toBe(5);
    });
  });

  describe('code-writer agent', () => {
    it('has mode set to acceptEdits', () => {
      const agent = loader.get('code-writer')!;
      expect(agent.mode).toBe('acceptEdits');
    });

    it('allows background execution', () => {
      const agent = loader.get('code-writer')!;
      expect(agent.allowBackgroundExecution).toBe(true);
    });
  });

  describe('general-purpose agent', () => {
    it('has mode set to bypassPermissions', () => {
      const agent = loader.get('general-purpose')!;
      expect(agent.mode).toBe('bypassPermissions');
    });

    it('allows background execution', () => {
      const agent = loader.get('general-purpose')!;
      expect(agent.allowBackgroundExecution).toBe(true);
    });
  });

  describe('architecture-logic-reviewer agent', () => {
    it('is defined', () => {
      const agent = loader.get('architecture-logic-reviewer');
      expect(agent).toBeDefined();
    });

    it('has mode set to default', () => {
      const agent = loader.get('architecture-logic-reviewer')!;
      expect(agent.mode).toBe('default');
    });

    it('allows background execution', () => {
      const agent = loader.get('architecture-logic-reviewer')!;
      expect(agent.allowBackgroundExecution).toBe(true);
    });
  });

  describe('loadUserAgents()', () => {
    it('loads a .claude/agents/*.md file and returns an AgentDefinition', async () => {
      const tmpHome = mkdtempSync(join(tmpdir(), 'oa-lua-home-'));
      const agentDir = join(cwd, '.claude', 'agents');
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(
        join(agentDir, 'test-agent.md'),
        [
          '---',
          'description: A test user agent',
          'tools: [Read, Bash]',
          'maxTurns: 3',
          '---',
          'You are a helpful test agent.',
        ].join('\n'),
      );

      try {
        const agents = await loadUserAgents(cwd, tmpHome);
        expect(agents.length).toBeGreaterThanOrEqual(1);
        const agent = agents.find(a => a.name === 'test-agent');
        expect(agent).toBeDefined();
        expect(agent!.description).toBe('A test user agent');
        expect(agent!.tools).toEqual(['Read', 'Bash']);
        expect(agent!.maxTurns).toBe(3);
        expect(agent!.prompt).toBe('You are a helpful test agent.');
      } finally {
        rmSync(tmpHome, { recursive: true, force: true });
      }
    });
  });

  describe('verifier agent', () => {
    it('is defined', () => {
      const agent = loader.get('verifier');
      expect(agent).toBeDefined();
    });

    it('is read-only plus bash validation', () => {
      const agent = loader.get('verifier')!;
      expect(agent.tools).toEqual(['Read', 'Glob', 'Grep', 'Bash']);
      expect(agent.disallowedTools).toContain('Edit');
      expect(agent.disallowedTools).toContain('Write');
      expect(agent.disallowedTools).toContain('Task');
    });

    it('has mode set to default', () => {
      const agent = loader.get('verifier')!;
      expect(agent.mode).toBe('default');
    });
  });

  describe('parseAgentMd isolation / mode / allowBackgroundExecution (R10 fix)', () => {
    it('parses isolation: fork from frontmatter', () => {
      const agentDir = join(cwd, '.open-agent', 'agents');
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(
        join(agentDir, 'fork-agent.md'),
        [
          '---',
          'description: Fork isolation agent',
          'tools: [Read, Bash]',
          'isolation: fork',
          '---',
          'You run with fork isolation.',
        ].join('\n'),
      );

      const freshLoader = new AgentLoader();
      freshLoader.loadDefaults(cwd);

      const agent = freshLoader.get('fork-agent');
      expect(agent).toBeDefined();
      expect(agent!.isolation).toBe('fork');
    });

    it('parses isolation: worktree from frontmatter', () => {
      const agentDir = join(cwd, '.open-agent', 'agents');
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(
        join(agentDir, 'worktree-agent.md'),
        [
          '---',
          'description: Worktree isolation agent',
          'tools: [Read]',
          'isolation: worktree',
          '---',
          'You run in a worktree.',
        ].join('\n'),
      );

      const freshLoader = new AgentLoader();
      freshLoader.loadDefaults(cwd);

      const agent = freshLoader.get('worktree-agent');
      expect(agent).toBeDefined();
      expect(agent!.isolation).toBe('worktree');
    });

    it('parses isolation: none from frontmatter', () => {
      const agentDir = join(cwd, '.open-agent', 'agents');
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(
        join(agentDir, 'no-isolation-agent.md'),
        [
          '---',
          'description: No isolation agent',
          'tools: [Read]',
          'isolation: none',
          '---',
          'You run without isolation.',
        ].join('\n'),
      );

      const freshLoader = new AgentLoader();
      freshLoader.loadDefaults(cwd);

      const agent = freshLoader.get('no-isolation-agent');
      expect(agent).toBeDefined();
      expect(agent!.isolation).toBe('none');
    });

    it('ignores unknown isolation values', () => {
      const agentDir = join(cwd, '.open-agent', 'agents');
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(
        join(agentDir, 'bad-isolation-agent.md'),
        [
          '---',
          'description: Bad isolation agent',
          'tools: [Read]',
          'isolation: sandbox',
          '---',
          'Unknown isolation value should be silently dropped.',
        ].join('\n'),
      );

      const freshLoader = new AgentLoader();
      freshLoader.loadDefaults(cwd);

      const agent = freshLoader.get('bad-isolation-agent');
      expect(agent).toBeDefined();
      expect(agent!.isolation).toBeUndefined();
    });

    it('parses mode from frontmatter', () => {
      const agentDir = join(cwd, '.open-agent', 'agents');
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(
        join(agentDir, 'mode-agent.md'),
        [
          '---',
          'description: Mode agent',
          'tools: [Read]',
          'mode: acceptEdits',
          '---',
          'You run in acceptEdits mode.',
        ].join('\n'),
      );

      const freshLoader = new AgentLoader();
      freshLoader.loadDefaults(cwd);

      const agent = freshLoader.get('mode-agent');
      expect(agent).toBeDefined();
      expect(agent!.mode).toBe('acceptEdits');
    });

    it('parses allowBackgroundExecution: true from frontmatter', () => {
      const agentDir = join(cwd, '.open-agent', 'agents');
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(
        join(agentDir, 'bg-agent.md'),
        [
          '---',
          'description: Background execution agent',
          'tools: [Read]',
          'allowBackgroundExecution: true',
          '---',
          'You may run in the background.',
        ].join('\n'),
      );

      const freshLoader = new AgentLoader();
      freshLoader.loadDefaults(cwd);

      const agent = freshLoader.get('bg-agent');
      expect(agent).toBeDefined();
      expect(agent!.allowBackgroundExecution).toBe(true);
    });

    it('parses allow-background-execution: true (kebab-case alias) from frontmatter', () => {
      const agentDir = join(cwd, '.open-agent', 'agents');
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(
        join(agentDir, 'bg-kebab-agent.md'),
        [
          '---',
          'description: Background execution kebab agent',
          'tools: [Read]',
          'allow-background-execution: true',
          '---',
          'You may run in the background (kebab alias).',
        ].join('\n'),
      );

      const freshLoader = new AgentLoader();
      freshLoader.loadDefaults(cwd);

      const agent = freshLoader.get('bg-kebab-agent');
      expect(agent).toBeDefined();
      expect(agent!.allowBackgroundExecution).toBe(true);
    });

    it('parses combined isolation + mode + allowBackgroundExecution', () => {
      const agentDir = join(cwd, '.open-agent', 'agents');
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(
        join(agentDir, 'full-meta-agent.md'),
        [
          '---',
          'description: Full metadata agent',
          'tools: [Read, Bash]',
          'isolation: fork',
          'mode: bypassPermissions',
          'allowBackgroundExecution: true',
          '---',
          'You are a fully-configured agent.',
        ].join('\n'),
      );

      const freshLoader = new AgentLoader();
      freshLoader.loadDefaults(cwd);

      const agent = freshLoader.get('full-meta-agent');
      expect(agent).toBeDefined();
      expect(agent!.isolation).toBe('fork');
      expect(agent!.mode).toBe('bypassPermissions');
      expect(agent!.allowBackgroundExecution).toBe(true);
    });
  });

  describe('register()', () => {
    it('can register a custom agent', () => {
      loader.register('custom-test-agent', {
        description: 'A custom test agent',
        prompt: 'You are a test agent.',
      });
      const agent = loader.get('custom-test-agent');
      expect(agent).toBeDefined();
      expect(agent!.description).toBe('A custom test agent');
    });

    it('custom agent overrides built-in with same name', () => {
      loader.register('Explore', {
        description: 'Overridden Explore',
        prompt: 'Overridden prompt',
      });
      const agent = loader.get('Explore');
      expect(agent!.description).toBe('Overridden Explore');
    });
  });

  describe('diagnostics', () => {
    it('reports invalid project agent definitions and skips loading them', () => {
      const agentDir = join(cwd, '.open-agent', 'agents');
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(join(agentDir, 'broken.md'), `---
description: Broken local agent
tools: Read,Write
---
`);

      const freshLoader = new AgentLoader();
      freshLoader.loadDefaults(cwd);

      expect(freshLoader.get('broken')).toBeUndefined();
      expect(freshLoader.getDiagnostics()).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: 'agent_invalid_definition',
          source: 'agent',
          agentName: 'broken',
          layer: 'project',
        }),
      ]));
    });

    it('reports when project agents override built-in agent names', () => {
      const agentDir = join(cwd, '.open-agent', 'agents');
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(join(agentDir, 'Explore.md'), `---
description: Custom Explore
tools: [Read]
---
You are a custom explore agent.
`);

      const freshLoader = new AgentLoader();
      freshLoader.loadDefaults(cwd);

      expect(freshLoader.get('Explore')?.description).toBe('Custom Explore');
      expect(freshLoader.getDiagnostics()).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: 'agent_override',
          source: 'agent',
          agentName: 'Explore',
          layer: 'project',
        }),
      ]));
    });
  });
});
