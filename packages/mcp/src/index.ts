// @open-agent/mcp - Model Context Protocol client and server
// Implements MCP transport (stdio, SSE, HTTP) and tool proxying

export type { McpServerConfig, McpStdioServerConfig, McpSSEServerConfig, McpHttpServerConfig, McpWsServerConfig, McpSdkServerConfig } from '@open-agent/core';
export * from './types';
export { McpStdioClient } from './stdio-transport';
export { McpHttpClient } from './http-transport';
export { McpSseClient } from './sse-transport';
export { McpWsClient } from './ws-transport';
export { McpManager } from './manager';
export type { ResourceNotificationEvent, McpManagerOptions } from './manager';
export { McpServerState } from './server-state';
export {
  ElicitationManager,
  AUTO_DECLINE_ADAPTER,
} from './elicitation';
export type {
  ElicitationRequest,
  ElicitationResponse,
  ElicitationAdapter,
  ElicitationHook,
  ElicitationCompletionResult,
} from './elicitation';
export { createSamplingHandler } from './sampling';
export type { SamplingHandler } from './sampling';
export { parseMcpToolName, buildMcpToolName, isMcpToolName } from './normalization';
export {
  parseMcpResourceRef,
  buildMcpResourceRef,
  isMcpResourceRef,
  resolveMcpResourceRef,
} from './resource-uri';
export type { ParsedMcpResourceRef, McpResourceContent } from './resource-uri';
export {
  expandEnvVars,
  expandConfigEnvVars,
  mergeScopedConfigs,
} from './config-scope';
export type {
  ConfigScope,
  ScopedMcpServerConfig,
} from './config-scope';
export {
  loadTokens,
  saveTokens,
  storeToken,
  getToken,
  removeToken,
  isTokenExpired,
  buildAuthHeader,
  getAuthHeaders,
  refreshToken,
} from './auth';
export type {
  McpOAuthToken,
  McpOAuthConfig,
} from './auth';
export { resolveHeaders, createEnvHeadersHelper, type HeadersHelper } from './headers-helper';
