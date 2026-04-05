import { describe, expect, it } from 'bun:test';
import type { McpServerConfig } from '@open-agent/core';
import { createStore, createDefaultAppState } from '@open-agent/state';
import type { ToolDefinition } from '@open-agent/tools';
import { applyCliRuntimeSettingsRefresh, refreshCliRuntimeSurface } from '../runtime-settings-refresh.js';

describe('applyCliRuntimeSettingsRefresh', () => {
  it('waits for pending MCP setup and refreshes the live runtime surface without reapplying settings', async () => {
    const callOrder: string[] = [];
    let readyResolve: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      readyResolve = resolve;
    });
    let syncedTools: ToolDefinition[] = [];
    let lastSystemPrompt = '';

    const store = createStore(createDefaultAppState({
      sessionId: 'session-1',
      cwd: '/tmp/project',
      model: 'mock-model',
      permissionMode: 'default',
      tools: new Map(),
      thinkingConfig: { type: 'adaptive' },
      verbose: false,
    }));

    const tools: ToolDefinition[] = [{
      name: 'Read',
      description: 'Read files',
      inputSchema: { type: 'object', properties: {} },
      execute: async () => '',
      isReadOnly: true,
    }];

    const refreshPromise = refreshCliRuntimeSurface({
      runtime: {
        async setMcpServers() {
          throw new Error('setMcpServers should not be called during surface refresh');
        },
        waitForMcpReady() {
          return ready.then(() => {
            callOrder.push('ready');
          });
        },
        buildSnapshot() {
          return {
            tools: ['Read'],
            agents: [],
            skills: [],
            mcpServers: [{ name: 'docs', status: 'connected' }],
            capabilitySnapshot: {
              totalTools: 1,
              profiles: [],
              presets: [],
              summary: {
                accessCounts: { 'read-only': 0, mutable: 0, meta: 0, external: 0 },
                groupCounts: { files: 0, execution: 0, coordination: 0, integration: 0, external: 0, utility: 0 },
                mcpTools: 0,
                dynamicTools: 0,
              },
            },
            plugins: [],
            hooks: [],
            diagnostics: [],
            diagnosticSummary: {
              total: 0,
              info: 0,
              warning: 0,
              error: 0,
              bySource: {},
            },
          };
        },
        listMcpServerStatus() {
          return [{
            name: 'docs',
            status: 'connected',
            tools: [],
            config: { type: 'stdio', command: 'npx', args: [] },
          }];
        },
      },
      toolRegistry: {
        list() {
          callOrder.push('list-tools');
          return tools;
        },
      },
      loop: {
        setSystemPrompt(prompt) {
          lastSystemPrompt = prompt ?? '';
        },
        setSystemPromptBlocks() {},
      },
      appStore: store,
      buildSystemPrompt() {
        return 'prompt-after-turn-refresh';
      },
      syncLoopTools(nextTools) {
        syncedTools = nextTools;
        callOrder.push('sync-tools');
      },
      isPrintMode: false,
    });

    expect(callOrder).toEqual([]);
    if (readyResolve) {
      readyResolve();
    }
    const result = await refreshPromise;

    expect(callOrder).toEqual(['ready', 'list-tools', 'sync-tools']);
    expect(syncedTools.map((tool) => tool.name)).toEqual(['Read']);
    expect(lastSystemPrompt).toBe('prompt-after-turn-refresh');
    expect(result.toolNames).toEqual(['Read']);
  });

  it('refreshes MCP servers, syncs loop surface, and mirrors runtime state into AppState', async () => {
    const callOrder: string[] = [];
    let readyResolve: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      readyResolve = resolve;
    });
    let receivedServers: Record<string, McpServerConfig> | undefined;
    let syncedTools: ToolDefinition[] = [];
    let lastSystemPrompt = '';

    const runtimeSnapshot = {
      tools: ['Read', 'mcp__docs__search'],
      agents: [],
      skills: [],
      mcpServers: [{ name: 'docs', status: 'connected' }],
      capabilitySnapshot: {
        totalTools: 2,
        profiles: [],
        presets: [],
        summary: {
          accessCounts: { 'read-only': 0, mutable: 0, meta: 0, external: 0 },
          groupCounts: { files: 0, execution: 0, coordination: 0, integration: 0, external: 0, utility: 0 },
          mcpTools: 1,
          dynamicTools: 0,
        },
      },
      plugins: [],
      hooks: [],
      diagnostics: [],
      diagnosticSummary: {
        total: 0,
        info: 0,
        warning: 0,
        error: 0,
        bySource: {},
      },
    };

    const store = createStore(createDefaultAppState({
      sessionId: 'session-1',
      cwd: '/tmp/project',
      model: 'mock-model',
      permissionMode: 'default',
      tools: new Map(),
      thinkingConfig: { type: 'adaptive' },
      verbose: false,
    }));

    const tools: ToolDefinition[] = [{
      name: 'Read',
      description: 'Read files',
      inputSchema: { type: 'object', properties: {} },
      execute: async () => '',
      isReadOnly: true,
    }];

    const applyPromise = applyCliRuntimeSettingsRefresh({
      runtime: {
        async setMcpServers(servers) {
          receivedServers = servers;
          callOrder.push('set');
          return { added: Object.keys(servers), removed: [], errors: {} };
        },
        waitForMcpReady() {
          return ready.then(() => {
            callOrder.push('ready');
          });
        },
        buildSnapshot() {
          return runtimeSnapshot;
        },
        listMcpServerStatus() {
          return [{
            name: 'docs',
            status: 'connected',
            tools: [],
            config: { type: 'stdio', command: 'npx', args: [] },
          }];
        },
      },
      toolRegistry: {
        list() {
          return tools;
        },
      },
      loop: {
        setSystemPrompt(prompt) {
          lastSystemPrompt = prompt ?? '';
        },
        setSystemPromptBlocks() {},
      },
      appStore: store,
      buildSystemPrompt() {
        return 'prompt-after-refresh';
      },
      syncLoopTools(nextTools) {
        syncedTools = nextTools;
        callOrder.push('sync-tools');
      },
      isPrintMode: false,
    }, {
      mcpServers: {
        docs: {
          command: 'npx',
          args: ['-y', '@open-agent/docs-mcp'],
        },
      },
    });

    expect(callOrder).toEqual(['set']);
    if (readyResolve) {
      readyResolve();
    }
    const result = await applyPromise;

    expect(receivedServers).toEqual({
      docs: {
        command: 'npx',
        args: ['-y', '@open-agent/docs-mcp'],
      },
    });
    expect(syncedTools.map((tool) => tool.name)).toEqual(['Read']);
    expect(lastSystemPrompt).toBe('prompt-after-refresh');
    expect(result.toolNames).toEqual(['Read']);
    expect(store.getState().mcpServers).toMatchObject([{ name: 'docs', status: 'connected' }]);
    expect(store.getState().runtime.agentNames).toEqual([]);
    expect(callOrder).toEqual(['set', 'ready', 'sync-tools']);
  });

  it('applies settings-backed state before rebuilding the prompt surface', async () => {
    const callOrder: string[] = [];
    let lastSystemPrompt = '';

    const store = createStore(createDefaultAppState({
      sessionId: 'session-1',
      cwd: '/tmp/project',
      model: 'mock-model',
      permissionMode: 'default',
      tools: new Map(),
      thinkingConfig: { type: 'adaptive' },
      verbose: false,
    }));

    await applyCliRuntimeSettingsRefresh({
      runtime: {
        async setMcpServers() {
          callOrder.push('set-mcp');
          return { added: [], removed: [], errors: {} };
        },
        waitForMcpReady() {
          callOrder.push('wait-ready');
          return undefined;
        },
        buildSnapshot() {
          callOrder.push('build-snapshot');
          return {
            tools: [],
            agents: [],
            skills: [],
            mcpServers: [],
            capabilitySnapshot: {
              totalTools: 0,
              profiles: [],
              presets: [],
              summary: {
                accessCounts: { 'read-only': 0, mutable: 0, meta: 0, external: 0 },
                groupCounts: { files: 0, execution: 0, coordination: 0, integration: 0, external: 0, utility: 0 },
                mcpTools: 0,
                dynamicTools: 0,
              },
            },
            plugins: [],
            hooks: [],
            diagnostics: [],
            diagnosticSummary: {
              total: 0,
              info: 0,
              warning: 0,
              error: 0,
              bySource: {},
            },
          };
        },
        listMcpServerStatus() {
          return [];
        },
      },
      toolRegistry: {
        list() {
          callOrder.push('list-tools');
          return [];
        },
      },
      loop: {
        setSystemPrompt(prompt) {
          callOrder.push('set-prompt');
          lastSystemPrompt = prompt ?? '';
        },
        setSystemPromptBlocks() {},
      },
      appStore: store,
      buildSystemPrompt() {
        callOrder.push('build-prompt');
        return 'prompt-after-settings-state';
      },
      syncLoopTools() {
        callOrder.push('sync-tools');
      },
      isPrintMode: false,
      applySettingsState() {
        callOrder.push('apply-settings-state');
      },
    }, {
      hooks: {
        Notification: [{ command: 'echo updated-hook' }],
      },
    });

    expect(callOrder).toEqual([
      'set-mcp',
      'apply-settings-state',
      'wait-ready',
      'list-tools',
      'sync-tools',
      'build-snapshot',
      'build-prompt',
      'set-prompt',
    ]);
    expect(lastSystemPrompt).toBe('prompt-after-settings-state');
  });
});
