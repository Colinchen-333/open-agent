import { describe, expect, it } from 'bun:test';
import { buildSystemPrompt } from '../system-prompt.js';

describe('buildSystemPrompt runtime snapshot', () => {
  it('renders runtime context for skills, agents, and MCP servers', () => {
    const prompt = buildSystemPrompt({
      cwd: '/tmp/demo',
      model: 'claude-sonnet-4-6',
      tools: ['Read', 'Skill', 'ToolSearch'],
      permissionMode: 'default',
      runtimeSnapshot: {
        agents: [{ name: 'explorer', description: 'Read-only codebase research', model: 'claude-haiku-4-5' }],
        skills: [{ name: 'review-pr', description: 'Review a pull request' }],
        mcpServers: [{ name: 'linear', status: 'connected' }],
        coordinator: {
          workerTools: ['Read', 'Edit', 'Bash'],
          scratchpadDir: '/tmp/demo/.open-agent/scratchpad',
          canUseSkills: true,
          canUseMcpTools: true,
        },
      },
    });

    expect(prompt).toContain('# Runtime Context');
    expect(prompt).toContain('**explorer**');
    expect(prompt).toContain('**review-pr**');
    expect(prompt).toContain('**linear**');
    expect(prompt).toContain('## Coordination');
    expect(prompt).toContain('Worker tool pool: Read, Edit, Bash');
    expect(prompt).toContain('Scratchpad directory: /tmp/demo/.open-agent/scratchpad');
  });

  it('includes fallback tool notes for runtime-managed tools', () => {
    const prompt = buildSystemPrompt({
      cwd: '/tmp/demo',
      model: 'claude-sonnet-4-6',
      tools: ['Skill', 'ToolSearch', 'ListMcpResourcesTool', 'ReadMcpResourceTool'],
      permissionMode: 'default',
    });

    expect(prompt).toContain('**Skill**');
    expect(prompt).toContain('**ToolSearch**');
    expect(prompt).toContain('**ListMcpResourcesTool**');
    expect(prompt).toContain('**ReadMcpResourceTool**');
  });

  it('renders session-specific guidance for available coordination tools', () => {
    const prompt = buildSystemPrompt({
      cwd: '/tmp/demo',
      model: 'claude-sonnet-4-6',
      tools: ['Task', 'TaskCreate', 'TaskUpdate', 'TaskList', 'AskUserQuestion', 'Skill', 'ToolSearch'],
      permissionMode: 'default',
      runtimeSnapshot: {
        skills: [{ name: 'commit', description: 'Create a commit' }],
      },
    });

    expect(prompt).toContain('# Session-specific guidance');
    expect(prompt).toContain('Use `AskUserQuestion` only after investigation');
    expect(prompt).toContain('Subagents cannot see your conversation with the user');
    expect(prompt).toContain('**verifier**');
    expect(prompt).toContain('Use `Skill` only for skills explicitly listed');
    expect(prompt).toContain('use `ToolSearch` before assuming the tool name');
    expect(prompt).toContain('After launching subagents, briefly tell the user only what you started');
    expect(prompt).toContain('When a subagent returns research, first synthesize the findings yourself');
    expect(prompt).toContain('finished worker updates may appear as user-role `<task-notification>` blocks');
    expect(prompt).toContain('The `<task-id>` inside a task notification is the worker identity');
    expect(prompt).toContain('When a worker completes successfully, prefer a fresh `verifier`');
    expect(prompt).toContain('When a worker fails, prefer resuming the same worker');
    expect(prompt).toContain('If a task notification includes prompt templates');
    expect(prompt).toContain('restate the exact claims to prove');
  });

  it('renders coordination-specific guidance when team tools are available', () => {
    const prompt = buildSystemPrompt({
      cwd: '/tmp/demo',
      model: 'claude-sonnet-4-6',
      tools: ['Task', 'TeamCreate', 'SendMessage'],
      permissionMode: 'default',
      runtimeSnapshot: {
        coordinator: {
          scratchpadDir: '/tmp/demo/.open-agent/scratchpad',
        },
      },
    });

    expect(prompt).toContain('Team and worker notifications are internal signals');
    expect(prompt).toContain('Use `SendMessage` with crisp, self-contained instructions');
    expect(prompt).toContain('Use the shared scratchpad at `/tmp/demo/.open-agent/scratchpad`');
  });

  it('renders communication guidance', () => {
    const prompt = buildSystemPrompt({
      cwd: '/tmp/demo',
      model: 'claude-sonnet-4-6',
      tools: ['Read', 'TaskCreate'],
      permissionMode: 'default',
    });

    expect(prompt).toContain('# Communicating with the user');
    expect(prompt).toContain('Before your first meaningful tool call');
    expect(prompt).toContain('Report outcomes faithfully');
  });

  it('renders git context when provided', () => {
    const prompt = buildSystemPrompt({
      cwd: '/tmp/demo',
      model: 'claude-sonnet-4-6',
      tools: ['Read'],
      permissionMode: 'default',
      gitContext: 'Current branch: main\n\nStatus:\n M src/index.ts',
    });

    expect(prompt).toContain('# Git Context');
    expect(prompt).toContain('Current branch: main');
    expect(prompt).toContain('M src/index.ts');
  });
});
