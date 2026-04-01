import { describe, expect, it } from 'bun:test';
import { createTaskCreateTool, createTaskListTool, createTaskUpdateTool } from '../task-tools.js';
import type { TaskToolsDeps } from '../task-tools.js';
import type { ToolContext } from '../types.js';

const mockCtx: ToolContext = {
  cwd: '/tmp/test-project',
  sessionId: 'test-session-001',
};

function makeDeps(overrides: Partial<TaskToolsDeps> = {}): TaskToolsDeps {
  return {
    createTask: async (params) => ({ id: 'task-1', subject: params.subject }),
    updateTask: async () => ({ success: true }),
    getTask: async () => null,
    listTasks: async () => [],
    ...overrides,
  };
}

describe('Task tools priority support', () => {
  it('TaskCreate exposes priority and forwards it to createTask', async () => {
    let capturedParams: any;
    const tool = createTaskCreateTool(makeDeps({
      createTask: async (params: any) => {
        capturedParams = params;
        return { id: 'task-1', subject: params.subject };
      },
    }));

    expect(tool.inputSchema.properties.priority).toBeDefined();
    expect(tool.inputSchema.properties.priority.type).toBe('integer');

    await tool.execute(
      {
        subject: 'ship feature',
        description: 'deliver the feature',
        priority: 7,
      },
      mockCtx,
    );

    expect(capturedParams.priority).toBe(7);
    expect(capturedParams.subject).toBe('ship feature');
  });

  it('TaskUpdate exposes priority and forwards it to updateTask', async () => {
    let capturedParams: any;
    const tool = createTaskUpdateTool(makeDeps({
      updateTask: async (params: any) => {
        capturedParams = params;
        return { success: true };
      },
    }));

    expect(tool.inputSchema.properties.priority).toBeDefined();
    expect(tool.inputSchema.properties.priority.type).toBe('integer');

    await tool.execute(
      {
        taskId: 'task-42',
        status: 'in_progress',
        priority: 12,
      },
      mockCtx,
    );

    expect(capturedParams.taskId).toBe('task-42');
    expect(capturedParams.priority).toBe(12);
    expect(capturedParams.status).toBe('in_progress');
  });

  it('TaskList surfaces priority in the rendered task output', async () => {
    const tool = createTaskListTool(makeDeps({
      listTasks: async () => [
        { id: '1', status: 'pending', subject: 'low priority task', priority: 1 },
        { id: '2', status: 'pending', subject: 'high priority task', priority: 10 },
      ],
    }));

    const output = await tool.execute({}, mockCtx) as string;

    expect(output).toContain('low priority task');
    expect(output).toContain('high priority task');
    expect(output.toLowerCase()).toContain('priority');
    expect(output).toContain('1');
    expect(output).toContain('10');
  });
});
