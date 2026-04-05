/**
 * Describes the minimum context a parent agent must expose for forking.
 * The fork receives a deep-enough clone so that subsequent parent mutations
 * (adding tools, appending messages) do NOT bleed into the forked session.
 */
export interface ForkableContext {
  permissionMode: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions' | 'dontAsk';
  allowedTools: Set<string>;
  messages: unknown[];
  /** cwd of the fork (may differ from parent for worktree isolation). */
  cwd?: string;
  /** Parent's cwd (used to compose the worktree notice). */
  parentCwd?: string;
}

export interface ForkContextOptions {
  /** Optional directive to inject as the child directive text block. Default: standard child directive. */
  childDirective?: string;
  /** Include a worktree notice if cwd differs from parentCwd. Default: true. */
  includeWorktreeNotice?: boolean;
}

/** The default child directive injected as a text block in the directive user message. */
export const DEFAULT_CHILD_DIRECTIVE =
  'You are a forked subagent with an isolated context derived from a parent session. ' +
  "Your output is collected and returned to the parent but does not mutate the parent's " +
  'trajectory. Complete your assigned task and return a concise result.';

/**
 * Build a cache-stable fork context from the parent using the assistant+user prefix structure.
 *
 * The structure matches Claude Code's cache-stable fork pattern:
 *   [...parent messages exactly as-is]
 *   { role: 'user', content: [...placeholder tool_results, { type: 'text', text: directive }] }
 *
 * This keeps the parent messages byte-identical (maximizing prompt-cache hits) and satisfies
 * the Anthropic API's assistant→user alternation requirement.  No system messages are inserted
 * into the middle of the conversation.
 *
 * Cache safety rules:
 *   1. Messages are shallow-cloned (not mutated into the parent).
 *   2. Any tool_use block without a matching tool_result gets a synthesized placeholder
 *      tool_result block in the directive user message.  This keeps the API contract intact
 *      while preserving byte-identical parent messages.
 *   3. A single user message containing all placeholder tool_results (if any) followed by
 *      a text block with the directive (+ optional worktree notice) is appended last.
 */
export function createForkContext<T extends ForkableContext>(
  parent: T,
  options: ForkContextOptions = {},
): T {
  // Step 1: shallow-clone the parent message array
  const clonedMessages = [...parent.messages];

  // Step 2: build directive text (+ optional worktree notice in the same text block)
  const directive = options.childDirective ?? DEFAULT_CHILD_DIRECTIVE;
  let directiveText = directive;
  if (
    options.includeWorktreeNotice !== false &&
    parent.cwd &&
    parent.parentCwd &&
    parent.cwd !== parent.parentCwd
  ) {
    directiveText += `\n\n[worktree notice] This fork runs in ${parent.cwd} (parent: ${parent.parentCwd}).`;
  }

  // Step 3: find orphaned tool_use ids (tool_use blocks without a matching tool_result)
  const orphans = findOrphanedToolUseIds(clonedMessages);

  // Step 4: build a single user message:
  //   - placeholder tool_result blocks for each orphan (satisfies API invariant)
  //   - a text block carrying the directive
  const userContent: Array<Record<string, unknown>> = [];

  for (const id of orphans) {
    userContent.push({
      type: 'tool_result',
      tool_use_id: id,
      content: '[forked — result pending; parent handles real completion]',
      is_error: false,
    });
  }

  userContent.push({
    type: 'text',
    text: directiveText,
  });

  const directiveMessage = {
    role: 'user',
    content: userContent,
  };

  return {
    ...parent,
    allowedTools: new Set(parent.allowedTools),
    messages: [...clonedMessages, directiveMessage],
  };
}

/**
 * Scan a message list and return the ids of any `tool_use` blocks that have no
 * corresponding `tool_result` block anywhere in the list.
 *
 * These orphans must receive a placeholder tool_result in the fork's directive
 * user message so that the Anthropic API invariant (every tool_use must be
 * followed by a matching tool_result) is satisfied.
 */
export function findOrphanedToolUseIds(messages: unknown[]): string[] {
  const toolUseIds = new Map<string, number>(); // id → message index
  const resolvedIds = new Set<string>();

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i] as Record<string, unknown>;
    if (!msg || typeof msg !== 'object') continue;
    const content = msg.content;
    if (!Array.isArray(content)) continue;
    for (const block of content as unknown[]) {
      if (!block || typeof block !== 'object') continue;
      const b = block as Record<string, unknown>;
      if (b.type === 'tool_use' && typeof b.id === 'string') {
        toolUseIds.set(b.id, i);
      } else if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
        resolvedIds.add(b.tool_use_id);
      }
    }
  }

  const orphans: string[] = [];
  for (const [id] of toolUseIds) {
    if (!resolvedIds.has(id)) orphans.push(id);
  }
  return orphans;
}
