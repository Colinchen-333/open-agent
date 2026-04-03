import { describe, expect, it } from 'bun:test';
import {
  appendTimelineControlPlane,
  createDefaultAppState,
  removeDispatcherControlPlane,
  setActiveTeamControlPlane,
  upsertDispatcherDiagnosisControlPlane,
  syncTeamInboxMemberControlPlane,
  syncMcpServerState,
  syncRuntimeControlPlane,
  syncSessionControlPlane,
  syncToolRegistryState,
  upsertDispatcherControlPlane,
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

  it('upserts dispatchers and dedupes timeline items by key', () => {
    const state = createDefaultAppState();
    const withDispatcher = upsertDispatcherControlPlane(state, {
      dispatcherId: 'dispatcher-1',
      teamName: 'alpha',
      status: 'running',
      startedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      payload: { dispatcherId: 'dispatcher-1' },
    });
    const withTimeline = appendTimelineControlPlane(withDispatcher, {
      key: 'dispatcher:dispatcher-1:2026-01-01T00:00:00.000Z',
      kind: 'task_dispatcher',
      sessionId: 'session-1',
      timestamp: '2026-01-01T00:00:00.000Z',
      cursor: 'dispatcher:dispatcher-1:2026-01-01T00:00:00.000Z',
      timelineId: 'dispatcher:dispatcher-1:2026-01-01T00:00:00.000Z',
      payload: { type: 'started' },
    });
    const deduped = appendTimelineControlPlane(withTimeline, {
      key: 'dispatcher:dispatcher-1:2026-01-01T00:00:00.000Z',
      kind: 'task_dispatcher',
      sessionId: 'session-1',
      timestamp: '2026-01-01T00:00:00.000Z',
      cursor: 'dispatcher:dispatcher-1:2026-01-01T00:00:00.000Z',
      timelineId: 'dispatcher:dispatcher-1:2026-01-01T00:00:00.000Z',
      payload: { type: 'started-again' },
    });
    const removed = removeDispatcherControlPlane(deduped, 'dispatcher-1');

    expect(withDispatcher.dispatchers['dispatcher-1']?.teamName).toBe('alpha');
    expect(deduped.timeline).toHaveLength(1);
    expect(deduped.timeline[0]?.payload).toEqual({ type: 'started-again' });
    expect(removed.dispatchers['dispatcher-1']).toBeUndefined();
  });

  it('syncs member inbox snapshots and derives pending approvals', () => {
    const state = createDefaultAppState();
    const next = syncTeamInboxMemberControlPlane(state, {
      teamName: 'alpha',
      memberName: 'lead',
      messages: [
        {
          messageId: 'msg-1',
          type: 'plan_approval_request',
          from: 'worker-1',
          to: 'lead',
          content: 'Approve the plan.',
          summary: 'plan',
          timestamp: '2026-01-01T00:00:00.000Z',
          requestId: 'req-1',
        },
        {
          messageId: 'msg-2',
          type: 'message',
          from: 'worker-2',
          content: 'FYI',
          timestamp: '2026-01-01T00:01:00.000Z',
          readAt: '2026-01-01T00:02:00.000Z',
        },
      ],
      updatedAt: '2026-01-01T00:03:00.000Z',
    });

    expect(next.inboxes['alpha']?.['lead']?.unreadCount).toBe(1);
    expect(next.inboxes['alpha']?.['lead']?.messages).toHaveLength(2);
    expect(next.approvals['alpha']?.['lead']).toEqual([
      {
        messageId: 'msg-1',
        teamName: 'alpha',
        memberName: 'lead',
        requestType: 'plan_approval_request',
        requestId: 'req-1',
        from: 'worker-1',
        to: 'lead',
        content: 'Approve the plan.',
        summary: 'plan',
        timestamp: '2026-01-01T00:00:00.000Z',
      },
    ]);
  });

  it('upserts dispatcher diagnoses as control-plane state', () => {
    const state = createDefaultAppState();
    const next = upsertDispatcherDiagnosisControlPlane(state, {
      dispatcherId: 'dispatcher-1',
      teamName: 'alpha',
      healthy: false,
      source: 'ledger',
      observedAt: '2026-01-01T00:00:00.000Z',
      findingCount: 2,
      payload: { dispatcherId: 'dispatcher-1' },
    });

    expect(next.dispatcherDiagnoses['dispatcher-1']).toEqual({
      dispatcherId: 'dispatcher-1',
      teamName: 'alpha',
      healthy: false,
      source: 'ledger',
      observedAt: '2026-01-01T00:00:00.000Z',
      findingCount: 2,
      payload: { dispatcherId: 'dispatcher-1' },
    });
  });
});
