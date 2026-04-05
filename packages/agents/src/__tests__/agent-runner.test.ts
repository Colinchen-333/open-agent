import { describe, expect, it } from 'bun:test';
import { buildSubagentSystemPrompt } from '../agent-runner.js';

describe('buildSubagentSystemPrompt', () => {
  it('wraps agent-specific prompts with the shared subagent contract', () => {
    const prompt = buildSubagentSystemPrompt(
      'You are a planning agent. Return an execution plan.',
      '/tmp/project',
      {
        teamName: 'alpha-team',
        scratchpadDir: '/tmp/project/.open-agent/scratchpad',
        availableTools: ['Read', 'Edit', 'Bash'],
      },
    );

    expect(prompt).toContain('The user cannot see your raw tool calls');
    expect(prompt).toContain('You are a planning agent. Return an execution plan.');
    expect(prompt).toContain('Current working directory: /tmp/project');
    expect(prompt).toContain('Team context: alpha-team');
    expect(prompt).toContain('Scratchpad directory: /tmp/project/.open-agent/scratchpad');
    expect(prompt).toContain('Available tools for this run: Bash, Edit, Read');
  });

  it('falls back to a generic specialized-agent prompt', () => {
    const prompt = buildSubagentSystemPrompt(undefined, '/tmp/project');

    expect(prompt).toContain('You are a specialized agent. Complete the given task.');
    expect(prompt).toContain('Current working directory: /tmp/project');
  });

  it('accepts prebuilt coordinator context', () => {
    const prompt = buildSubagentSystemPrompt(
      'Implement the task.',
      '/tmp/project',
      {
        coordinator: {
          workerTools: ['Read', 'Bash'],
          activeTeam: 'beta-team',
          scratchpadDir: '/tmp/project/.open-agent/scratchpad',
        },
      },
    );

    expect(prompt).toContain('Available tools for this run: Bash, Read');
    expect(prompt).toContain('Team context: beta-team');
    expect(prompt).toContain('Scratchpad directory: /tmp/project/.open-agent/scratchpad');
  });
});
