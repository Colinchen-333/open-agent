/**
 * Dynamic header injection for MCP HTTP/SSE transports.
 * Matches Claude Code's headersHelper pattern where headers
 * can be evaluated at runtime (e.g., from env vars or token refresh).
 */

export type HeadersHelper = () => Record<string, string> | Promise<Record<string, string>>;

/**
 * Resolve headers from a static record or a dynamic helper.
 */
export async function resolveHeaders(
  staticHeaders?: Record<string, string>,
  helper?: HeadersHelper,
): Promise<Record<string, string>> {
  const base = staticHeaders ? { ...staticHeaders } : {};
  if (helper) {
    const dynamic = await helper();
    return { ...base, ...dynamic };
  }
  return base;
}

/**
 * Create a headers helper from environment variable mappings.
 * Each key is a header name, each value is an env var name.
 * Example: { 'Authorization': 'MCP_AUTH_TOKEN' } -> { 'Authorization': 'Bearer xxx' }
 */
export function createEnvHeadersHelper(
  envMapping: Record<string, string>,
  prefix?: string,
): HeadersHelper {
  return () => {
    const headers: Record<string, string> = {};
    for (const [headerName, envVar] of Object.entries(envMapping)) {
      const value = process.env[envVar];
      if (value) {
        headers[headerName] = prefix ? `${prefix} ${value}` : value;
      }
    }
    return headers;
  };
}
