import type { McpToolInfo } from './types';

type RawMcpToolInfo = {
  name: string;
  description?: string;
  inputSchema?: Record<string, any>;
  annotations?: {
    readOnly?: boolean;
    destructive?: boolean;
    openWorld?: boolean;
  } | null;
};

export function normalizeMcpToolInfo(
  serverName: string,
  tool: RawMcpToolInfo,
): McpToolInfo {
  const annotations = tool.annotations
    ? {
        ...(typeof tool.annotations.readOnly === 'boolean'
          ? { readOnly: tool.annotations.readOnly }
          : {}),
        ...(typeof tool.annotations.destructive === 'boolean'
          ? { destructive: tool.annotations.destructive }
          : {}),
        ...(typeof tool.annotations.openWorld === 'boolean'
          ? { openWorld: tool.annotations.openWorld }
          : {}),
      }
    : undefined;

  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
    serverName,
    ...(annotations && Object.keys(annotations).length > 0 ? { annotations } : {}),
  };
}
