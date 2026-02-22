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
  status: 'connected' | 'connecting' | 'failed' | 'error' | 'pending' | 'disabled' | 'disconnected';
  tools: McpToolInfo[];
  resources?: McpResourceInfo[];
  error?: string;
  serverInfo?: { name: string; version: string };
  /** Whether the server has been explicitly disabled by the user */
  enabled?: boolean;
}
