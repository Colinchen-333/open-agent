import { describe, expect, test, afterEach } from 'bun:test';
import { createEnterPlanModeTool, createExitPlanModeTool, createExitPlanModeV2Tool } from '../plan-mode.js';
import { PermissionEngine } from '@open-agent/permissions';
import { setFeatureDefault, clearFeatureOverrides } from '@open-agent/core';

// Minimal ToolContext for execute() calls
const ctx = { cwd: '/', sessionId: 's' } as any;

describe('plan-mode tools (engine variant)', () => {
  test('EnterPlanMode clears stale allowedPrompts on re-enter', async () => {
    // Simulate: phase-1 plan exits and registers prompts, then the model enters
    // plan mode again for phase-2.  The phase-1 prompts must not carry over.
    const engine = new PermissionEngine({ mode: 'default' });

    // Register some prompts from a previous plan phase.
    engine.registerAllowedPrompts([{ tool: 'Bash', prompt: 'run tests' }]);
    expect(engine.getAllowedPrompts()).toHaveLength(1);

    // Entering plan mode again must clear those stale prompts.
    const enter = createEnterPlanModeTool({ engine });
    await enter.execute({}, ctx);

    expect(engine.getAllowedPrompts()).toHaveLength(0);
    expect(engine.getMode()).toBe('plan');
  });

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

// ---------------------------------------------------------------------------
// ExitPlanModeV2
// ---------------------------------------------------------------------------

describe('ExitPlanModeV2', () => {
  afterEach(() => {
    clearFeatureOverrides();
  });

  test('returns error payload when feature flag is off', async () => {
    // Flag defaults to false — no setFeatureDefault needed
    const engine = new PermissionEngine({ mode: 'default' });
    engine.pushMode('plan');
    const tool = createExitPlanModeV2Tool({ engine });
    const result = await tool.execute({ plan: 'do stuff' }, ctx) as any;
    expect(result.error).toContain('ExitPlanModeV2 is not enabled');
    expect(result.fallback).toContain('ExitPlanMode');
    // mode must NOT have changed — flag was off so popMode was skipped
    expect(engine.getMode()).toBe('plan');
  });

  test('pops mode and returns correct result when flag is on', async () => {
    setFeatureDefault('EXIT_PLAN_MODE_V2', true);
    const engine = new PermissionEngine({ mode: 'default' });
    engine.pushMode('plan');
    const tool = createExitPlanModeV2Tool({ engine });
    const result = await tool.execute({ plan: 'my plan' }, ctx) as any;
    expect(result.mode).toBe('default');
    expect(result.plan).toBe('my plan');
    expect(result.allowedPromptsRegistered).toBe(0);
  });

  test('registers allowedPrompts via engine.registerAllowedPrompts when flag is on', async () => {
    setFeatureDefault('EXIT_PLAN_MODE_V2', true);
    const engine = new PermissionEngine({ mode: 'default' });
    engine.pushMode('plan');
    const tool = createExitPlanModeV2Tool({ engine });
    const prompts = [
      { tool: 'Bash', prompt: 'run tests' },
      { tool: 'Bash', prompt: 'install dependencies' },
    ];
    const result = await tool.execute({ plan: 'plan text', allowedPrompts: prompts }, ctx) as any;
    expect(result.allowedPromptsRegistered).toBe(2);
    expect(result.mode).toBe('default');
    const registered = engine.getAllowedPrompts();
    expect(registered).toHaveLength(2);
    expect(registered[0]).toEqual({ tool: 'Bash', prompt: 'run tests' });
    expect(registered[1]).toEqual({ tool: 'Bash', prompt: 'install dependencies' });
  });

  test('calling with no allowedPrompts still pops mode and returns allowedPromptsRegistered: 0', async () => {
    setFeatureDefault('EXIT_PLAN_MODE_V2', true);
    const engine = new PermissionEngine({ mode: 'acceptEdits' });
    engine.pushMode('plan');
    const tool = createExitPlanModeV2Tool({ engine });
    const result = await tool.execute({ plan: 'empty prompts plan' }, ctx) as any;
    expect(result.allowedPromptsRegistered).toBe(0);
    expect(result.mode).toBe('acceptEdits');
    expect(engine.getAllowedPrompts()).toHaveLength(0);
  });
});
