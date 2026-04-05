import { describe, expect, test, mock } from 'bun:test';
import { ElicitationManager, AUTO_DECLINE_ADAPTER, type ElicitationRequest } from '../elicitation';

describe('ElicitationManager', () => {
  test('default adapter auto-declines with clear reason', async () => {
    const mgr = new ElicitationManager();
    const req: ElicitationRequest = {
      elicitationId: 'x1',
      serverName: 'srv',
      message: 'Enter API key',
      type: 'form',
      schema: { fields: [{ name: 'key', label: 'API Key', type: 'password' }] },
    };
    const res = await mgr.handle(req);
    expect(res.action).toBe('decline');
    expect(res.reason).toContain('No UI adapter');
    expect(res.elicitationId).toBe('x1');
  });

  test('custom adapter receives request and returns response', async () => {
    const adapter = {
      present: mock(async (req: ElicitationRequest) => ({
        elicitationId: req.elicitationId,
        action: 'accept' as const,
        data: { key: 'sk-test-123' },
      })),
    };
    const mgr = new ElicitationManager(adapter);
    const res = await mgr.handle({
      elicitationId: 'x2',
      serverName: 'srv',
      message: 'Enter API key',
      type: 'form',
    });
    expect(res.action).toBe('accept');
    expect(res.data).toEqual({ key: 'sk-test-123' });
    expect(adapter.present).toHaveBeenCalledTimes(1);
  });

  test('timeout cancels request', async () => {
    const slowAdapter = {
      present: () => new Promise<any>(() => {}), // never resolves
    };
    const mgr = new ElicitationManager(slowAdapter as any);
    const res = await mgr.handle({
      elicitationId: 'x3',
      serverName: 'srv',
      message: 'test',
      type: 'form',
      timeoutMs: 50,
    });
    expect(res.action).toBe('cancel');
    expect(res.reason).toContain('Timed out');
  });

  test('getInFlight returns pending requests', async () => {
    let resolve: ((v: any) => void) | null = null;
    const adapter = {
      present: (req: ElicitationRequest) => new Promise<any>((r) => { resolve = r; }),
    };
    const mgr = new ElicitationManager(adapter as any);
    const handlePromise = mgr.handle({ elicitationId: 'x4', serverName: 's', message: 'm', type: 'form' });
    // Briefly yield to let handle() start
    await new Promise((r) => setTimeout(r, 10));
    expect(mgr.getInFlight()).toHaveLength(1);
    expect(mgr.getInFlight()[0]!.elicitationId).toBe('x4');
    resolve!({ elicitationId: 'x4', action: 'decline' });
    await handlePromise;
    expect(mgr.getInFlight()).toHaveLength(0);
  });

  test('setAdapter replaces the adapter', async () => {
    const mgr = new ElicitationManager();
    const custom = {
      present: async (r: ElicitationRequest) => ({ elicitationId: r.elicitationId, action: 'accept' as const }),
    };
    mgr.setAdapter(custom);
    const res = await mgr.handle({ elicitationId: 'x5', serverName: 's', message: 'm', type: 'form' });
    expect(res.action).toBe('accept');
  });

  test('cancel() forces cancellation of a known id', async () => {
    const mgr = new ElicitationManager();
    // Simulate in-flight
    (mgr as any).inFlight.set('x6', { elicitationId: 'x6', serverName: 's', message: 'm', type: 'form' });
    const res = mgr.cancel('x6', 'user aborted');
    expect(res.action).toBe('cancel');
    expect(res.reason).toContain('user aborted');
    expect(mgr.getInFlight()).toHaveLength(0);
  });
});
