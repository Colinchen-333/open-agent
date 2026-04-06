import { describe, expect, test } from 'bun:test';
import {
  ElicitationManager,
  type ElicitationAdapter,
  type ElicitationRequest,
  type ElicitationHook,
} from '../elicitation';

function createMockAdapter(action: 'accept' | 'decline' = 'accept'): ElicitationAdapter {
  return {
    present: async (req) => ({ elicitationId: req.elicitationId, action }),
  };
}

function makeRequest(overrides?: Partial<ElicitationRequest>): ElicitationRequest {
  return {
    elicitationId: 'eid-1',
    serverName: 'test-server',
    message: 'Allow access?',
    type: 'form',
    ...overrides,
  };
}

describe('ElicitationManager hooks', () => {
  test('hook can auto-respond before adapter', async () => {
    const manager = new ElicitationManager(createMockAdapter('decline'));
    manager.addHook({
      name: 'auto-accept',
      handle: async (req) => ({ elicitationId: req.elicitationId, action: 'accept' }),
    });
    const result = await manager.handle(makeRequest());
    expect(result.action).toBe('accept'); // hook overrides adapter
  });

  test('falls through to adapter when hook returns null', async () => {
    const manager = new ElicitationManager(createMockAdapter('decline'));
    manager.addHook({
      name: 'pass-through',
      handle: async () => null,
    });
    const result = await manager.handle(makeRequest());
    expect(result.action).toBe('decline'); // adapter response
  });

  test('first matching hook wins', async () => {
    const manager = new ElicitationManager(createMockAdapter());
    manager.addHook({
      name: 'first',
      handle: async (req) => ({ elicitationId: req.elicitationId, action: 'decline' }),
    });
    manager.addHook({
      name: 'second',
      handle: async (req) => ({ elicitationId: req.elicitationId, action: 'accept' }),
    });
    const result = await manager.handle(makeRequest());
    expect(result.action).toBe('decline');
  });

  test('removeHook removes by name', async () => {
    const manager = new ElicitationManager(createMockAdapter('decline'));
    manager.addHook({
      name: 'temp',
      handle: async (req) => ({ elicitationId: req.elicitationId, action: 'accept' }),
    });
    manager.removeHook('temp');
    const result = await manager.handle(makeRequest());
    expect(result.action).toBe('decline'); // hook removed, adapter responds
  });

  test('hook receives the full request object', async () => {
    const manager = new ElicitationManager(createMockAdapter());
    let captured: ElicitationRequest | null = null;
    manager.addHook({
      name: 'capture',
      handle: async (req) => {
        captured = req;
        return null; // pass through
      },
    });
    const req = makeRequest({ message: 'Grant OAuth token?' });
    await manager.handle(req);
    expect(captured).not.toBeNull();
    expect(captured!.message).toBe('Grant OAuth token?');
    expect(captured!.serverName).toBe('test-server');
  });

  test('hook response can include data', async () => {
    const manager = new ElicitationManager(createMockAdapter());
    manager.addHook({
      name: 'with-data',
      handle: async (req) => ({
        elicitationId: req.elicitationId,
        action: 'accept',
        data: { token: 'pre-filled' },
      }),
    });
    const result = await manager.handle(makeRequest());
    expect(result.action).toBe('accept');
    expect(result.data).toEqual({ token: 'pre-filled' });
  });

  test('hook short-circuit clears inFlight', async () => {
    const manager = new ElicitationManager(createMockAdapter());
    manager.addHook({
      name: 'instant',
      handle: async (req) => ({ elicitationId: req.elicitationId, action: 'decline' }),
    });
    await manager.handle(makeRequest());
    expect(manager.getInFlight()).toHaveLength(0);
  });
});

describe('completion notifications', () => {
  test('fires callback on completion', () => {
    const manager = new ElicitationManager(createMockAdapter());
    let result: any = null;
    manager.onCompletion('eid-1', (r) => {
      result = r;
    });
    manager.handleCompletionNotification('eid-1', { success: true });
    expect(result).toEqual({ success: true });
  });

  test('fires error callback', () => {
    const manager = new ElicitationManager(createMockAdapter());
    let result: any = null;
    manager.onCompletion('eid-2', (r) => {
      result = r;
    });
    manager.handleCompletionNotification('eid-2', { success: false, error: 'timeout' });
    expect(result?.error).toBe('timeout');
  });

  test('unknown elicitationId is a no-op', () => {
    const manager = new ElicitationManager(createMockAdapter());
    // Should not throw
    manager.handleCompletionNotification('unknown', { success: true });
  });

  test('callback is removed after firing', () => {
    const manager = new ElicitationManager(createMockAdapter());
    let callCount = 0;
    manager.onCompletion('eid-3', () => {
      callCount++;
    });
    manager.handleCompletionNotification('eid-3', { success: true });
    manager.handleCompletionNotification('eid-3', { success: true });
    expect(callCount).toBe(1); // only fired once
  });
});
