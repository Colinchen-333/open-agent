import { describe, expect, test } from 'bun:test';
import { createEnterPlanModeTool, createExitPlanModeTool } from '../plan-mode.js';
import { PermissionEngine } from '@open-agent/permissions';

// Minimal ToolContext for execute() calls
const ctx = { cwd: '/', sessionId: 's' } as any;

describe('plan-mode tools (engine variant)', () => {
  test('EnterPlanMode switches engine to plan mode', async () => {
    const engine = new PermissionEngine({ mode: 'default' });
    const tool = createEnterPlanModeTool({ engine });
    await tool.execute({}, ctx);
    expect(engine.getMode()).toBe('plan');
  });

  test('ExitPlanMode restores previous mode', async () => {
    const engine = new PermissionEngine({ mode: 'default' });
    const enter = createEnterPlanModeTool({ engine });
    const exit = createExitPlanModeTool({ engine });
    await enter.execute({}, ctx);
    expect(engine.getMode()).toBe('plan');
    await exit.execute({}, ctx);
    expect(engine.getMode()).toBe('default');
  });

  test('EnterPlanMode is nestable — pushes multiple times', async () => {
    const engine = new PermissionEngine({ mode: 'acceptEdits' });
    const enter = createEnterPlanModeTool({ engine });
    const exit = createExitPlanModeTool({ engine });

    await enter.execute({}, ctx);
    expect(engine.getMode()).toBe('plan');

    // Push again (still plan)
    await enter.execute({}, ctx);
    expect(engine.getMode()).toBe('plan');

    // First pop returns to plan (because plan was on stack)
    await exit.execute({}, ctx);
    expect(engine.getMode()).toBe('plan');

    // Second pop returns to acceptEdits
    await exit.execute({}, ctx);
    expect(engine.getMode()).toBe('acceptEdits');
  });

  test('ExitPlanMode on un-entered engine is a no-op', async () => {
    const engine = new PermissionEngine({ mode: 'default' });
    const exit = createExitPlanModeTool({ engine });
    // Should not throw; mode stays default
    await exit.execute({}, ctx);
    expect(engine.getMode()).toBe('default');
  });

  test('EnterPlanMode execute returns a string message', async () => {
    const engine = new PermissionEngine({ mode: 'default' });
    const tool = createEnterPlanModeTool({ engine });
    const result = await tool.execute({}, ctx);
    expect(typeof result).toBe('string');
    expect(result as string).toContain('plan mode');
  });

  test('ExitPlanMode execute returns a string message', async () => {
    const engine = new PermissionEngine({ mode: 'default' });
    const enter = createEnterPlanModeTool({ engine });
    const exit = createExitPlanModeTool({ engine });
    await enter.execute({}, ctx);
    const result = await exit.execute({}, ctx);
    expect(typeof result).toBe('string');
    expect(result as string).toContain('plan');
  });
});

describe('plan-mode tools (legacy PlanModeDeps variant)', () => {
  test('EnterPlanMode calls deps.enterPlanMode', async () => {
    let entered = false;
    const deps = {
      enterPlanMode: () => { entered = true; },
      exitPlanMode: () => {},
      isPlanMode: () => entered,
    };
    const tool = createEnterPlanModeTool(deps);
    await tool.execute({}, ctx);
    expect(entered).toBe(true);
  });

  test('ExitPlanMode calls deps.exitPlanMode', async () => {
    let planMode = true;
    let exited = false;
    const deps = {
      enterPlanMode: () => {},
      exitPlanMode: () => { planMode = false; exited = true; },
      isPlanMode: () => planMode,
    };
    const tool = createExitPlanModeTool(deps);
    await tool.execute({}, ctx);
    expect(exited).toBe(true);
  });

  test('EnterPlanMode returns "Already in plan mode" when isPlanMode is true', async () => {
    const deps = {
      enterPlanMode: () => {},
      exitPlanMode: () => {},
      isPlanMode: () => true,
    };
    const tool = createEnterPlanModeTool(deps);
    const result = await tool.execute({}, ctx);
    expect(result).toContain('Already in plan mode');
  });

  test('ExitPlanMode returns "Not currently in plan mode" when isPlanMode is false', async () => {
    const deps = {
      enterPlanMode: () => {},
      exitPlanMode: () => {},
      isPlanMode: () => false,
    };
    const tool = createExitPlanModeTool(deps);
    const result = await tool.execute({}, ctx);
    expect(result).toContain('Not currently in plan mode');
  });
});
