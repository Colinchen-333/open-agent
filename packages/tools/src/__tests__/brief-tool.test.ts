import { describe, expect, test } from 'bun:test';
import { createBriefTool } from '../brief-tool';

describe('BriefTool', () => {
  const baseCtx = { cwd: '/tmp', sessionId: 'brief-test', toolUseId: 'b1' } as any;

  // ---- enable ----

  test('enable returns briefMode:true with a concise-mode message', async () => {
    const tool = createBriefTool();
    const result = await tool.execute({ enable: true }, baseCtx);
    expect(result.briefMode).toBe(true);
    expect(result.message).toContain('ON');
  });

  // ---- disable ----

  test('disable returns briefMode:false with a normal-verbosity message', async () => {
    const tool = createBriefTool();
    const result = await tool.execute({ enable: false }, baseCtx);
    expect(result.briefMode).toBe(false);
    expect(result.message).toContain('OFF');
  });

  // ---- app state update ----

  test('updates ctx.setAppState with briefMode:true when enable is true', async () => {
    let state: any = { existing: 42 };
    const ctx = {
      ...baseCtx,
      getAppState: () => state,
      setAppState: (updater: (prev: any) => any) => {
        state = updater(state);
      },
    };

    const tool = createBriefTool();
    await tool.execute({ enable: true }, ctx);
    expect(state.briefMode).toBe(true);
    // Existing state fields must be preserved
    expect(state.existing).toBe(42);
  });

  test('updates ctx.setAppState with briefMode:false when enable is false', async () => {
    let state: any = { briefMode: true };
    const ctx = {
      ...baseCtx,
      setAppState: (updater: (prev: any) => any) => {
        state = updater(state);
      },
    };

    const tool = createBriefTool();
    await tool.execute({ enable: false }, ctx);
    expect(state.briefMode).toBe(false);
  });

  // ---- no app state ----

  test('executes without error when ctx.setAppState is absent', async () => {
    const tool = createBriefTool();
    // No setAppState on the context — should not throw
    const result = await tool.execute({ enable: true }, baseCtx);
    expect(result.briefMode).toBe(true);
  });

  test('executes without error when ctx.setAppState throws', async () => {
    const ctx = {
      ...baseCtx,
      setAppState: () => {
        throw new Error('state store unavailable');
      },
    };
    const tool = createBriefTool();
    // Error from setAppState must be swallowed; result still returns
    const result = await tool.execute({ enable: true }, ctx);
    expect(result.briefMode).toBe(true);
    expect(result.message).toContain('ON');
  });

  // ---- idempotent ----

  test('enabling twice returns briefMode:true both times', async () => {
    const tool = createBriefTool();
    const first = await tool.execute({ enable: true }, baseCtx);
    const second = await tool.execute({ enable: true }, baseCtx);
    expect(first.briefMode).toBe(true);
    expect(second.briefMode).toBe(true);
  });
});
