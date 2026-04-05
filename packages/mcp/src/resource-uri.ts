/**
 * @mcp:// URI utilities for MCP resource attachment references.
 *
 * Format: `@mcp://<server>/<resource-uri-path>`
 *
 * The resource URI path may itself contain a scheme, e.g.:
 *   @mcp://fs/file:///tmp/foo.txt  →  server="fs", resourceUri="file:///tmp/foo.txt"
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ParsedMcpResourceRef {
  serverName: string;
  resourceUri: string;
}

export interface McpResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
}

// ── URI parse / build ─────────────────────────────────────────────────────────

const MCP_PREFIX = '@mcp://';

/**
 * Parse an `@mcp://` URI attachment reference into server name and resource URI.
 *
 * Returns null if the string doesn't start with `@mcp://`, if there is no
 * server name, or if there is no resource URI path after the first slash.
 */
export function parseMcpResourceRef(ref: string): ParsedMcpResourceRef | null {
  if (!ref.startsWith(MCP_PREFIX)) return null;

  const rest = ref.slice(MCP_PREFIX.length);
  const slashIdx = rest.indexOf('/');
  // slashIdx must be > 0: there must be at least one character for the server name
  // before the slash, and the slash itself must be present.
  if (slashIdx <= 0) return null;

  const serverName = rest.slice(0, slashIdx);
  const resourceUri = rest.slice(slashIdx + 1);

  if (!serverName || !resourceUri) return null;

  return { serverName, resourceUri };
}

/** Build an `@mcp://` reference string from its components. */
export function buildMcpResourceRef(serverName: string, resourceUri: string): string {
  return `${MCP_PREFIX}${serverName}/${resourceUri}`;
}

/** Returns true when the string looks like a valid MCP resource reference. */
export function isMcpResourceRef(s: string): boolean {
  return parseMcpResourceRef(s) !== null;
}

// ── Resolver ──────────────────────────────────────────────────────────────────

/**
 * Resolve an `@mcp://` reference by reading the resource from the appropriate
 * server via `manager.readResource`.
 *
 * Throws if the reference is malformed or the manager call fails.
 */
export async function resolveMcpResourceRef(
  ref: string,
  manager: {
    readResource(
      serverName: string,
      uri: string,
    ): Promise<{ contents: McpResourceContent[] }>;
  },
): Promise<McpResourceContent[]> {
  const parsed = parseMcpResourceRef(ref);
  if (!parsed) throw new Error(`Not a valid @mcp:// reference: ${ref}`);

  const result = await manager.readResource(parsed.serverName, parsed.resourceUri);
  return result.contents;
}
