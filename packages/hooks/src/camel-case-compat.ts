import type { HookInput } from './types';

/**
 * Build a camelCase-aliased version of a HookInput for Claude Code compatibility.
 * Returns an object containing BOTH the original snake_case fields AND the camelCase aliases.
 * This allows hooks written for either convention to read the fields they expect.
 *
 * Claude Code's hook stdin contract uses camelCase (`hookEvent`, `toolName`,
 * `toolUse: { id, input }`, `sessionId`, …). OpenAgent's internal canonical
 * representation is snake_case (`hook_event_name`, `tool_name`, `tool_input`, …).
 * By emitting both we remain backward-compatible with existing OpenAgent hooks while
 * enabling Claude Code hooks to work without modification.
 */
export function withCamelCaseAliases(input: HookInput): Record<string, unknown> {
  const base: Record<string, unknown> = { ...input };

  // Base fields present on every event
  if ('session_id' in input) base.sessionId = input.session_id;
  if ('transcript_path' in input) base.transcriptPath = input.transcript_path;
  if ('permission_mode' in input) base.permissionMode = input.permission_mode;
  if ('hook_event_name' in input) base.hookEvent = input.hook_event_name;

  // Tool-related events (PreToolUse, PostToolUse, PostToolUseFailure, PermissionRequest)
  if ('tool_name' in input) base.toolName = (input as any).tool_name;
  if ('tool_input' in input) {
    base.toolUse = {
      id: (input as any).tool_use_id,
      input: (input as any).tool_input,
    };
  }
  if ('tool_use_id' in input) base.toolUseId = (input as any).tool_use_id;
  if ('tool_response' in input) base.toolResponse = (input as any).tool_response;

  // Stop / SubagentStop
  if ('stop_hook_active' in input) base.stopHookActive = (input as any).stop_hook_active;
  if ('last_assistant_message' in input) base.lastAssistantMessage = (input as any).last_assistant_message;

  // Notification
  if ('notification_type' in input) base.notificationType = (input as any).notification_type;

  // PreCompact
  if ('custom_instructions' in input) base.customInstructions = (input as any).custom_instructions;

  // Subagent events
  if ('agent_type' in input) base.agentType = (input as any).agent_type;
  if ('agent_id' in input) base.agentId = (input as any).agent_id;
  if ('agent_transcript_path' in input) base.agentTranscriptPath = (input as any).agent_transcript_path;

  // ConfigChange
  if ('file_path' in input) base.filePath = (input as any).file_path;

  // Team events
  if ('teammate_name' in input) base.teammateName = (input as any).teammate_name;
  if ('team_name' in input) base.teamName = (input as any).team_name;

  // TaskCompleted
  if ('task_id' in input) base.taskId = (input as any).task_id;
  if ('task_subject' in input) base.taskSubject = (input as any).task_subject;
  if ('task_description' in input) base.taskDescription = (input as any).task_description;

  // WorktreeRemove
  if ('worktree_path' in input) base.worktreePath = (input as any).worktree_path;

  return base;
}
