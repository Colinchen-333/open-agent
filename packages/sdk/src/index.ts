// @open-agent/sdk – Public SDK API for embedding open-agent in other projects
//
// Surface:
//   query(prompt, options?)                  Primary streaming API (Claude Code style)
//   createSession(options?)                  Multi-turn session (stable)
//   resumeSession(sessionId, options?)       Resume a session with transcript (stable)
//   unstable_v2_prompt()                     Legacy one-shot helper
//   unstable_v2_createSession()              Legacy stateful session
//   unstable_v2_resumeSession()              Legacy session resumption
//   createSdkMcpServer() / tool()            MCP in-process server helpers

export * from './types.js';

// Primary V1 API
export { query } from './query.js';

// Session utilities
export { listSessions } from './list-sessions.js';

// Stable V2 session API
export { createSession, resumeSession, forkSession } from './session.js';
export type { SDKSession } from './session.js';

// Legacy V2 API (preserved for backwards compatibility)
export {
  unstable_v2_prompt,
  unstable_v2_createSession,
  unstable_v2_resumeSession,
} from './session.js';

// MCP helpers
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
  SessionInfo,
} from '@open-agent/core';

// Provider Message type for low-level usage
export type { Message } from '@open-agent/providers';
