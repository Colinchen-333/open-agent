import { describe, it, expect, beforeEach } from 'bun:test';
import { AgentLoader } from '../agent-loader.js';

describe('AgentLoader', () => {
  let loader: AgentLoader;

  beforeEach(() => {
    loader = new AgentLoader();
    loader.loadDefaults('/tmp');
  });

  it('loads all 8 built-in agent types', () => {
    const agents = loader.list();
    const names = agents.map(([name]) => name);
    expect(names).toContain('Explore');
    expect(names).toContain('Plan');
    expect(names).toContain('code-writer');
    expect(names).toContain('general-purpose');
    expect(names).toContain('architecture-logic-reviewer');
    expect(names).toContain('Bash');
    expect(names).toContain('open-agent-guide');
    expect(names).toContain('statusline-setup');
    expect(agents.length).toBeGreaterThanOrEqual(8);
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
});
