/**
 * Helpers for normalizing MCP tool names between their prefixed form
 * (`mcp__<server>__<tool>`) and the raw server-reported form.
 *
 * These utilities mirror the normalization roundtrip described in the Claude Code
 * reference implementation (services/mcp/normalization.ts).
 */

/**
 * Parse a tool name into `{ serverName, toolName }` if it uses the MCP prefix
 * convention, otherwise return null.
 *
 * Server names may themselves contain underscores (e.g. "my_server"), so the
 * regex uses a non-greedy match up to the last `__` separator.
 */
export function parseMcpToolName(name: string): { serverName: string; toolName: string } | null {
  const m = name.match(/^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/);
  if (!m) return null;
  return { serverName: m[1]!, toolName: m[2]! };
}

/** Build a prefixed MCP tool name from its components. */
export function buildMcpToolName(serverName: string, toolName: string): string {
  return `mcp__${serverName}__${toolName}`;
}

/** Returns true when the given tool name uses the `mcp__<server>__<tool>` prefix convention. */
export function isMcpToolName(name: string): boolean {
  return parseMcpToolName(name) !== null;
}
