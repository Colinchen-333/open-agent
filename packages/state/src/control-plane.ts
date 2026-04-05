import type { ToolDefinition } from '@open-agent/tools';
import type { ThinkingConfig } from '@open-agent/core';
import type {
  AppState,
  DispatcherDiagnosisControlPlaneState,
  DispatcherControlPlaneState,
  McpServerStatus,
  RuntimeDiagnosticState,
  RuntimeHookState,
  RuntimePluginState,
  SchedulerControlPlaneState,
  TeamApprovalControlPlaneState,
  TeamInboxMemberControlPlaneState,
  TeamInboxMessageControlPlaneState,
  TimelineControlPlaneItemState,
  TaskItem,
  WorkerControlPlaneState,
  RuntimeDiagnosticSummaryState,
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

function summarizeRuntimeDiagnostics(
  diagnostics: RuntimeDiagnosticState[] = [],
): RuntimeDiagnosticSummaryState {
  return diagnostics.reduce<RuntimeDiagnosticSummaryState>((acc, entry) => {
    acc.total += 1;
    acc[entry.severity] += 1;
    if (entry.source) {
      acc.bySource[entry.source] = (acc.bySource[entry.source] ?? 0) + 1;
    }
    return acc;
  }, {
    total: 0,
    info: 0,
    warning: 0,
    error: 0,
    bySource: {},
  });
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
      diagnosticSummary: summarizeRuntimeDiagnostics(snapshot.diagnostics ?? []),
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

export function upsertTaskControlPlane(
  state: AppState,
  task: TaskItem,
): AppState {
  return {
    ...state,
    tasks: {
      ...state.tasks,
      [task.id]: {
        ...task,
        ...(task.blocks ? { blocks: [...task.blocks] } : {}),
        ...(task.blockedBy ? { blockedBy: [...task.blockedBy] } : {}),
        ...(task.metadata ? { metadata: { ...task.metadata } } : {}),
      },
    },
  };
}

export function removeTaskControlPlane(
  state: AppState,
  taskId: string,
): AppState {
  if (!(taskId in state.tasks)) {
    return state;
  }
  const next = { ...state.tasks };
  delete next[taskId];
  return {
    ...state,
    tasks: next,
  };
}

export function upsertWorkerControlPlane(
  state: AppState,
  worker: WorkerControlPlaneState,
): AppState {
  return {
    ...state,
    workers: {
      ...state.workers,
      [worker.workerId]: {
        ...worker,
      },
    },
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

export function upsertDispatcherDiagnosisControlPlane(
  state: AppState,
  diagnosis: DispatcherDiagnosisControlPlaneState,
): AppState {
  return {
    ...state,
    dispatcherDiagnoses: {
      ...state.dispatcherDiagnoses,
      [diagnosis.dispatcherId]: {
        ...diagnosis,
      },
    },
  };
}

export function syncSchedulerControlPlane(
  state: AppState,
  scheduler: SchedulerControlPlaneState,
): AppState {
  return {
    ...state,
    scheduler: {
      fairnessCursor: scheduler.fairnessCursor,
      updatedAt: scheduler.updatedAt,
      queue: scheduler.queue.map((entry) => ({ ...entry })),
    },
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

function derivePendingApprovals(
  memberSnapshot: TeamInboxMemberControlPlaneState,
): TeamApprovalControlPlaneState[] {
  return memberSnapshot.messages
    .filter((message) =>
      (message.type === 'shutdown_request' || message.type === 'plan_approval_request')
      && typeof message.requestId === 'string'
      && message.requestId.length > 0,
    )
    .map((message) => ({
      messageId: message.messageId,
      teamName: memberSnapshot.teamName,
      memberName: memberSnapshot.memberName,
      requestType: message.type,
      requestId: message.requestId!,
      from: message.from,
      ...(message.to ? { to: message.to } : {}),
      content: message.content,
      ...(message.summary ? { summary: message.summary } : {}),
      timestamp: message.timestamp,
      ...(message.readAt ? { readAt: message.readAt } : {}),
    }));
}

export function syncTeamInboxMemberControlPlane(
  state: AppState,
  input: {
    teamName: string;
    memberName: string;
    messages: TeamInboxMessageControlPlaneState[];
    updatedAt?: string;
  },
): AppState {
  const memberSnapshot: TeamInboxMemberControlPlaneState = {
    teamName: input.teamName,
    memberName: input.memberName,
    unreadCount: input.messages.filter((message) => !message.readAt).length,
    updatedAt: input.updatedAt ?? new Date().toISOString(),
    messages: input.messages.map((message) => ({ ...message })),
  };
  return {
    ...state,
    inboxes: {
      ...state.inboxes,
      [input.teamName]: {
        ...(state.inboxes[input.teamName] ?? {}),
        [input.memberName]: memberSnapshot,
      },
    },
    approvals: {
      ...state.approvals,
      [input.teamName]: {
        ...(state.approvals[input.teamName] ?? {}),
        [input.memberName]: derivePendingApprovals(memberSnapshot),
      },
    },
  };
}
