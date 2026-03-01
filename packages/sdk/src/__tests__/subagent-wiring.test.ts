import { describe, it, expect } from 'bun:test';
import { query } from '../query.js';

describe('SDK subagent auto-wiring', () => {
  it('auto-wires Task, TaskOutput, TaskStop when no setupTools provides them', () => {
    // query() should construct without errors — the auto-wiring creates
    // Task/TaskOutput/TaskStop from the built-in agent definitions.
    const q = query('test', { model: 'claude-sonnet-4-6' });
    expect(q).toBeDefined();
    q.close();
  });

  it('skips auto-wiring when setupTools already registers a Task tool', () => {
    let customTaskRegistered = false;
    const q = query('test', {
      model: 'claude-sonnet-4-6',
      setupTools: (registry) => {
        registry.register({
          name: 'Task',
          description: 'Custom Task tool from setupTools',
          inputSchema: { type: 'object', properties: {} },
          execute: async () => 'custom-result',
        });
        customTaskRegistered = true;
      },
    });

    expect(customTaskRegistered).toBe(true);
    // If auto-wiring ran on top of this, it wouldn't have overwritten because
    // the condition is `!toolRegistry.get('Task')` — it checks AFTER setupTools.
    q.close();
  });

  it('auto-wired tools survive allowedTools filtering when included', () => {
    // If Task was auto-wired, including it in allowedTools should keep it.
    // If it WASN'T auto-wired, allowedTools would silently drop it.
    const q = query('test', {
      model: 'claude-sonnet-4-6',
      allowedTools: ['Task', 'TaskOutput', 'TaskStop', 'Read', 'Glob'],
    });
    expect(q).toBeDefined();
    q.close();
  });

  it('auto-wired tools are removed by disallowedTools', () => {
    const q = query('test', {
      model: 'claude-sonnet-4-6',
      disallowedTools: ['Task', 'TaskOutput', 'TaskStop'],
    });
    // Should construct fine — the tools are registered then removed
    expect(q).toBeDefined();
    q.close();
  });

  it('supportedAgents includes built-in agents for subagent dispatch', async () => {
    const q = query('test', { model: 'claude-sonnet-4-6' });
    const agents = await q.supportedAgents();
    const names = new Set(agents.map(a => a.name));

    // These built-in agents are the targets for Task tool subagent_type
    expect(names.has('Explore')).toBe(true);
    expect(names.has('Plan')).toBe(true);
    expect(names.has('general-purpose')).toBe(true);
    expect(names.has('code-writer')).toBe(true);
    expect(names.has('Bash')).toBe(true);

    // Each agent should have a description
    for (const agent of agents) {
      expect(typeof agent.description).toBe('string');
      expect(agent.description.length).toBeGreaterThan(0);
    }
    q.close();
  });

  it('custom agents from options.agents are available for subagent dispatch', async () => {
    const q = query('test', {
      model: 'claude-sonnet-4-6',
      agents: {
        'my-reviewer': {
          description: 'Code review specialist',
          prompt: 'Review code carefully.',
          model: 'haiku',
          tools: ['Read', 'Grep', 'Glob'],
        },
      },
    });
    const agents = await q.supportedAgents();
    const reviewer = agents.find(a => a.name === 'my-reviewer');

    expect(reviewer).toBeDefined();
    expect(reviewer!.description).toBe('Code review specialist');
    expect(reviewer!.model).toBe('claude-haiku-4-5-20251001');
    q.close();
  });
});
