import { describe, expect, it } from 'bun:test';
import { buildRuntimePromptSections } from '../runtime-prompt-sections.js';

describe('buildRuntimePromptSections', () => {
  it('builds ordered runtime prompt fragments for plugins, hooks, diagnostics, and coordination', () => {
    const sections = buildRuntimePromptSections({
      agents: [{ name: 'explorer', description: 'Research code' }],
      skills: [{ name: 'review-pr', description: 'Review pull requests' }],
      mcpServers: [{ name: 'linear', status: 'connected' }],
      plugins: [{
        name: 'workspace-tools',
        version: '1.2.3',
        agentCount: 1,
        skillCount: 2,
        commandCount: 3,
        mcpServerCount: 1,
        hookCount: 4,
      }],
      hooks: [{
        event: 'PreToolUse',
        count: 2,
        sources: ['settings_json'],
      }],
      diagnostics: [{
        code: 'plugin_invalid_hook_definition',
        message: 'Hook definition is invalid',
        severity: 'warning',
        source: 'plugin',
      }],
      capabilitySnapshot: {
        summary: {
          accessCounts: {
            'read-only': 3,
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
        workerTools: ['Read', 'Edit'],
        activeTeam: 'platform',
        scratchpadDir: '/tmp/demo/.open-agent/scratchpad',
        canUseSkills: true,
        canUseMcpTools: true,
        recoveryHints: [{
          taskId: 'worker-42',
          status: 'failed',
          retryPromptTemplate: 'Retry with a narrower scope.',
        }],
      },
    });

    expect(sections.map((section) => section.key)).toEqual([
      'runtime-agent-profiles',
      'runtime-skills',
      'runtime-mcp-servers',
      'runtime-plugins',
      'runtime-hooks',
      'runtime-capability-layers',
      'runtime-diagnostics',
      'runtime-coordination',
    ]);
    expect(sections.every((section) => section.slot === 'after_runtime')).toBe(true);
    expect(sections[3]?.content).toContain('workspace-tools');
    expect(sections[4]?.content).toContain('PreToolUse');
    expect(sections[5]?.content).toContain('High-risk tools: Bash');
    expect(sections[6]?.content).toContain('Sources: plugin: 1');
    expect(sections[7]?.content).toContain('Recent task recovery hints:');
  });

  it('returns no sections when runtime snapshot is empty', () => {
    expect(buildRuntimePromptSections()).toEqual([]);
    expect(buildRuntimePromptSections({})).toEqual([]);
  });

  it('uses diagnostic summary even when detailed diagnostics are unavailable', () => {
    const sections = buildRuntimePromptSections({
      diagnosticSummary: {
        total: 3,
        info: 1,
        warning: 1,
        error: 1,
        bySource: {
          plugin: 2,
          runtime: 1,
        },
      },
    });

    expect(sections).toHaveLength(1);
    expect(sections[0]?.key).toBe('runtime-diagnostics');
    expect(sections[0]?.content).toContain('Summary: 3 total (1 info, 1 warning, 1 error)');
    expect(sections[0]?.content).toContain('Sources: plugin: 2, runtime: 1');
  });
});
