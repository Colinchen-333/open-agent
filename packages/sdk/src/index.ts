// @open-agent/sdk – Public SDK API for embedding open-agent in other projects
//
// Surface:
//   - query()                        V1 streaming API
//   - unstable_v2_prompt()           V2 one-shot helper
//   - unstable_v2_createSession()    V2 stateful session
//   - unstable_v2_resumeSession()    V2 session resumption
//   - createSdkMcpServer() / tool()  MCP in-process server helpers

export * from './types.js';
export { query } from './query.js';
export {
  unstable_v2_prompt,
  unstable_v2_createSession,
  unstable_v2_resumeSession,
} from './session.js';
export {
  createSdkMcpServer,
  tool,
  type SdkMcpToolDefinition,
  type SdkMcpServerInstance,
} from './mcp-helpers.js';

// Re-export the most commonly needed core types so consumers do not have to
// depend on @open-agent/core directly.
export type {
  SDKMessage,
  SDKAssistantMessage,
  SDKUserMessage,
  SDKResultMessage,
  SDKResultSuccess,
  SDKResultError,
  SDKSystemMessage,
  SDKStatusMessage,
  SDKPartialAssistantMessage,
  PermissionMode,
  HookEvent,
  ModelInfo,
  AccountInfo,
  McpServerStatus,
  ThinkingConfig,
  ModelUsage,
  SlashCommand,
} from '@open-agent/core';
