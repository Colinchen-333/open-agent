import type { McpToolInfo } from './types';

/**
 * Raw MCP annotations as they arrive from a listTools response.
 * The MCP spec (2024-11-05) uses a `*Hint` suffix for each field, but some
 * servers (and our own SDK-server path) omit the suffix.  We accept both forms
 * and normalise to the un-suffixed canonical names used internally.
 */
type RawMcpAnnotations = {
  // Canonical (un-suffixed) form — used by SDK servers and unit tests.
  readOnly?: unknown;
  destructive?: unknown;
  openWorld?: unknown;
  idempotent?: unknown;
  // Spec (Hint-suffixed) form — used by external MCP servers per 2024-11-05 spec.
  readOnlyHint?: unknown;
  destructiveHint?: unknown;
  openWorldHint?: unknown;
  idempotentHint?: unknown;
} | null | undefined;

type RawMcpTool = {
  name: string;
  description?: string;
  inputSchema?: Record<string, any>;
  annotations?: RawMcpAnnotations;
};

/**
 * Resolve a raw annotation field from either the spec Hint-suffixed form or the
 * canonical un-suffixed form.  The Hint-suffixed form takes precedence when both
 * are present (mirrors the spec's authoritative source).
 */
function resolveAnnotationBool(hint: unknown, plain: unknown): boolean | undefined {
  if (typeof hint === 'boolean') return hint;
  if (typeof plain === 'boolean') return plain;
  return undefined;
}

export function normalizeMcpAnnotations(annotations: RawMcpAnnotations): McpToolInfo['annotations'] | undefined {
  if (!annotations) {
    return undefined;
  }

  const readOnly    = resolveAnnotationBool(annotations.readOnlyHint,    annotations.readOnly);
  const destructive = resolveAnnotationBool(annotations.destructiveHint, annotations.destructive);
  const openWorld   = resolveAnnotationBool(annotations.openWorldHint,   annotations.openWorld);
  const idempotent  = resolveAnnotationBool(annotations.idempotentHint,  annotations.idempotent);

  const normalized = {
    ...(readOnly    !== undefined ? { readOnly }    : {}),
    ...(destructive !== undefined ? { destructive } : {}),
    ...(openWorld   !== undefined ? { openWorld }   : {}),
    ...(idempotent  !== undefined ? { idempotent }  : {}),
  };

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function normalizeMcpToolInfo(serverName: string, tool: RawMcpTool): McpToolInfo {
  const annotations = normalizeMcpAnnotations(tool.annotations);

  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
    serverName,
    ...(annotations ? { annotations } : {}),
  };
}
