import type { ConversationLoop, McpServerConfig } from '@open-agent/core';
import type { AppState, Store } from '@open-agent/state';
import {
  syncMcpServerState,
  syncRuntimeControlPlane,
  syncToolRegistryState,
} from '@open-agent/state';
import type { OpenAgentRuntime } from '@open-agent/runtime';
import type { Settings } from '@open-agent/core';
import type { ToolDefinition, ToolRegistry } from '@open-agent/tools';

export interface CliRuntimeRefreshContext {
  runtime: Pick<OpenAgentRuntime, 'setMcpServers' | 'waitForMcpReady' | 'buildSnapshot' | 'listMcpServerStatus'>;
  toolRegistry: Pick<ToolRegistry, 'list'>;
  loop: Pick<ConversationLoop, 'setSystemPrompt'>;
  appStore: Store<AppState>;
  buildSystemPrompt(): string;
  syncLoopTools(tools: ToolDefinition[]): void;
  isPrintMode: boolean;
}

export interface CliRuntimeRefreshResult {
  toolNames: string[];
  runtimeSnapshot: ReturnType<OpenAgentRuntime['buildSnapshot']>;
}

export async function applyCliRuntimeSettingsRefresh(
  context: CliRuntimeRefreshContext,
  settings: Settings | Record<string, unknown> | null | undefined,
): Promise<CliRuntimeRefreshResult> {
  const mcpServers = ((settings as Settings | undefined)?.mcpServers ?? {}) as Record<string, McpServerConfig>;
  await context.runtime.setMcpServers(mcpServers);
  const mcpReady = context.runtime.waitForMcpReady();
  if (mcpReady) {
    await mcpReady;
  }

  const availableTools = context.isPrintMode ? [] : context.toolRegistry.list();
  context.syncLoopTools(availableTools);

  const runtimeSnapshot = context.runtime.buildSnapshot();
  context.appStore.setState((prev) => {
    let next = syncToolRegistryState(prev, availableTools);
    next = syncMcpServerState(next, context.runtime.listMcpServerStatus().map((server) => ({
      name: server.name,
      status: server.status === 'connected'
        ? 'connected'
        : server.status === 'connecting'
          ? 'connecting'
          : server.status === 'needs-auth' || server.status === 'pending' || server.status === 'disabled'
            ? 'disconnected'
            : 'error',
      toolCount: server.tools.length,
      ...(server.error ? { error: server.error } : {}),
    })));
    next = syncRuntimeControlPlane(next, runtimeSnapshot);
    return next;
  });
  context.loop.setSystemPrompt(context.buildSystemPrompt());

  return {
    toolNames: availableTools.map((tool) => tool.name),
    runtimeSnapshot,
  };
}
