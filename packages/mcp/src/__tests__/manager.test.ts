import { describe, expect, it, mock, spyOn, test } from 'bun:test';
import { McpManager } from '../manager';
import type { ResourceNotificationEvent } from '../manager';
import { McpServerState } from '../server-state';
import { ElicitationManager } from '../elicitation';

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build an McpManager that has a single SDK-type (in-process) server named
 * `serverName` in the 'connected' state. SDK servers have no underlying MCP
 * SDK Client, so subscribeResource skips the RPC round-trip — perfect for
 * unit tests that only need to verify the callback dispatch logic.
 */
async function makeManagerWithSdkServer(serverName = 'test-server'): Promise<McpManager> {
  const manager = new McpManager();
  await manager.addServer(serverName, {
    type: 'sdk',
    name: serverName,
    instance: { tools: [] },
  } as any);
  return manager;
}

/**
 * Cast manager to `any` so we can call private `_dispatchResourceNotification`
 * directly from tests — simulates what the notification handler wiring would do
 * when a real server sends a notification.
 */
function dispatch(manager: McpManager, serverName: string, event: ResourceNotificationEvent): void {
  (manager as any)._dispatchResourceNotification(serverName, event);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('McpManager readResource', () => {
  test('McpManager exposes readResource method', () => {
    const manager = new McpManager();
    expect(typeof manager.readResource).toBe('function');
  });
});

describe('McpManager SDK servers', () => {
  it('保留 SDK 工具 annotations 并允许直接调用 handler', async () => {
    const manager = new McpManager();

    await manager.addServer('demo', {
      type: 'sdk',
      name: 'demo',
      instance: {
        tools: [
          {
            name: 'inspect',
            description: 'Inspect remote state',
            annotations: {
              readOnly: true,
              openWorld: true,
            },
            handler: async (args: Record<string, unknown>) => ({
              echoed: args.value ?? null,
            }),
          },
        ],
      },
    } as any);

    const status = manager.getStatus().find((entry) => entry.name === 'demo');
    expect(status?.status).toBe('connected');
    expect(status?.tools).toEqual([
      {
        name: 'mcp__demo__inspect',
        description: 'Inspect remote state',
        inputSchema: { type: 'object', properties: {} },
        serverName: 'demo',
        mcpInfo: { serverName: 'demo', toolName: 'inspect' },
        annotations: {
          readOnly: true,
          openWorld: true,
        },
      },
    ]);

    expect(manager.getAllTools()).toEqual(status?.tools ?? []);
    expect(await manager.callTool('demo', 'inspect', { value: 'ok' })).toEqual({ echoed: 'ok' });
  });
});

// ── Resource subscription tests ───────────────────────────────────────────────

describe('McpManager resource subscriptions', () => {
  it('subscribeResource exposes the method', () => {
    const manager = new McpManager();
    expect(typeof manager.subscribeResource).toBe('function');
  });

  it('subscribeResource throws when server is not found', async () => {
    const manager = new McpManager();
    await expect(
      manager.subscribeResource('missing', 'file:///foo', () => {}),
    ).rejects.toThrow('MCP server not found or not connected: missing');
  });

  it('registers callback and fires on updated notification', async () => {
    const manager = await makeManagerWithSdkServer('s1');
    const events: ResourceNotificationEvent[] = [];

    await manager.subscribeResource('s1', 'file:///doc.txt', (e) => events.push(e));

    dispatch(manager, 's1', { type: 'updated', uri: 'file:///doc.txt' });

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: 'updated', uri: 'file:///doc.txt' });
  });

  it('does not fire callback for a different URI', async () => {
    const manager = await makeManagerWithSdkServer('s2');
    const events: ResourceNotificationEvent[] = [];

    await manager.subscribeResource('s2', 'file:///a.txt', (e) => events.push(e));

    // Dispatch an update for a different URI
    dispatch(manager, 's2', { type: 'updated', uri: 'file:///b.txt' });

    expect(events).toHaveLength(0);
  });

  it('list_changed notification fires all subscribers on the server', async () => {
    const manager = await makeManagerWithSdkServer('s3');
    const eventsA: ResourceNotificationEvent[] = [];
    const eventsB: ResourceNotificationEvent[] = [];

    await manager.subscribeResource('s3', 'file:///a.txt', (e) => eventsA.push(e));
    await manager.subscribeResource('s3', 'file:///b.txt', (e) => eventsB.push(e));

    dispatch(manager, 's3', { type: 'list_changed' });

    expect(eventsA).toHaveLength(1);
    expect(eventsA[0]).toEqual({ type: 'list_changed' });
    expect(eventsB).toHaveLength(1);
    expect(eventsB[0]).toEqual({ type: 'list_changed' });
  });

  it('list_changed does not fire subscribers on a different server', async () => {
    const manager = new McpManager();
    await manager.addServer('alpha', { type: 'sdk', name: 'alpha', instance: { tools: [] } } as any);
    await manager.addServer('beta', { type: 'sdk', name: 'beta', instance: { tools: [] } } as any);

    const events: ResourceNotificationEvent[] = [];
    await manager.subscribeResource('alpha', 'file:///x.txt', (e) => events.push(e));

    // Dispatch list_changed for a different server
    dispatch(manager, 'beta', { type: 'list_changed' });

    expect(events).toHaveLength(0);
  });

  it('unsubscribe function removes the subscription', async () => {
    const manager = await makeManagerWithSdkServer('s4');
    const events: ResourceNotificationEvent[] = [];

    const unsubscribe = await manager.subscribeResource('s4', 'file:///watched.txt', (e) => events.push(e));

    // Fire before unsubscribing — should be received
    dispatch(manager, 's4', { type: 'updated', uri: 'file:///watched.txt' });
    expect(events).toHaveLength(1);

    // Unsubscribe and fire again — should NOT be received
    await unsubscribe();
    dispatch(manager, 's4', { type: 'updated', uri: 'file:///watched.txt' });
    expect(events).toHaveLength(1); // still 1, not 2
  });

  it('callback that throws does not crash dispatch', async () => {
    const manager = await makeManagerWithSdkServer('s5');
    const goodEvents: ResourceNotificationEvent[] = [];

    await manager.subscribeResource('s5', 'file:///bad.txt', () => {
      throw new Error('handler exploded');
    });
    await manager.subscribeResource('s5', 'file:///good.txt', (e) => goodEvents.push(e));

    // Both subscriptions are on the same server, dispatch list_changed hits both
    dispatch(manager, 's5', { type: 'list_changed' });

    // The good handler should still have fired despite the first one throwing
    expect(goodEvents).toHaveLength(1);
  });
});

// ── Per-server disable / enable / policy tests ────────────────────────────────

/** Shared SDK server config for disable/enable tests. */
const sdkConfig = (name: string) =>
  ({ type: 'sdk', name, instance: { tools: [] } } as any);

describe('McpManager per-server disable/enable', () => {
  it('disableServer then addServer records status=disabled, no client created', async () => {
    const manager = new McpManager();
    manager.disableServer('foo');

    const conn = await manager.addServer('foo', sdkConfig('foo'));

    expect(conn.status).toBe('disabled');
    expect(conn.enabled).toBe(false);
    // No tools loaded for a disabled server
    expect(conn.tools).toHaveLength(0);
    // getStatus should reflect the disabled record
    const found = manager.getStatus().find((s) => s.name === 'foo');
    expect(found?.status).toBe('disabled');
    // isServerDisabled should agree
    expect(manager.isServerDisabled('foo')).toBe(true);
  });

  it('enableServer then addServer connects normally', async () => {
    const manager = new McpManager();
    manager.disableServer('bar');
    manager.enableServer('bar');

    const conn = await manager.addServer('bar', sdkConfig('bar'));

    expect(conn.status).toBe('connected');
    expect(conn.enabled).toBe(true);
    expect(manager.isServerDisabled('bar')).toBe(false);
  });

  it('setServers respects disabled state: disabled server stays disabled', async () => {
    const manager = new McpManager();
    manager.disableServer('baz');

    await manager.setServers({ baz: sdkConfig('baz') });

    const conn = manager.getStatus().find((s) => s.name === 'baz');
    expect(conn?.status).toBe('disabled');
  });

  it('getServerState returns the underlying McpServerState', () => {
    const manager = new McpManager();
    const state = manager.getServerState();
    expect(state).toBeInstanceOf(McpServerState);
  });
});

// ── Elicitation integration smoke tests ──────────────────────────────────────

describe('McpManager elicitation', () => {
  it('exposes setElicitationAdapter and getElicitationManager', () => {
    const manager = new McpManager();
    expect(typeof manager.setElicitationAdapter).toBe('function');
    expect(typeof manager.getElicitationManager).toBe('function');
  });

  it('getElicitationManager returns an ElicitationManager instance', () => {
    const manager = new McpManager();
    expect(manager.getElicitationManager()).toBeInstanceOf(ElicitationManager);
  });

  it('setElicitationAdapter replaces the adapter used by the manager', async () => {
    const manager = new McpManager();
    const custom = {
      present: async (req: any) => ({
        elicitationId: req.elicitationId,
        action: 'accept' as const,
        data: { injected: true },
      }),
    };
    manager.setElicitationAdapter(custom);
    const elicMgr = manager.getElicitationManager();
    const res = await elicMgr.handle({
      elicitationId: 'smoke-1',
      serverName: 'test',
      message: 'hello',
      type: 'form',
    });
    expect(res.action).toBe('accept');
    expect(res.data).toEqual({ injected: true });
  });

  it('onServerElicitation routes through the ElicitationManager', async () => {
    const manager = new McpManager();
    // Default adapter auto-declines
    const res = await manager.onServerElicitation('my-server', {
      elicitationId: 'smoke-2',
      message: 'need input',
      type: 'form',
    });
    expect(res.action).toBe('decline');
    expect(res.elicitationId).toBe('smoke-2');
  });
});

describe('McpManager policy-blocked servers', () => {
  it('constructor policyBlockedServers prevents server from starting', async () => {
    const manager = new McpManager({ policyBlockedServers: ['bar'] });

    const conn = await manager.addServer('bar', sdkConfig('bar'));

    expect(conn.status).toBe('disabled');
    expect(conn.error).toMatch(/policy/i);
    expect(manager.isServerDisabled('bar')).toBe(true);
    expect(manager.getServerState().disabledReason('bar')).toBe('policy');
  });

  it('policy block cannot be lifted by enableServer', async () => {
    const manager = new McpManager({ policyBlockedServers: ['locked'] });
    // User attempt to enable
    manager.enableServer('locked');

    const conn = await manager.addServer('locked', sdkConfig('locked'));

    expect(conn.status).toBe('disabled');
    expect(manager.isServerDisabled('locked')).toBe(true);
  });

  it('non-blocked servers still connect normally when some are policy-blocked', async () => {
    const manager = new McpManager({ policyBlockedServers: ['blocked'] });

    const connBlocked = await manager.addServer('blocked', sdkConfig('blocked'));
    const connFree = await manager.addServer('free', sdkConfig('free'));

    expect(connBlocked.status).toBe('disabled');
    expect(connFree.status).toBe('connected');
  });
});
