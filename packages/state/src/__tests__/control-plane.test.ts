import { describe, expect, it } from 'bun:test';
import {
  createDefaultAppState,
  setActiveTeamControlPlane,
  syncMcpServerState,
  syncRuntimeControlPlane,
  syncSessionControlPlane,
  syncToolRegistryState,
} from '../index.js';

describe('state control plane helpers', () => {
  it('syncs session control plane fields', () => {
    const state = createDefaultAppState();
    const next = syncSessionControlPlane(state, {
      model: 'claude-sonnet-4-6',
      permissionMode: 'acceptEdits',
      thinkingConfig: { type: 'enabled', budgetTokens: 4096 },
      verbose: true,
    });

    expect(next.model).toBe('claude-sonnet-4-6');
    expect(next.permissionMode).toBe('acceptEdits');
    expect(next.thinkingConfig).toEqual({ type: 'enabled', budgetTokens: 4096 });
    expect(next.verbose).toBe(true);
  });

  it('syncs tools, mcp servers, runtime snapshot, and active team', () => {
    const state = createDefaultAppState();
    const withTools = syncToolRegistryState(state, [{
      name: 'Read',
      description: 'Read files',
      inputSchema: { type: 'object', properties: {} },
      execute: async () => '',
    }]);
    const withMcp = syncMcpServerState(withTools, [{
      name: 'demo',
      status: 'connected',
      toolCount: 2,
    }]);
    const withRuntime = syncRuntimeControlPlane(withMcp, {
      agents: [{ name: 'reviewer' }],
      skills: [{ name: 'review-skill' }],
      plugins: [{
        name: 'review-kit',
        path: '/tmp/review-kit',
        version: '1.0.0',
        enabled: true,
        agentCount: 1,
        skillCount: 1,
        commandCount: 1,
        mcpServerCount: 1,
        hookEventCount: 2,
        hookCount: 3,
      }],
      hooks: [{
        event: 'PreToolUse',
        count: 1,
        sources: ['review-kit'],
      }],
      diagnostics: [{
        code: 'plugin_agent_collision',
        message: 'collision',
        severity: 'warning',
        source: 'plugin',
      }],
      capabilitySnapshot: {
        totalTools: 5,
        summary: {
          mcpTools: 2,
          dynamicTools: 1,
        },
      },
    });
    const withTeam = setActiveTeamControlPlane(withRuntime, 'alpha');

    expect(withTeam.tools.has('Read')).toBe(true);
    expect(withTeam.mcpServers).toEqual([{
      name: 'demo',
      status: 'connected',
      toolCount: 2,
    }]);
    expect(withTeam.runtime.agentNames).toEqual(['reviewer']);
    expect(withTeam.runtime.skillNames).toEqual(['review-skill']);
    expect(withTeam.runtime.plugins[0]?.name).toBe('review-kit');
    expect(withTeam.runtime.hooks[0]?.event).toBe('PreToolUse');
    expect(withTeam.runtime.diagnostics[0]?.code).toBe('plugin_agent_collision');
    expect(withTeam.runtime.capabilitySummary).toEqual({
      totalTools: 5,
      mcpTools: 2,
      dynamicTools: 1,
    });
    expect(withTeam.activeTeamName).toBe('alpha');
  });
});
