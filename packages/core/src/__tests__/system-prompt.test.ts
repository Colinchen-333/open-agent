import { describe, expect, it } from 'bun:test';
import { buildSystemPrompt, buildSystemPromptBlocks } from '../system-prompt.js';

describe('buildSystemPrompt runtime snapshot', () => {
  it('renders runtime prompt fragments for skills, agents, and MCP servers', () => {
    const prompt = buildSystemPrompt({
      cwd: '/tmp/demo',
      model: 'claude-sonnet-4-6',
      tools: ['Read', 'Skill', 'ToolSearch'],
      permissionMode: 'default',
      runtimeSnapshot: {
        agents: [{ name: 'explorer', description: 'Read-only codebase research', model: 'claude-haiku-4-5' }],
        skills: [{ name: 'review-pr', description: 'Review a pull request' }],
        mcpServers: [{ name: 'linear', status: 'connected' }],
        diagnostics: [{
          code: 'plugin_agent_collision',
          message: 'collision',
          severity: 'warning',
          source: 'plugin',
        }],
        capabilitySnapshot: {
          summary: {
            accessCounts: {
              'read-only': 4,
              mutable: 2,
              meta: 1,
              external: 1,
            },
            mcpTools: 1,
            dynamicTools: 1,
          },
          profiles: [
            {
              toolName: 'Bash',
              risk: 'high',
              needsWorkspaceWrite: true,
              source: 'built-in',
              tags: ['workspace'],
            },
            {
              toolName: 'mcp__browser__search',
              risk: 'medium',
              needsWorkspaceWrite: false,
              source: 'mcp',
              tags: ['external', 'network'],
            },
          ],
        },
        coordinator: {
          workerTools: ['Read', 'Edit', 'Bash'],
          scratchpadDir: '/tmp/demo/.open-agent/scratchpad',
          canUseSkills: true,
          canUseMcpTools: true,
          recoveryHints: [
            {
              taskId: 'worker-42',
              status: 'failed',
              description: 'Refactor payment flow',
              retryPromptTemplate: 'Retry by narrowing scope.',
            },
          ],
        },
      },
    });

    expect(prompt).toContain('# Runtime Agent Profiles');
    expect(prompt).toContain('# Runtime Skills');
    expect(prompt).toContain('# Runtime MCP Servers');
    expect(prompt).toContain('# Runtime Coordination');
    expect(prompt).toContain('# Runtime Tool Capability Layers');
    expect(prompt).toContain('# Runtime Diagnostics');
    expect(prompt).toContain('**explorer**');
    expect(prompt).toContain('**review-pr**');
    expect(prompt).toContain('**linear**');
    expect(prompt).toContain('Summary: 1 total (0 info, 1 warning, 0 error)');
    expect(prompt).toContain('Sources: plugin: 1');
    expect(prompt).toContain('High-risk tools: Bash');
    expect(prompt).toContain('Open-world MCP tools can reach beyond the workspace');
    expect(prompt).toContain('Worker tool pool: Read, Edit, Bash');
    expect(prompt).toContain('Scratchpad directory: /tmp/demo/.open-agent/scratchpad');
    expect(prompt).toContain('Recent task recovery hints:');
    expect(prompt).toContain('`worker-42` (failed)');
    expect(prompt).toContain('templates: retry');
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

  it('renders dynamic recovery guidance when coordinator hints are present', () => {
    const prompt = buildSystemPrompt({
      cwd: '/tmp/demo',
      model: 'claude-sonnet-4-6',
      tools: ['Task'],
      permissionMode: 'default',
      runtimeSnapshot: {
        coordinator: {
          recoveryHints: [
            {
              taskId: 'worker-7',
              status: 'completed',
              verificationPromptTemplate: 'Verify changed files and assertions.',
            },
          ],
        },
      },
    });

    expect(prompt).toContain('Runtime coordination context includes 1 recent recovery hint(s)');
  });

  it('renders capability-aware session guidance for risky external tools', () => {
    const prompt = buildSystemPrompt({
      cwd: '/tmp/demo',
      model: 'claude-sonnet-4-6',
      tools: ['Bash', 'Read'],
      permissionMode: 'default',
      runtimeSnapshot: {
        capabilitySnapshot: {
          summary: {
            accessCounts: {
              'read-only': 1,
              mutable: 1,
              meta: 0,
              external: 1,
            },
            mcpTools: 1,
            dynamicTools: 0,
          },
          profiles: [
            {
              toolName: 'Bash',
              risk: 'high',
              needsWorkspaceWrite: true,
              source: 'built-in',
              tags: ['workspace'],
            },
            {
              toolName: 'mcp__browser__search',
              risk: 'medium',
              needsWorkspaceWrite: false,
              source: 'mcp',
              tags: ['external', 'network'],
            },
          ],
        },
      },
    });

    expect(prompt).toContain('Some tools in this session are explicitly marked high-risk');
    expect(prompt).toContain('Some MCP tools are marked open-world/external');
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

  it('renders provider-supplied context sections', () => {
    const prompt = buildSystemPrompt({
      cwd: '/tmp/demo',
      model: 'claude-sonnet-4-6',
      tools: ['Read'],
      permissionMode: 'default',
      contextSections: [
        {
          key: 'additional-working-directories',
          title: 'Additional Working Directories',
          content: '- /tmp/one\n- /tmp/two',
        },
      ],
    });

    expect(prompt).toContain('# Additional Working Directories');
    expect(prompt).toContain('/tmp/one');
    expect(prompt).toContain('/tmp/two');
  });

  it('supports slot-based prompt fragments with stable priority ordering', () => {
    const prompt = buildSystemPrompt({
      cwd: '/tmp/demo',
      model: 'claude-sonnet-4-6',
      tools: ['Read'],
      permissionMode: 'default',
      runtimeSnapshot: {
        mcpServers: [{ name: 'docs', status: 'connected' }],
      },
      contextSections: [
        {
          key: 'final-note',
          title: 'Final Note',
          content: 'Always emit the final marker.',
          slot: 'final',
        },
        {
          key: 'runtime-a',
          title: 'Runtime A',
          content: 'A comes first.',
          slot: 'after_runtime',
          priority: 10,
        },
        {
          key: 'runtime-b',
          title: 'Runtime B',
          content: 'B comes second.',
          slot: 'after_runtime',
          priority: 20,
        },
      ],
    });

    expect(prompt.indexOf('# Runtime MCP Servers')).toBeGreaterThan(-1);
    expect(prompt.indexOf('# Runtime A')).toBeLessThan(prompt.indexOf('# Runtime MCP Servers'));
    expect(prompt.indexOf('# Runtime B')).toBeGreaterThan(prompt.indexOf('# Runtime A'));
    expect(prompt.indexOf('# Final Note')).toBeGreaterThan(prompt.indexOf('# Runtime B'));
  });

  it('deduplicates git and memory provider sections when dedicated sections are present', () => {
    const prompt = buildSystemPrompt({
      cwd: '/tmp/demo',
      model: 'claude-sonnet-4-6',
      tools: ['Read'],
      permissionMode: 'default',
      gitContext: 'branch: main',
      memoryDir: '/tmp/demo/.open-agent/memory',
      memoryContent: 'remember this',
      contextSections: [
        {
          key: 'git-context',
          title: 'Git Context',
          content: 'duplicate git section',
          slot: 'after_environment',
        },
        {
          key: 'memory-context',
          title: 'Memory Context',
          content: 'duplicate memory section',
          slot: 'after_memory',
        },
      ],
    });

    expect(prompt.match(/# Git Context/g)?.length).toBe(1);
    expect(prompt).not.toContain('duplicate git section');
    expect(prompt).not.toContain('# Memory Context');
    expect(prompt).not.toContain('duplicate memory section');
    expect(prompt).toContain('Current MEMORY.md contents');
  });

  it('contains Claude-Code-aligned core principles', () => {
    const REQUIRED_PHRASES = [
      "Don't add features",
      "Only add comments where the logic isn't self-evident",
      "Don't add error handling",
      "Don't create helpers",
      'diagnose why before switching tactics',
      'Before reporting a task complete, verify it actually works',
      "Never claim \"all tests pass\" when output shows failures",
    ];

    const prompt = buildSystemPrompt({
      cwd: '/tmp',
      model: 'glm-4.7',
      permissionMode: 'default',
      tools: [],
    });

    for (const phrase of REQUIRED_PHRASES) {
      expect(prompt).toContain(phrase);
    }
  });

  it('injects output style instructions when activeOutputStyle is provided', () => {
    const prompt = buildSystemPrompt({
      cwd: '/tmp',
      model: 'glm-4.7',
      permissionMode: 'default',
      tools: [],
      activeOutputStyle: {
        name: 'verbose',
        instructions: 'Be thorough and cite files whenever possible.',
        keepCodingInstructions: true,
      },
    });
    expect(prompt).toContain('Output style: verbose');
    expect(prompt).toContain('Be thorough and cite files');
  });

  it('omits output style section when activeOutputStyle instructions are empty', () => {
    const prompt = buildSystemPrompt({
      cwd: '/tmp',
      model: 'glm-4.7',
      permissionMode: 'default',
      tools: [],
      activeOutputStyle: { name: 'default', instructions: '', keepCodingInstructions: true },
    });
    expect(prompt).not.toContain('Output style: default');
  });
});

describe('buildSystemPrompt briefMode', () => {
  it('injects brief mode block when briefMode is true', () => {
    const prompt = buildSystemPrompt({
      cwd: '/tmp',
      model: 'glm-4.7',
      permissionMode: 'default',
      tools: [],
      briefMode: true,
    });
    expect(prompt).toContain('## Brief mode');
    expect(prompt).toContain('Lead with code');
    expect(prompt).toContain('No preamble');
  });

  it('omits brief mode block when briefMode is false', () => {
    const prompt = buildSystemPrompt({
      cwd: '/tmp',
      model: 'glm-4.7',
      permissionMode: 'default',
      tools: [],
      briefMode: false,
    });
    expect(prompt).not.toContain('## Brief mode');
  });

  it('omits brief mode block when briefMode is not provided', () => {
    const prompt = buildSystemPrompt({
      cwd: '/tmp',
      model: 'glm-4.7',
      permissionMode: 'default',
      tools: [],
    });
    expect(prompt).not.toContain('## Brief mode');
  });
});

describe('buildSystemPromptBlocks', () => {
  it('returns blocks with all static sections before any dynamic section', () => {
    const blocks = buildSystemPromptBlocks({
      cwd: '/tmp',
      model: 'glm-4.7',
      permissionMode: 'default',
      tools: [],
    });

    const staticBlocks = blocks.filter((b) => b.section === 'static');
    const dynamicBlocks = blocks.filter((b) => b.section === 'dynamic');

    expect(staticBlocks.length).toBeGreaterThan(0);
    expect(dynamicBlocks.length).toBeGreaterThan(0);

    // The last static block must appear before the first dynamic block.
    const lastStaticIdx = blocks.findLastIndex((b) => b.section === 'static');
    const firstDynamicIdx = blocks.findIndex((b) => b.section === 'dynamic');
    expect(lastStaticIdx).toBeLessThan(firstDynamicIdx);
  });

  it('produces a string identical to buildSystemPrompt when blocks are joined', () => {
    const opts = {
      cwd: '/tmp/project',
      model: 'glm-4.7',
      permissionMode: 'default',
      tools: ['Read', 'Bash', 'Skill'],
      memoryDir: '/tmp/project/.memory',
      memoryContent: 'key fact',
      gitContext: 'branch: main\n M src/index.ts',
      agentInstructions: ['Always reply in English'],
      isGitRepo: true,
    };

    const fromString = buildSystemPrompt(opts);
    const fromBlocks = buildSystemPromptBlocks(opts).map((b) => b.text).join('\n\n');

    expect(fromBlocks).toBe(fromString);
  });
});
