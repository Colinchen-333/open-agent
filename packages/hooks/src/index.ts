// @open-agent/hooks - Hook system
// Provides event-driven lifecycle hooks for PreToolUse, PostToolUse, SessionStart, etc.

export { HOOK_EVENTS } from '@open-agent/core';
export type { HookEvent } from '@open-agent/core';

export * from './types';
export { HookExecutor } from './executor';
