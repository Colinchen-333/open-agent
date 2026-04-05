/**
 * Describes the minimum context a parent agent must expose for forking.
 * The fork receives a deep-enough clone so that subsequent parent mutations
 * (adding tools, appending messages) do NOT bleed into the forked session.
 */
export interface ForkableContext {
  permissionMode: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions' | 'dontAsk';
  allowedTools: Set<string>;
  messages: unknown[];
}

/**
 * Snapshot the parent's permission/tool context for a forked subagent.
 * Returns a shallow-spread copy where mutable collections (Set, Array) are
 * independently cloned so parent mutations after the fork do not affect the
 * returned snapshot.
 */
export function createForkContext<T extends ForkableContext>(parent: T): T {
  return {
    ...parent,
    allowedTools: new Set(parent.allowedTools),
    messages: [...parent.messages],
  };
}
