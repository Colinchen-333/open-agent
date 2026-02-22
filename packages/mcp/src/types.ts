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
  status: 'connected' | 'failed' | 'pending' | 'disabled';
  tools: McpToolInfo[];
  error?: string;
  serverInfo?: { name: string; version: string };
}
