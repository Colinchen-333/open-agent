import { describe, it, expect } from 'bun:test';
import {
  createPermissionPrompterBridge,
  normalizePermissionPromptDecision,
  parsePermissionPromptToolReference,
  resolvePermissionPromptTool,
  type PermissionPromptMcpClient,
} from '../permission-prompter.js';

function makeMcpClient(
  tools: Array<{ serverName: string; name: string }>,
  callTool: PermissionPromptMcpClient['callTool'],
): PermissionPromptMcpClient {
  return {
    getAllTools: () => tools,
    callTool,
  };
}

describe('permission-prompter normalizePermissionPromptDecision()', () => {
  it('normalizes allow/deny/always strings', () => {
    expect(normalizePermissionPromptDecision('allow')).toBe('allow');
    expect(normalizePermissionPromptDecision(' DENY ')).toBe('deny');
    expect(normalizePermissionPromptDecision('Always')).toBe('always');
  });

  it('normalizes object fields decision/behavior/action', () => {
    expect(normalizePermissionPromptDecision({ decision: 'allow' })).toBe('allow');
    expect(normalizePermissionPromptDecision({ behavior: 'deny' })).toBe('deny');
    expect(normalizePermissionPromptDecision({ action: 'always' })).toBe('always');
  });

  it('normalizes booleans', () => {
    expect(normalizePermissionPromptDecision(true)).toBe('allow');
    expect(normalizePermissionPromptDecision(false)).toBe('deny');
  });

  it('returns undefined for unsupported values', () => {
    expect(normalizePermissionPromptDecision('maybe')).toBeUndefined();
    expect(normalizePermissionPromptDecision({})).toBeUndefined();
    expect(normalizePermissionPromptDecision(123)).toBeUndefined();
  });
});

describe('permission-prompter tool resolution', () => {
  it('parses mcp__server__tool references', () => {
    expect(parsePermissionPromptToolReference('mcp__approval__ask')).toEqual({
      serverName: 'approval',
      toolName: 'ask',
    });
    expect(parsePermissionPromptToolReference('mcp__approval__ask__v2')).toEqual({
      serverName: 'approval',
      toolName: 'ask__v2',
    });
  });

  it('resolves mcp__ references with "__" in server name when unique tool exists', () => {
    const mcp = makeMcpClient(
      [{ serverName: 'approval__v2', name: 'ask_permission' }],
      async () => 'allow',
    );
    expect(resolvePermissionPromptTool('mcp__approval__v2__ask_permission', mcp)).toEqual({
      serverName: 'approval__v2',
      toolName: 'ask_permission',
    });
  });

  it('returns undefined for non-mcp format', () => {
    expect(parsePermissionPromptToolReference('ask_permission')).toBeUndefined();
    expect(parsePermissionPromptToolReference('mcp__invalid')).toBeUndefined();
  });

  it('resolves plain tool name against connected MCP tools', () => {
    const mcp = makeMcpClient(
      [{ serverName: 'approval', name: 'ask_permission' }],
      async () => 'allow',
    );

    expect(resolvePermissionPromptTool('ask_permission', mcp)).toEqual({
      serverName: 'approval',
      toolName: 'ask_permission',
    });
  });

  it('rejects ambiguous plain tool names across servers', () => {
    const mcp = makeMcpClient(
      [
        { serverName: 'approval-a', name: 'ask_permission' },
        { serverName: 'approval-b', name: 'ask_permission' },
      ],
      async () => 'allow',
    );

    expect(resolvePermissionPromptTool('ask_permission', mcp)).toBeUndefined();
  });
});

describe('createPermissionPrompterBridge()', () => {
  const request = {
    toolName: 'Write',
    input: { file_path: '/tmp/a.txt', content: 'x' },
    reason: 'requires approval in default mode',
  };

  it('returns undefined when no permission prompter config is provided', () => {
    const prompter = createPermissionPrompterBridge({});
    expect(prompter).toBeUndefined();
  });

  it('keeps fallback prompter behavior when permissionPromptToolName is absent', async () => {
    const prompter = createPermissionPrompterBridge({
      permissionPrompter: async () => 'always',
    });

    expect(prompter).toBeDefined();
    await expect(prompter!.prompt(request)).resolves.toBe('always');
  });

  it('creates a non-empty prompter when permissionPromptToolName is present (regression)', async () => {
    const prompter = createPermissionPrompterBridge({
      permissionPromptToolName: 'mcp__approval__ask_permission',
    });

    expect(prompter).toBeDefined();
    await expect(prompter!.prompt(request)).resolves.toBe('deny');
  });

  it('prioritizes MCP tool over fallback prompter when MCP returns valid decision', async () => {
    let fallbackCalled = false;
    const mcp = makeMcpClient(
      [{ serverName: 'approval', name: 'ask_permission' }],
      async () => ({ decision: 'allow' }),
    );
    const prompter = createPermissionPrompterBridge({
      permissionPromptToolName: 'ask_permission',
      permissionPrompter: async () => {
        fallbackCalled = true;
        return 'deny';
      },
      getMcpClient: () => mcp,
    });

    await expect(prompter!.prompt(request)).resolves.toBe('allow');
    expect(fallbackCalled).toBe(false);
  });

  it('falls back when MCP call fails', async () => {
    const mcp = makeMcpClient(
      [{ serverName: 'approval', name: 'ask_permission' }],
      async () => {
        throw new Error('mcp failed');
      },
    );
    const prompter = createPermissionPrompterBridge({
      permissionPromptToolName: 'ask_permission',
      permissionPrompter: (async () => ({ behavior: 'always' })) as any,
      getMcpClient: () => mcp,
    });

    await expect(prompter!.prompt(request)).resolves.toBe('always');
  });

  it('falls back when MCP returns invalid response', async () => {
    const mcp = makeMcpClient(
      [{ serverName: 'approval', name: 'ask_permission' }],
      async () => ({ foo: 'bar' }),
    );
    const prompter = createPermissionPrompterBridge({
      permissionPromptToolName: 'ask_permission',
      permissionPrompter: (async () => true) as any,
      getMcpClient: () => mcp,
    });

    await expect(prompter!.prompt(request)).resolves.toBe('allow');
  });

  it('falls back when plain tool name is ambiguous across servers', async () => {
    const mcp = makeMcpClient(
      [
        { serverName: 'approval-a', name: 'ask_permission' },
        { serverName: 'approval-b', name: 'ask_permission' },
      ],
      async () => 'allow',
    );
    const prompter = createPermissionPrompterBridge({
      permissionPromptToolName: 'ask_permission',
      permissionPrompter: async () => 'always',
      getMcpClient: () => mcp,
    });

    await expect(prompter!.prompt(request)).resolves.toBe('always');
  });

  it('denies when MCP cannot be used and no fallback prompter is available', async () => {
    const mcp = makeMcpClient(
      [{ serverName: 'approval', name: 'ask_permission' }],
      async () => ({ not: 'valid' }),
    );
    const prompter = createPermissionPrompterBridge({
      permissionPromptToolName: 'ask_permission',
      getMcpClient: () => mcp,
    });

    await expect(prompter!.prompt(request)).resolves.toBe('deny');
  });

  it('waits for in-flight MCP setup before resolving the permission tool', async () => {
    const order: string[] = [];
    const mcp = makeMcpClient(
      [{ serverName: 'approval', name: 'ask_permission' }],
      async () => {
        order.push('callTool');
        return 'allow';
      },
    );
    let resolveReady: (() => void) | null = null;
    const readyPromise = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });

    const prompter = createPermissionPrompterBridge({
      permissionPromptToolName: 'ask_permission',
      getMcpClient: () => mcp,
      waitForMcpReady: () => {
        order.push('wait');
        return readyPromise;
      },
    });

    const pending = prompter!.prompt(request);
    order.push('after-prompt-call');
    resolveReady!();
    await expect(pending).resolves.toBe('allow');
    expect(order).toEqual(['wait', 'after-prompt-call', 'callTool']);
  });
});
