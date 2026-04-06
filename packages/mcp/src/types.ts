import type { McpServerConfig } from '@open-agent/core';

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema: Record<string, any>;
  serverName: string;
  annotations?: {
    readOnly?: boolean;
    destructive?: boolean;
    openWorld?: boolean;
    idempotent?: boolean;
  };
  /** MCP origin metadata — mirrors ToolDefinition.mcpInfo for the intermediate representation. */
  mcpInfo?: {
    serverName: string;
    /** The tool name as returned by the MCP server (without the `mcp__<server>__` prefix). */
    toolName: string;
  };
}

export interface McpResourceInfo {
  uri: string;
  name: string;
  mimeType?: string;
  description?: string;
  server: string;
}

export interface McpPromptInfo {
  name: string;
  description?: string;
  arguments?: Array<{
    name: string;
    description?: string;
    required?: boolean;
  }>;
  serverName: string;
}

export interface McpPromptMessage {
  role: 'user' | 'assistant';
  content: {
    type: 'text';
    text: string;
  };
}

/** Sampling request from MCP server → client */
export interface McpSamplingRequest {
  messages: McpPromptMessage[];
  modelPreferences?: {
    hints?: Array<{ name?: string }>;
    costPriority?: number;
    speedPriority?: number;
    intelligencePriority?: number;
  };
  systemPrompt?: string;
  includeContext?: 'none' | 'thisServer' | 'allServers';
  temperature?: number;
  maxTokens: number;
  stopSequences?: string[];
  metadata?: Record<string, unknown>;
}

export interface McpSamplingResponse {
  role: 'assistant';
  content: {
    type: 'text';
    text: string;
  };
  model: string;
  stopReason?: 'endTurn' | 'stopSequence' | 'maxTokens';
}

export interface McpServerConnection {
  name: string;
  config: McpServerConfig;
  /** Lifecycle state of the server connection */
  status: 'connected' | 'connecting' | 'failed' | 'needs-auth' | 'error' | 'pending' | 'disabled' | 'disconnected';
  tools: McpToolInfo[];
  resources?: McpResourceInfo[];
  prompts?: McpPromptInfo[];
  error?: string;
  serverInfo?: { name: string; version: string };
  /** Whether the server has been explicitly disabled by the user */
  enabled?: boolean;
}
