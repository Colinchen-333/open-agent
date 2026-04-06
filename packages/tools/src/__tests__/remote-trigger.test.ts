import { describe, expect, test } from 'bun:test';
import { createRemoteTriggerTool } from '../remote-trigger';

function makeTool(overrides?: Partial<{ baseUrl: string; authHeader: string | null }>) {
  return createRemoteTriggerTool({
    baseUrl: overrides?.baseUrl ?? 'https://api.test.com/v1/triggers',
    getAuthHeader: async () =>
      overrides && 'authHeader' in overrides
        ? (overrides.authHeader as string | null)
        : 'Bearer test-token',
  });
}

describe('RemoteTriggerTool', () => {
  test('has correct name and shouldDefer', () => {
    const tool = makeTool();
    expect(tool.name).toBe('RemoteTrigger');
    expect(tool.shouldDefer).toBe(true);
  });

  test('returns 401 when no auth', async () => {
    const tool = makeTool({ authHeader: null });
    const result = await tool.execute(
      { action: 'list' },
      { abortSignal: new AbortController().signal } as any,
    );
    expect(result.status).toBe(401);
  });

  test('list action requires no trigger_id', async () => {
    // This will fail the fetch (no real server), but shouldn't return 400
    const tool = makeTool();
    const result = await tool.execute(
      { action: 'list' },
      { abortSignal: new AbortController().signal } as any,
    );
    // Network error (no real server) but not a validation error
    expect(result.status === 0 || result.status === 401).toBe(true); // 0 = fetch error
  });

  test('get requires trigger_id', async () => {
    const tool = makeTool();
    const result = await tool.execute(
      { action: 'get' },
      { abortSignal: new AbortController().signal } as any,
    );
    expect(result.status).toBe(400);
    expect(result.json).toContain('trigger_id');
  });

  test('create requires body', async () => {
    const tool = makeTool();
    const result = await tool.execute(
      { action: 'create' },
      { abortSignal: new AbortController().signal } as any,
    );
    expect(result.status).toBe(400);
    expect(result.json).toContain('body');
  });

  test('update requires trigger_id and body', async () => {
    const tool = makeTool();
    const r1 = await tool.execute(
      { action: 'update' },
      { abortSignal: new AbortController().signal } as any,
    );
    expect(r1.status).toBe(400);
    const r2 = await tool.execute(
      { action: 'update', trigger_id: 'x' },
      { abortSignal: new AbortController().signal } as any,
    );
    expect(r2.status).toBe(400);
  });

  test('run requires trigger_id', async () => {
    const tool = makeTool();
    const result = await tool.execute(
      { action: 'run' },
      { abortSignal: new AbortController().signal } as any,
    );
    expect(result.status).toBe(400);
  });

  test('unknown action returns 400', async () => {
    const tool = makeTool();
    const result = await tool.execute(
      { action: 'delete' },
      { abortSignal: new AbortController().signal } as any,
    );
    expect(result.status).toBe(400);
    expect(result.json).toContain('Unknown action');
  });

  test('has remote capability category', () => {
    const tool = makeTool();
    expect(tool.capability?.category).toBe('remote');
  });
});
