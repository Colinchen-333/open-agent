import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { setFeatureDefault, clearFeatureOverrides } from '@open-agent/core';
import { createSleepTool } from '../sleep-tool';
import { createSnipTool } from '../snip-tool';
import {
  createCronCreateTool,
  createCronListTool,
  createCronDeleteTool,
  _resetCronStore,
} from '../cron-tools';
import { createLSPTool } from '../lsp-tool';

const baseCtx = { cwd: '/tmp', sessionId: 'extra-tools-test', toolUseId: 'x1' } as any;

// ---------------------------------------------------------------------------
// SleepTool
// ---------------------------------------------------------------------------

describe('SleepTool', () => {
  test('returns slept seconds in result', async () => {
    const tool = createSleepTool();
    const result = await tool.execute({ seconds: 0 }, baseCtx);
    expect(result.slept).toBe(0);
    expect(result.message).toContain('0');
  });

  test('clamps negative seconds to 0', async () => {
    const tool = createSleepTool();
    const result = await tool.execute({ seconds: -5 }, baseCtx);
    expect(result.slept).toBe(0);
  });

  test('clamps seconds exceeding max (300) to 300', async () => {
    const tool = createSleepTool();
    // Inject an abort signal that fires immediately so the sleep resolves
    // without waiting 300 real seconds.  The clamp result is what we assert.
    let resolve!: () => void;
    const originalSetTimeout = globalThis.setTimeout;
    // Patch setTimeout for this call only: fire immediately so the sleep
    // returns right away while still exercising the clamping path.
    const patchedSetTimeout = (fn: () => void, _ms?: number) => originalSetTimeout(fn, 0);
    (globalThis as any).setTimeout = patchedSetTimeout;
    try {
      const result = await tool.execute({ seconds: 999 }, baseCtx);
      expect(result.slept).toBe(300);
    } finally {
      (globalThis as any).setTimeout = originalSetTimeout;
    }
  });

  test('result message is singular for 1 second', async () => {
    const tool = createSleepTool();
    const result = await tool.execute({ seconds: 1 }, baseCtx);
    expect(result.slept).toBe(1);
    expect(result.message).toBe('Paused for 1 second.');
  });

  test('result message is plural for 2 seconds', async () => {
    const tool = createSleepTool();
    const result = await tool.execute({ seconds: 2 }, baseCtx);
    expect(result.message).toBe('Paused for 2 seconds.');
  });

  test('tool has shouldDefer:true', () => {
    const tool = createSleepTool();
    expect(tool.shouldDefer).toBe(true);
  });

  test('timeout is above the max sleep cap in ms', () => {
    const tool = createSleepTool();
    // 300 s max + 5 s buffer = 305 000 ms
    expect(tool.timeout).toBeGreaterThan(300_000);
  });
});

// ---------------------------------------------------------------------------
// SnipTool
// ---------------------------------------------------------------------------

describe('SnipTool', () => {
  test('returns snipCount equal to input count', async () => {
    const tool = createSnipTool();
    const result = await tool.execute({ count: 5 }, baseCtx);
    expect(result.snipCount).toBe(5);
  });

  test('defaults count to 10 when not provided', async () => {
    const tool = createSnipTool();
    const result = await tool.execute({}, baseCtx);
    expect(result.snipCount).toBe(10);
  });

  test('clamps count to minimum of 1', async () => {
    const tool = createSnipTool();
    const result = await tool.execute({ count: 0 }, baseCtx);
    expect(result.snipCount).toBe(1);
  });

  test('returns _action: snip as the signal for ConversationLoop', async () => {
    const tool = createSnipTool();
    const result = await tool.execute({ count: 3 }, baseCtx);
    expect(result._action).toBe('snip');
  });

  test('message mentions the count', async () => {
    const tool = createSnipTool();
    const result = await tool.execute({ count: 7 }, baseCtx);
    expect(result.message).toContain('7');
  });

  test('message is singular for count 1', async () => {
    const tool = createSnipTool();
    const result = await tool.execute({ count: 1 }, baseCtx);
    expect(result.message).toContain('1 oldest message');
    expect(result.message).not.toContain('messages');
  });

  test('floors fractional count', async () => {
    const tool = createSnipTool();
    const result = await tool.execute({ count: 4.9 }, baseCtx);
    expect(result.snipCount).toBe(4);
  });

  test('tool has shouldDefer:true', () => {
    const tool = createSnipTool();
    expect(tool.shouldDefer).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Cron tools — CRUD lifecycle
// ---------------------------------------------------------------------------

describe('CronCreate / CronList / CronDelete', () => {
  beforeEach(() => _resetCronStore());

  // ---- CronCreate ----

  test('creates a job and returns an id', async () => {
    const create = createCronCreateTool();
    const result = await create.execute({ cron: '*/5 * * * *', prompt: 'hello' }, baseCtx);
    expect(result.id).toMatch(/^cron-\d+$/);
    expect(result.cron).toBe('*/5 * * * *');
    expect(result.prompt).toBe('hello');
    expect(result.recurring).toBe(true);
    expect(result.createdAt).toBeGreaterThan(0);
    expect(result.message).toContain(result.id);
  });

  test('recurring defaults to true when not provided', async () => {
    const create = createCronCreateTool();
    const result = await create.execute({ cron: '0 * * * *', prompt: 'ping' }, baseCtx);
    expect(result.recurring).toBe(true);
  });

  test('recurring can be set to false for one-shot jobs', async () => {
    const create = createCronCreateTool();
    const result = await create.execute(
      { cron: '0 0 * * *', prompt: 'once', recurring: false },
      baseCtx,
    );
    expect(result.recurring).toBe(false);
  });

  test('each job gets a unique id', async () => {
    const create = createCronCreateTool();
    const r1 = await create.execute({ cron: '* * * * *', prompt: 'a' }, baseCtx);
    const r2 = await create.execute({ cron: '* * * * *', prompt: 'b' }, baseCtx);
    expect(r1.id).not.toBe(r2.id);
  });

  // ---- CronList ----

  test('lists zero jobs when store is empty', async () => {
    const list = createCronListTool();
    const result = await list.execute(undefined, baseCtx);
    expect(result.count).toBe(0);
    expect(result.jobs).toEqual([]);
  });

  test('lists created jobs', async () => {
    const create = createCronCreateTool();
    const list = createCronListTool();
    await create.execute({ cron: '*/1 * * * *', prompt: 'tick' }, baseCtx);
    await create.execute({ cron: '0 0 * * *', prompt: 'midnight' }, baseCtx);
    const result = await list.execute(undefined, baseCtx);
    expect(result.count).toBe(2);
    expect(result.jobs).toHaveLength(2);
  });

  // ---- CronDelete ----

  test('deletes an existing job', async () => {
    const create = createCronCreateTool();
    const del = createCronDeleteTool();
    const created = await create.execute({ cron: '*/10 * * * *', prompt: 'check' }, baseCtx);
    const deleted = await del.execute({ id: created.id }, baseCtx);
    expect(deleted.deleted).toBe(true);
    expect(deleted.id).toBe(created.id);
    expect(deleted.message).toContain('cancelled');
  });

  test('delete reports not-found for missing id', async () => {
    const del = createCronDeleteTool();
    const result = await del.execute({ id: 'cron-999' }, baseCtx);
    expect(result.deleted).toBe(false);
    expect(result.message).toContain('not found');
  });

  test('deleted job no longer appears in list', async () => {
    const create = createCronCreateTool();
    const del = createCronDeleteTool();
    const list = createCronListTool();
    const created = await create.execute({ cron: '* * * * *', prompt: 'tmp' }, baseCtx);
    await del.execute({ id: created.id }, baseCtx);
    const result = await list.execute(undefined, baseCtx);
    expect(result.count).toBe(0);
    expect(result.jobs.find((j: any) => j.id === created.id)).toBeUndefined();
  });

  test('full lifecycle: create → list → delete → list', async () => {
    const create = createCronCreateTool();
    const list = createCronListTool();
    const del = createCronDeleteTool();

    const j1 = await create.execute({ cron: '0 * * * *', prompt: 'hourly' }, baseCtx);
    const j2 = await create.execute({ cron: '0 0 * * *', prompt: 'daily' }, baseCtx);

    const afterCreate = await list.execute(undefined, baseCtx);
    expect(afterCreate.count).toBe(2);

    await del.execute({ id: j1.id }, baseCtx);

    const afterDelete = await list.execute(undefined, baseCtx);
    expect(afterDelete.count).toBe(1);
    expect(afterDelete.jobs[0].id).toBe(j2.id);
  });
});

// ---------------------------------------------------------------------------
// LSPTool
// ---------------------------------------------------------------------------

describe('LSPTool', () => {
  afterEach(() => clearFeatureOverrides());

  test('returns error when feature flag is OFF (default)', async () => {
    // Feature flag defaults to false; no override needed
    const tool = createLSPTool();
    const result = await tool.execute({ action: 'definition', file: 'src/foo.ts' }, baseCtx);
    expect(result.error).toBeDefined();
    expect(result.error).toContain('OPEN_AGENT_FEATURE_ENABLE_LSP_TOOL');
  });

  test('returns stub result when feature flag is ON', async () => {
    setFeatureDefault('ENABLE_LSP_TOOL', true);
    const tool = createLSPTool();
    const result = await tool.execute(
      { action: 'definition', file: 'src/foo.ts', line: 10, character: 5 },
      baseCtx,
    );
    expect(result.error).toBeUndefined();
    expect(result.action).toBe('definition');
    expect(result.file).toBe('src/foo.ts');
    expect(result.line).toBe(10);
    expect(result.character).toBe(5);
    expect(result.result).toBeNull();
    expect(result.message).toContain('definition');
  });

  test('line and character are null when not provided', async () => {
    setFeatureDefault('ENABLE_LSP_TOOL', true);
    const tool = createLSPTool();
    const result = await tool.execute({ action: 'diagnostics', file: 'src/bar.ts' }, baseCtx);
    expect(result.line).toBeNull();
    expect(result.character).toBeNull();
  });

  test('stub message includes the action and file name', async () => {
    setFeatureDefault('ENABLE_LSP_TOOL', true);
    const tool = createLSPTool();
    const result = await tool.execute(
      { action: 'hover', file: 'src/baz.ts', line: 42, character: 0 },
      baseCtx,
    );
    expect(result.message).toContain('hover');
    expect(result.message).toContain('src/baz.ts');
    expect(result.message).toContain('42');
  });

  test('all five actions are accepted', async () => {
    setFeatureDefault('ENABLE_LSP_TOOL', true);
    const tool = createLSPTool();
    const actions = ['definition', 'references', 'completion', 'diagnostics', 'hover'] as const;
    for (const action of actions) {
      const result = await tool.execute({ action, file: 'x.ts' }, baseCtx);
      expect(result.action).toBe(action);
    }
  });

  test('tool has shouldDefer:true', () => {
    const tool = createLSPTool();
    expect(tool.shouldDefer).toBe(true);
  });

  test('tool has readOnly annotation', () => {
    const tool = createLSPTool();
    expect(tool.annotations?.readOnly).toBe(true);
  });
});
