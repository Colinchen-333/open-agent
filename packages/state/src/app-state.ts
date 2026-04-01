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
    thinkingConfig: { type: 'adaptive' },
    verbose: false,
    ...overrides,
  };
}
