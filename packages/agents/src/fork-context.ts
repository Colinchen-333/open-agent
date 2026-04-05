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
  /** Optional directive to prepend to the forked messages. Default: standard child directive. */
  childDirective?: string;
  /** Include a worktree notice if cwd differs from parentCwd. Default: true. */
  includeWorktreeNotice?: boolean;
}

/** The default child directive injected as a system message at the start of the fork. */
export const DEFAULT_CHILD_DIRECTIVE =
  'You are a forked subagent with an isolated context derived from a parent session. ' +
  "Your output is collected and returned to the parent but does not mutate the parent's " +
  'trajectory. Complete your assigned task and return a concise result.';

/**
 * Build a cache-safe fork context from the parent.
 *
 * Cache safety rules:
 *   1. Messages are shallow-cloned (not mutated into the parent).
 *   2. Any tool_use block in the tail without a matching tool_result gets a
 *      synthesized placeholder tool_result ("[forked — result pending]"). This
 *      preserves byte-identical structure for Anthropic API contract validation
 *      while keeping the prompt cache happy.
 *   3. A child directive is prepended as a system message.
 *   4. If cwd differs from parentCwd, a worktree notice follows the directive.
 */
export function createForkContext<T extends ForkableContext>(
  parent: T,
  options: ForkContextOptions = {},
): T {
  // Step 1: shallow-clone collections
  const clonedMessages = [...parent.messages];

  // Step 2: synthesize placeholder tool_results for orphaned tool_use blocks
  const patchedMessages = synthesizePlaceholders(clonedMessages);

  // Step 3: build directive + optional worktree notice
  const prefixMessages: unknown[] = [];
  const directive = options.childDirective ?? DEFAULT_CHILD_DIRECTIVE;
  prefixMessages.push({
    role: 'system',
    content: directive,
  });
  if (
    options.includeWorktreeNotice !== false &&
    parent.cwd &&
    parent.parentCwd &&
    parent.cwd !== parent.parentCwd
  ) {
    prefixMessages.push({
      role: 'system',
      content: `[worktree notice] This fork runs in ${parent.cwd} (parent: ${parent.parentCwd}).`,
    });
  }

  return {
    ...parent,
    allowedTools: new Set(parent.allowedTools),
    messages: [...prefixMessages, ...patchedMessages],
  };
}

/**
 * Scan the message list for `tool_use` blocks whose corresponding `tool_result`
 * is missing from the subsequent messages. For each orphan, append a placeholder
 * tool_result message after the tool_use.
 *
 * This ensures the child context satisfies the Anthropic API invariant that
 * every tool_use block must be followed by a tool_result with the matching id.
 */
function synthesizePlaceholders(messages: unknown[]): unknown[] {
  // Collect all tool_use ids and track which have a corresponding tool_result
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

  // Find orphans (tool_use blocks without a matching tool_result)
  const orphans: string[] = [];
  for (const [id] of toolUseIds) {
    if (!resolvedIds.has(id)) orphans.push(id);
  }

  if (orphans.length === 0) return messages;

  // Append a single user message containing placeholder tool_result blocks for all orphans
  const placeholderMessage = {
    role: 'user',
    content: orphans.map((id) => ({
      type: 'tool_result',
      tool_use_id: id,
      content: '[forked — result pending; parent handles real completion]',
      is_error: false,
    })),
  };

  return [...messages, placeholderMessage];
}
