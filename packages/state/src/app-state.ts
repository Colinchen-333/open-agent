import type { ToolDefinition } from '@open-agent/tools';
import type {
  PermissionMode,
  ThinkingConfig,
  AgentDefinition,
} from '@open-agent/core';

export interface FileReadTracker {
  markRead(filePath: string): void;
  hasBeenRead(filePath: string): boolean;
}

export interface TaskItem {
  id: string;
  subject: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'deleted';
  owner?: string;
  activeForm?: string;
  blocks?: string[];
  blockedBy?: string[];
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

export interface AgentInstance {
  id: string;
  name: string;
  type: string;
  definition: AgentDefinition;
  status: 'running' | 'idle' | 'completed' | 'failed';
  parentAgentId?: string;
  teamName?: string;
  createdAt: string;
}

export interface McpServerStatus {
  name: string;
  status: 'connected' | 'connecting' | 'disconnected' | 'error';
  toolCount: number;
  error?: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface RuntimePluginState {
  name: string;
  path: string;
  version: string;
  enabled: boolean;
  agentCount: number;
  skillCount: number;
  commandCount: number;
  mcpServerCount: number;
  hookEventCount: number;
  hookCount: number;
}

export interface RuntimeHookState {
  event: string;
  count: number;
  sources: string[];
}

export interface RuntimeDiagnosticState {
  code: string;
  message: string;
  severity: 'info' | 'warning' | 'error';
  source?: string;
}

export interface RuntimeCapabilitySummaryState {
  totalTools: number;
  mcpTools: number;
  dynamicTools: number;
}

export interface RuntimeControlPlaneState {
  agentNames: string[];
  skillNames: string[];
  plugins: RuntimePluginState[];
  hooks: RuntimeHookState[];
  diagnostics: RuntimeDiagnosticState[];
  capabilitySummary: RuntimeCapabilitySummaryState;
}

export interface DispatcherControlPlaneState {
  dispatcherId: string;
  teamName: string;
  status: string;
  startedAt: string;
  updatedAt: string;
  payload: unknown;
}

export interface DispatcherDiagnosisControlPlaneState {
  dispatcherId: string;
  teamName: string;
  healthy: boolean;
  source: string;
  observedAt: string;
  findingCount: number;
  payload: unknown;
}

export interface TimelineControlPlaneItemState {
  key: string;
  kind: string;
  sessionId: string;
  timestamp: string;
  cursor?: string;
  timelineId?: string;
  payload: unknown;
}

export interface TeamInboxMessageControlPlaneState {
  messageId: string;
  type: string;
  from: string;
  to?: string;
  content: string;
  summary?: string;
  timestamp: string;
  requestId?: string;
  approve?: boolean;
  readAt?: string;
}

export interface TeamInboxMemberControlPlaneState {
  teamName: string;
  memberName: string;
  unreadCount: number;
  updatedAt: string;
  messages: TeamInboxMessageControlPlaneState[];
}

export interface TeamApprovalControlPlaneState {
  messageId: string;
  teamName: string;
  memberName: string;
  requestType: string;
  requestId: string;
  from: string;
  to?: string;
  content: string;
  summary?: string;
  timestamp: string;
  readAt?: string;
}

export interface AppState {
  // Session
  sessionId: string;
  cwd: string;
  model: string;
  permissionMode: PermissionMode;

  // Conversation
  // Note: messages lives in ConversationLoop, not in AppState.
  totalUsage: TokenUsage;

  // Tools
  tools: Map<string, ToolDefinition>;
  fileReadTracker: FileReadTracker;

  // MCP
  mcpServers: McpServerStatus[];

  // Agents & Tasks
  tasks: Record<string, TaskItem>;
  teammates: Map<string, AgentInstance>;
  agentNameRegistry: Map<string, string>;
  activeTeamName: string | null;

  // Runtime control plane
  runtime: RuntimeControlPlaneState;
  dispatchers: Record<string, DispatcherControlPlaneState>;
  dispatcherDiagnoses: Record<string, DispatcherDiagnosisControlPlaneState>;
  timeline: TimelineControlPlaneItemState[];
  inboxes: Record<string, Record<string, TeamInboxMemberControlPlaneState>>;
  approvals: Record<string, Record<string, TeamApprovalControlPlaneState[]>>;

  // Settings
  thinkingConfig: ThinkingConfig;
  verbose: boolean;
}

export function createDefaultAppState(overrides: Partial<AppState> = {}): AppState {
  const readFiles = new Set<string>();
  return {
    sessionId: '',
    cwd: process.cwd(),
    model: '',
    permissionMode: 'default',
    totalUsage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    tools: new Map(),
    fileReadTracker: {
      markRead: (p: string) => readFiles.add(p),
      hasBeenRead: (p: string) => readFiles.has(p),
    },
    mcpServers: [],
    tasks: {},
    teammates: new Map(),
    agentNameRegistry: new Map(),
    activeTeamName: null,
    runtime: {
      agentNames: [],
      skillNames: [],
      plugins: [],
      hooks: [],
      diagnostics: [],
      capabilitySummary: {
        totalTools: 0,
        mcpTools: 0,
        dynamicTools: 0,
      },
    },
    dispatchers: {},
    dispatcherDiagnoses: {},
    timeline: [],
    inboxes: {},
    approvals: {},
    thinkingConfig: { type: 'adaptive' },
    verbose: false,
    ...overrides,
  };
}
