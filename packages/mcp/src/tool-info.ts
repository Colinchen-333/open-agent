import type { McpToolInfo } from './types';

type RawMcpAnnotations = {
  readOnly?: unknown;
  destructive?: unknown;
  openWorld?: unknown;
} | null | undefined;

type RawMcpTool = {
  name: string;
  description?: string;
  inputSchema?: Record<string, any>;
  annotations?: RawMcpAnnotations;
};

export function normalizeMcpAnnotations(annotations: RawMcpAnnotations): McpToolInfo['annotations'] | undefined {
  if (!annotations) {
    return undefined;
  }

  const normalized = {
    ...(typeof annotations.readOnly === 'boolean' ? { readOnly: annotations.readOnly } : {}),
    ...(typeof annotations.destructive === 'boolean' ? { destructive: annotations.destructive } : {}),
    ...(typeof annotations.openWorld === 'boolean' ? { openWorld: annotations.openWorld } : {}),
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
