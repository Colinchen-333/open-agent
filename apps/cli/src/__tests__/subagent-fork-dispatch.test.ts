/**
 * R9 — Fork isolation gap closure: CLI runSubagent fork dispatch tests
 *
 * Verifies that when isolation === 'fork' is passed through the Task tool's
 * runSubagent boundary, the parameter propagates correctly.  The full
 * integration path through agentExecutor.executeForked() lives in the
 * index.ts closure and requires a running conversation loop, so these tests
 * operate at the Task-tool boundary (the public API that index.ts wires up).
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
