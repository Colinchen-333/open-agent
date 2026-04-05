import { describe, expect, it } from 'bun:test';
import { buildSystemPromptRuntimeSnapshot } from '../runtime-prompt-snapshot.js';

describe('buildSystemPromptRuntimeSnapshot', () => {
  it('assembles runtime prompt snapshot with hook/capability overrides and coordinator context', () => {
    const snapshot = buildSystemPromptRuntimeSnapshot({
      runtime: {
        agents: [{ name: 'reviewer', description: 'Review agent' }],
        skills: [{ name: 'review', description: 'Review skill' }],
        mcpServers: [
          { name: 'linear', status: 'connected' },
          { name: 'browser', status: 'disconnected' },
        ],
        plugins: [{
          name: 'review-kit',
          version: '1.0.0',
          agentCount: 1,
          skillCount: 1,
          commandCount: 1,
          mcpServerCount: 0,
          hookCount: 1,
        }],
        hooks: [{ event: 'PreToolUse', count: 1, sources: ['plugin:review-kit'] }],
        diagnostics: [{
          code: 'plugin_invalid_hook_event',
          message: 'invalid hook',
          severity: 'warning',
          source: 'plugin',
        }],
        diagnosticSummary: {
          total: 1,
          info: 0,
          warning: 1,
          error: 0,
          bySource: { plugin: 1 },
        },
        capabilitySnapshot: {
          summary: {
            accessCounts: {
              'read-only': 2,
              mutable: 1,
              meta: 0,
              external: 1,
            },
            mcpTools: 1,
            dynamicTools: 0,
          },
          profiles: [],
          presets: [],
        },
      },
      tools: ['Read', 'Skill', 'Task'],
      activeTeam: 'platform',
      scratchpadDir: '/tmp/demo/.open-agent/scratchpad',
      hookSurface: [
        { event: 'Notification', count: 2, sources: ['settings_json', 'query_options'] },
      ],
    });

    expect(snapshot.hooks).toEqual([
      { event: 'Notification', count: 2, sources: ['settings_json', 'query_options'] },
    ]);
    expect(snapshot.capabilitySnapshot?.summary.mcpTools).toBe(1);
    expect(snapshot.coordinator).toMatchObject({
      activeTeam: 'platform',
      scratchpadDir: '/tmp/demo/.open-agent/scratchpad',
      canUseSkills: true,
      canUseMcpTools: true,
      workerTools: ['Read', 'Skill'],
    });
  });
});
