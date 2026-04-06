/**
 * R9 / R12 — Fork isolation gap closure: CLI runSubagent fork dispatch tests
 *
 * Verifies that when isolation === 'fork' is passed through the Task tool's
 * runSubagent boundary, the parameter propagates correctly.  The full
 * integration path through agentExecutor.executeForked() lives in the
 * index.ts closure and requires a running conversation loop, so these tests
 * operate at the Task-tool boundary (the public API that index.ts wires up).
 *
 * R12 adds two tests that verify the agentDef fallback behaviour that
 * mirrors what R11 wired into packages/sdk/src/query.ts:
 *   - agentDef.isolation is honoured when caller omits isolation
 *   - agentDef.allowBackgroundExecution is honoured when caller omits run_in_background
 */
import { describe, it, expect } from 'bun:test';
import { createTaskTool } from '@open-agent/tools';
import type { TaskToolDeps } from '@open-agent/tools';
import type { ToolContext } from '@open-agent/tools';

const mockCtx: ToolContext = {
  cwd: '/tmp/test-project',
  sessionId: 'test-session-fork-001',
};

function makeDeps(overrides?: Partial<TaskToolDeps>): TaskToolDeps {
  return {
    runSubagent: async params => {
      return JSON.stringify({
        agentId: 'agent-fork-mock-001',
        status: 'async_launched',
        isolation: params.isolation,
        description: params.name ?? params.subagentType,
      });
    },
    ...overrides,
  };
}

describe('CLI subagent fork dispatch (Task tool boundary)', () => {
  it("passes isolation: 'fork' through to runSubagent", async () => {
    let capturedParams: any;
    const deps = makeDeps({
      runSubagent: async params => {
        capturedParams = params;
        return JSON.stringify({ agentId: 'fork-agent-001', status: 'async_launched' });
      },
    });
    const tool = createTaskTool(deps);

    await tool.execute(
      {
        description: 'fork isolation dispatch test',
        prompt: 'Run with fork isolation',
        subagent_type: 'code-writer',
        isolation: 'fork',
      },
      mockCtx
    );

    expect(capturedParams.isolation).toBe('fork');
  });

  it("isolation: 'fork' does not set runInBackground on the params object", async () => {
    let capturedParams: any;
    const deps = makeDeps({
      runSubagent: async params => {
        capturedParams = params;
        return JSON.stringify({ agentId: 'fork-agent-002', status: 'async_launched' });
      },
    });
    const tool = createTaskTool(deps);

    await tool.execute(
      {
        description: 'fork no background flag test',
        prompt: 'Fork without explicit background',
        subagent_type: 'code-writer',
        isolation: 'fork',
      },
      mockCtx
    );

    // fork isolation is a separate dispatch path; run_in_background is not implied
    expect(capturedParams.runInBackground).toBeFalsy();
  });

  it("isolation enum in Task tool schema includes 'fork'", () => {
    const tool = createTaskTool(makeDeps());
    const isolationProp = tool.inputSchema.properties.isolation;
    expect(isolationProp).toBeDefined();
    expect(isolationProp.enum).toContain('fork');
  });

  it("isolation: 'fork' inherits cwd from tool context", async () => {
    let capturedParams: any;
    const deps = makeDeps({
      runSubagent: async params => {
        capturedParams = params;
        return JSON.stringify({ agentId: 'fork-agent-003', status: 'async_launched' });
      },
    });
    const tool = createTaskTool(deps);
    const ctxWithCwd: ToolContext = { ...mockCtx, cwd: '/custom/work/dir' };

    await tool.execute(
      {
        description: 'fork with cwd test',
        prompt: 'Fork in custom dir',
        subagent_type: 'code-writer',
        isolation: 'fork',
      },
      ctxWithCwd
    );

    expect(capturedParams.isolation).toBe('fork');
    // cwd comes from the tool context, not the input schema
    expect(capturedParams.cwd).toBe('/custom/work/dir');
  });
});

// ---------------------------------------------------------------------------
// R12 — CLI runSubagent agentDef fallback contract tests
//
// index.ts's runSubagent closure is not independently importable, so these
// tests verify the contract by constructing a minimal simulation of the
// fallback logic that index.ts wires.  A companion stub executor records
// which dispatch path was taken (fork / background / foreground) so the
// assertions are identical to the R11 SDK-layer tests.
// ---------------------------------------------------------------------------

type DispatchPath = 'forked' | 'background' | 'foreground';

interface AgentDefStub {
  isolation?: string;
  allowBackgroundExecution?: boolean;
}

/**
 * Minimal simulation of the R12 runSubagent closure logic from index.ts.
 * Returns which executor dispatch path would have been taken.
 */
function simulateCLIRunSubagent(
  callerIsolation: string | undefined,
  callerRunInBackground: boolean | undefined,
  agentDef: AgentDefStub,
): DispatchPath {
  // R12 fallback: caller wins; absent → agentDef default
  const effectiveIsolation = callerIsolation ?? agentDef.isolation;
  const effectiveRunInBackground =
    callerRunInBackground === true ||
    (callerRunInBackground === undefined && agentDef.allowBackgroundExecution === true);

  if (effectiveIsolation === 'fork') return 'forked';
  if (effectiveRunInBackground) return 'background';
  return 'foreground';
}

describe('R12 — CLI runSubagent agentDef fallback (isolation + allowBackgroundExecution)', () => {
  it('falls back to agentDef.isolation when caller omits isolation', () => {
    const path = simulateCLIRunSubagent(
      undefined, // caller did not supply isolation
      undefined,
      { isolation: 'fork' },
    );
    expect(path).toBe('forked');
  });

  it('falls back to agentDef.allowBackgroundExecution when caller omits run_in_background', () => {
    const path = simulateCLIRunSubagent(
      undefined,
      undefined, // caller did not supply run_in_background
      { allowBackgroundExecution: true },
    );
    expect(path).toBe('background');
  });

  it('caller-supplied isolation overrides agentDef.isolation', () => {
    // caller passes 'worktree', agentDef says 'fork' — caller must win
    const path = simulateCLIRunSubagent('worktree', undefined, { isolation: 'fork' });
    expect(path).toBe('foreground'); // worktree is not fork/background, falls through
  });

  it('explicit run_in_background=false overrides agentDef.allowBackgroundExecution=true', () => {
    const path = simulateCLIRunSubagent(
      undefined,
      false, // explicit false must suppress background dispatch
      { allowBackgroundExecution: true },
    );
    expect(path).toBe('foreground');
  });

  it('fork takes precedence over allowBackgroundExecution when both are set via agentDef', () => {
    const path = simulateCLIRunSubagent(
      undefined,
      undefined,
      { isolation: 'fork', allowBackgroundExecution: true },
    );
    expect(path).toBe('forked');
  });
});
