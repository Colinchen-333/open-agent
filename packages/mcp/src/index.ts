// @open-agent/mcp - Model Context Protocol client and server
// Implements MCP transport (stdio, SSE, HTTP) and tool proxying

export type { McpServerConfig, McpStdioServerConfig, McpSSEServerConfig, McpHttpServerConfig, McpSdkServerConfig } from '@open-agent/core';
export * from './types';
export { McpStdioClient } from './stdio-transport';
export { McpHttpClient } from './http-transport';
export { McpSseClient } from './sse-transport';
export { McpManager } from './manager';
export { parseMcpToolName, buildMcpToolName, isMcpToolName } from './normalization';
export {
  parseMcpResourceRef,
  buildMcpResourceRef,
  isMcpResourceRef,
  resolveMcpResourceRef,
} from './resource-uri';
export type { ParsedMcpResourceRef, McpResourceContent } from './resource-uri';
