import type { ToolDefinition } from '@open-agent/tools';
import type { ThinkingConfig } from '@open-agent/core';
import type {
  AppState,
  DispatcherControlPlaneState,
  McpServerStatus,
  RuntimeDiagnosticState,
  RuntimeHookState,
  RuntimePluginState,
  TimelineControlPlaneItemState,
} from './app-state.js';

export interface RuntimeControlPlaneSnapshotInput {
  agents?: Array<{ name: string }>;
  skills?: Array<{ name: string }>;
  plugins?: RuntimePluginState[];
  hooks?: RuntimeHookState[];
  diagnostics?: RuntimeDiagnosticState[];
  capabilitySnapshot?: {
    totalTools: number;
    summary: {
      mcpTools: number;
      dynamicTools: number;
    };
  };
}

export function syncSessionControlPlane(
  state: AppState,
  patch: {
    model?: string;
    permissionMode?: AppState['permissionMode'];
    thinkingConfig?: ThinkingConfig;
    verbose?: boolean;
  },
): AppState {
  return {
    ...state,
    ...(patch.model !== undefined ? { model: patch.model } : {}),
    ...(patch.permissionMode !== undefined ? { permissionMode: patch.permissionMode } : {}),
    ...(patch.thinkingConfig !== undefined ? { thinkingConfig: patch.thinkingConfig } : {}),
    ...(patch.verbose !== undefined ? { verbose: patch.verbose } : {}),
  };
}

export function syncToolRegistryState(
  state: AppState,
  tools: Iterable<ToolDefinition>,
): AppState {
  return {
    ...state,
    tools: new Map([...tools].map((tool) => [tool.name, tool])),
  };
}

export function syncMcpServerState(
  state: AppState,
  servers: McpServerStatus[],
): AppState {
  return {
    ...state,
    mcpServers: servers.map((server) => ({ ...server })),
  };
}

export function syncRuntimeControlPlane(
  state: AppState,
  snapshot: RuntimeControlPlaneSnapshotInput,
): AppState {
  return {
    ...state,
    runtime: {
      agentNames: (snapshot.agents ?? []).map((entry) => entry.name),
      skillNames: (snapshot.skills ?? []).map((entry) => entry.name),
      plugins: (snapshot.plugins ?? []).map((entry) => ({ ...entry })),
      hooks: (snapshot.hooks ?? []).map((entry) => ({
        ...entry,
        sources: [...entry.sources],
      })),
      diagnostics: (snapshot.diagnostics ?? []).map((entry) => ({ ...entry })),
      capabilitySummary: {
        totalTools: snapshot.capabilitySnapshot?.totalTools ?? 0,
        mcpTools: snapshot.capabilitySnapshot?.summary.mcpTools ?? 0,
        dynamicTools: snapshot.capabilitySnapshot?.summary.dynamicTools ?? 0,
      },
    },
  };
}

export function setActiveTeamControlPlane(
  state: AppState,
  activeTeamName: string | null,
): AppState {
  return {
    ...state,
    activeTeamName,
  };
}

export function upsertDispatcherControlPlane(
  state: AppState,
  dispatcher: DispatcherControlPlaneState,
): AppState {
  return {
    ...state,
    dispatchers: {
      ...state.dispatchers,
      [dispatcher.dispatcherId]: {
        ...dispatcher,
      },
    },
  };
}

export function removeDispatcherControlPlane(
  state: AppState,
  dispatcherId: string,
): AppState {
  if (!(dispatcherId in state.dispatchers)) {
    return state;
  }
  const next = { ...state.dispatchers };
  delete next[dispatcherId];
  return {
    ...state,
    dispatchers: next,
  };
}

export function appendTimelineControlPlane(
  state: AppState,
  item: TimelineControlPlaneItemState,
  limit = 200,
): AppState {
  const dedupeKey = item.key;
  const filtered = state.timeline.filter((entry) => entry.key !== dedupeKey);
  const nextTimeline = [...filtered, {
    ...item,
  }];
  return {
    ...state,
    timeline: nextTimeline.slice(-limit),
  };
}
