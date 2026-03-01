import type { PermissionPrompter } from '@open-agent/core';

export type PermissionPromptDecision = 'allow' | 'deny' | 'always';

type McpToolDescriptor = {
  serverName: string;
  name: string;
};

export type PermissionPromptMcpClient = {
  getAllTools(): McpToolDescriptor[];
  callTool(serverName: string, toolName: string, args: Record<string, unknown>): Promise<unknown>;
};

export type PermissionPromptToolRef = {
  serverName: string;
  toolName: string;
};

const DECISION_VALUES = new Set<PermissionPromptDecision>(['allow', 'deny', 'always']);

function normalizeDecisionString(value: string): PermissionPromptDecision | undefined {
  const normalized = value.trim().toLowerCase();
  if (DECISION_VALUES.has(normalized as PermissionPromptDecision)) {
    return normalized as PermissionPromptDecision;
  }
  return undefined;
}

export function normalizePermissionPromptDecision(value: unknown): PermissionPromptDecision | undefined {
  if (typeof value === 'string') {
    return normalizeDecisionString(value);
  }
  if (typeof value === 'boolean') {
    return value ? 'allow' : 'deny';
  }
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const obj = value as Record<string, unknown>;
  const fromDecision = normalizePermissionPromptDecision(obj.decision);
  if (fromDecision) return fromDecision;
  const fromBehavior = normalizePermissionPromptDecision(obj.behavior);
  if (fromBehavior) return fromBehavior;
  const fromAction = normalizePermissionPromptDecision(obj.action);
  if (fromAction) return fromAction;

  return undefined;
}

export function parsePermissionPromptToolReference(toolName: string): PermissionPromptToolRef | undefined {
  if (!toolName.startsWith('mcp__')) {
    return undefined;
  }

  const rest = toolName.slice('mcp__'.length);
  const separatorIndex = rest.indexOf('__');
  if (separatorIndex <= 0 || separatorIndex >= rest.length - 2) {
    return undefined;
  }

  const serverName = rest.slice(0, separatorIndex).trim();
  const parsedToolName = rest.slice(separatorIndex + 2).trim();
  if (!serverName || !parsedToolName) {
    return undefined;
  }

  return { serverName, toolName: parsedToolName };
}

export function resolvePermissionPromptTool(
  configuredName: string,
  mcpClient?: PermissionPromptMcpClient,
): PermissionPromptToolRef | undefined {
  if (configuredName.startsWith('mcp__')) {
    const rest = configuredName.slice('mcp__'.length);
    // Try every possible split of "<server>__<tool>" and choose the unique
    // split that matches an actually connected MCP tool. This supports server
    // and tool names that may themselves contain "__".
    if (mcpClient) {
      let tools: McpToolDescriptor[] = [];
      try {
        tools = mcpClient.getAllTools();
      } catch {
        tools = [];
      }
      const matches: PermissionPromptToolRef[] = [];
      let start = 0;
      while (start < rest.length) {
        const separatorIndex = rest.indexOf('__', start);
        if (separatorIndex < 0) break;
        const serverName = rest.slice(0, separatorIndex).trim();
        const toolName = rest.slice(separatorIndex + 2).trim();
        if (serverName && toolName) {
          if (tools.some((tool) => tool.serverName === serverName && tool.name === toolName)) {
            matches.push({ serverName, toolName });
          }
        }
        start = separatorIndex + 2;
      }
      if (matches.length === 1) {
        return matches[0];
      }
      if (matches.length > 1) {
        return undefined;
      }
    }

    const explicitRef = parsePermissionPromptToolReference(configuredName);
    if (explicitRef) {
      return explicitRef;
    }
    return undefined;
  }

  if (!mcpClient) {
    return undefined;
  }

  let tools: McpToolDescriptor[];
  try {
    tools = mcpClient.getAllTools();
  } catch {
    return undefined;
  }

  const matches = tools.filter((tool) => tool.name === configuredName);
  if (matches.length !== 1) {
    return undefined;
  }

  return {
    serverName: matches[0].serverName,
    toolName: matches[0].name,
  };
}

export function createPermissionPrompterBridge(params: {
  permissionPromptToolName?: string;
  permissionPrompter?: PermissionPrompter['prompt'];
  getMcpClient?: () => PermissionPromptMcpClient | undefined;
  waitForMcpReady?: () => Promise<void> | undefined;
}): PermissionPrompter | undefined {
  const { permissionPromptToolName, permissionPrompter, getMcpClient, waitForMcpReady } = params;
  if (!permissionPromptToolName) {
    return permissionPrompter ? { prompt: permissionPrompter } : undefined;
  }

  return {
    prompt: async (request) => {
      const readyPromise = waitForMcpReady?.();
      if (readyPromise) {
        try {
          await readyPromise;
        } catch {
          // Continue to fallback logic below.
        }
      }
      const mcpClient = getMcpClient?.();
      const resolvedTool = resolvePermissionPromptTool(permissionPromptToolName, mcpClient);
      if (mcpClient && resolvedTool) {
        try {
          const rawDecision = await mcpClient.callTool(
            resolvedTool.serverName,
            resolvedTool.toolName,
            {
              toolName: request.toolName,
              input: request.input,
              reason: request.reason,
            },
          );
          const mcpDecision = normalizePermissionPromptDecision(rawDecision);
          if (mcpDecision) {
            return mcpDecision;
          }
        } catch {
          // fall through to fallback prompter / deny
        }
      }

      if (permissionPrompter) {
        try {
          const fallbackDecision = await permissionPrompter(request);
          const normalizedFallback = normalizePermissionPromptDecision(fallbackDecision);
          if (normalizedFallback) {
            return normalizedFallback;
          }
        } catch {
          // fall through to deny
        }
      }

      return 'deny';
    },
  };
}
