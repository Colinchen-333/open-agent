// @open-agent/state — reactive store

export type Store<T> = {
  getState(): T;
  setState(updater: (prev: T) => T): void;
  subscribe(listener: () => void): () => void;
};

export function createStore<T>(
  initialState: T,
  onChange?: (prev: T, next: T) => void,
): Store<T> {
  let state = initialState;
  const listeners = new Set<() => void>();

  return {
    getState() {
      return state;
    },

    setState(updater) {
      const prev = state;
      const next = updater(prev);
      if (Object.is(prev, next)) return;
      state = next;
      onChange?.(prev, next);
      for (const listener of listeners) {
        listener();
      }
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export {
  type AppState,
  type TaskItem,
  type AgentInstance,
  type McpServerStatus,
  type TokenUsage,
  type FileReadTracker,
  type RuntimePluginState,
  type RuntimeHookState,
  type RuntimeDiagnosticState,
  type RuntimeCapabilitySummaryState,
  type RuntimeControlPlaneState,
  type DispatcherDiagnosisControlPlaneState,
  type DispatcherControlPlaneState,
  type WorkerControlPlaneState,
  type TeamInboxMessageControlPlaneState,
  type TeamInboxMemberControlPlaneState,
  type TeamApprovalControlPlaneState,
  type TimelineControlPlaneItemState,
  createDefaultAppState,
} from './app-state.js';

export {
  syncSessionControlPlane,
  syncToolRegistryState,
  syncMcpServerState,
  syncRuntimeControlPlane,
  setActiveTeamControlPlane,
  upsertTaskControlPlane,
  removeTaskControlPlane,
  upsertWorkerControlPlane,
  upsertDispatcherControlPlane,
  upsertDispatcherDiagnosisControlPlane,
  removeDispatcherControlPlane,
  appendTimelineControlPlane,
  syncTeamInboxMemberControlPlane,
  type RuntimeControlPlaneSnapshotInput,
} from './control-plane.js';
