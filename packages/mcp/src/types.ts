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

export interface McpServerConnection {
  name: string;
  config: McpServerConfig;
  /** Lifecycle state of the server connection */
  status: 'connected' | 'connecting' | 'failed' | 'needs-auth' | 'error' | 'pending' | 'disabled' | 'disconnected';
  tools: McpToolInfo[];
  resources?: McpResourceInfo[];
  error?: string;
  serverInfo?: { name: string; version: string };
  /** Whether the server has been explicitly disabled by the user */
  enabled?: boolean;
}
