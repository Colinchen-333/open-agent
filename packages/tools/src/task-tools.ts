import type { ToolDefinition, ToolContext } from './types.js';

export interface TaskToolsDeps {
  createTask: (params: {
    subject: string;
    description: string;
    activeForm?: string;
    metadata?: Record<string, unknown>;
  }) => Promise<{ id: string; subject: string }>;
  updateTask: (params: {
    taskId: string;
    status?: string;
    subject?: string;
    description?: string;
    activeForm?: string;
    owner?: string;
    addBlocks?: string[];
    addBlockedBy?: string[];
    metadata?: Record<string, unknown>;
  }) => Promise<{ success: boolean }>;
  getTask: (taskId: string) => Promise<any>;
  listTasks: () => Promise<any[]>;
}

export function createTaskCreateTool(deps: TaskToolsDeps): ToolDefinition {
  return {
    name: 'TaskCreate',
    description: 'Create a new task in the task list for tracking progress on complex work.',
    inputSchema: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: 'Brief title for the task' },
        description: { type: 'string', description: 'Detailed description of what needs to be done' },
        activeForm: {
          type: 'string',
          description: 'Present continuous form shown when in_progress (e.g., "Running tests")',
        },
        metadata: { type: 'object', description: 'Arbitrary metadata to attach' },
      },
      required: ['subject', 'description'],
    },
    async execute(input: any, _ctx: ToolContext) {
      const result = await deps.createTask(input);
      return `Task #${result.id} created successfully: ${result.subject}`;
    },
  };
}

export function createTaskUpdateTool(deps: TaskToolsDeps): ToolDefinition {
  return {
    name: 'TaskUpdate',
    description: 'Update a task status, details, or dependencies.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'The task ID to update' },
        status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'deleted'] },
        subject: { type: 'string' },
        description: { type: 'string' },
        activeForm: { type: 'string' },
        owner: { type: 'string' },
        addBlocks: { type: 'array', items: { type: 'string' } },
        addBlockedBy: { type: 'array', items: { type: 'string' } },
        metadata: { type: 'object' },
      },
      required: ['taskId'],
    },
    async execute(input: any, _ctx: ToolContext) {
      await deps.updateTask(input);
      return `Updated task #${input.taskId}${input.status ? ' status' : ''}`;
    },
  };
}

export function createTaskGetTool(deps: TaskToolsDeps): ToolDefinition {
  return {
    name: 'TaskGet',
    description: 'Retrieve a task by its ID with full details.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'The task ID to retrieve' },
      },
      required: ['taskId'],
    },
    async execute(input: any, _ctx: ToolContext) {
      const task = await deps.getTask(input.taskId);
      if (!task) return `Task #${input.taskId} not found`;
      return JSON.stringify(task, null, 2);
    },
  };
}

export function createTaskListTool(deps: TaskToolsDeps): ToolDefinition {
  return {
    name: 'TaskList',
    description: 'List all tasks in the current task list.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async execute(_input: any, _ctx: ToolContext) {
      const tasks = await deps.listTasks();
      if (tasks.length === 0) return 'No tasks found.';

      return tasks
        .map((t: any) => {
          const blocked = t.blockedBy?.length ? ` [blocked by: ${t.blockedBy.join(', ')}]` : '';
          const owner = t.owner ? ` (${t.owner})` : '';
          return `#${t.id} [${t.status}] ${t.subject}${owner}${blocked}`;
        })
        .join('\n');
    },
  };
}
