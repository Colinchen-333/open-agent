import { describe, expect, test, beforeEach } from 'bun:test';
import {
  createTodoWriteTool,
  getTodosForSession,
  clearTodoSessions,
  type TodoItem,
} from '../todo-write.js';

describe('TodoWrite tool', () => {
  beforeEach(() => {
    clearTodoSessions();
  });

  const ctx = { cwd: '/', sessionId: 'sess-1', toolUseId: 'tu-1' } as any;

  test('stores a simple todo list', async () => {
    const tool = createTodoWriteTool();
    const result = await tool.execute(
      {
        todos: [
          { content: 'Write tests', status: 'in_progress', activeForm: 'Writing tests' },
          { content: 'Commit', status: 'pending' },
        ],
      },
      ctx,
    );
    expect(result.todos).toHaveLength(2);
    expect(result.summary).toContain('2 items');
    expect(result.summary).toContain('in progress');
    expect(result.summary).toContain('Writing tests');
    expect(getTodosForSession('sess-1')).toHaveLength(2);
  });

  test('replaces previous list entirely (non-completed list)', async () => {
    const tool = createTodoWriteTool();
    await tool.execute({ todos: [{ content: 'first', status: 'pending' }] }, ctx);
    await tool.execute(
      { todos: [{ content: 'second', status: 'pending' }] },
      ctx,
    );
    const stored = getTodosForSession('sess-1');
    expect(stored).toHaveLength(1);
    expect(stored[0]!.content).toBe('second');
    expect(stored[0]!.status).toBe('pending');
  });

  test('rejects non-array input', async () => {
    const tool = createTodoWriteTool();
    await expect(tool.execute({ todos: 'not an array' } as any, ctx)).rejects.toThrow(/array/);
  });

  test('rejects empty content', async () => {
    const tool = createTodoWriteTool();
    await expect(
      tool.execute({ todos: [{ content: '   ', status: 'pending' }] }, ctx),
    ).rejects.toThrow(/non-empty/);
  });

  test('rejects invalid status', async () => {
    const tool = createTodoWriteTool();
    await expect(
      tool.execute({ todos: [{ content: 'x', status: 'bogus' as any }] }, ctx),
    ).rejects.toThrow(/pending/);
  });

  test('trims content and activeForm', async () => {
    const tool = createTodoWriteTool();
    const result = await tool.execute(
      { todos: [{ content: '  trim me  ', status: 'pending', activeForm: '  running  ' }] },
      ctx,
    );
    expect(result.todos[0]!.content).toBe('trim me');
    expect(result.todos[0]!.activeForm).toBe('running');
  });

  test('calls onUpdate callback', async () => {
    let captured: TodoItem[] | null = null;
    const tool = createTodoWriteTool({
      onUpdate: (todos) => {
        captured = todos;
      },
    });
    await tool.execute({ todos: [{ content: 'hook test', status: 'pending' }] }, ctx);
    expect(captured).not.toBeNull();
    expect(captured![0]!.content).toBe('hook test');
  });

  test('per-session isolation', async () => {
    const tool = createTodoWriteTool();
    await tool.execute(
      { todos: [{ content: 'sess-a', status: 'pending' }] },
      { ...ctx, sessionId: 'a' },
    );
    await tool.execute(
      { todos: [{ content: 'sess-b', status: 'pending' }] },
      { ...ctx, sessionId: 'b' },
    );
    expect(getTodosForSession('a')[0]!.content).toBe('sess-a');
    expect(getTodosForSession('b')[0]!.content).toBe('sess-b');
  });

  test('summary lists multiple in_progress items', async () => {
    const tool = createTodoWriteTool();
    const result = await tool.execute(
      {
        todos: [
          { content: 'A', status: 'in_progress', activeForm: 'Doing A' },
          { content: 'B', status: 'in_progress', activeForm: 'Doing B' },
        ],
      },
      ctx,
    );
    expect(result.summary).toContain('Doing A');
    expect(result.summary).toContain('Doing B');
  });

  test('summary omits in-progress block when nothing is in progress', async () => {
    const tool = createTodoWriteTool();
    const result = await tool.execute(
      { todos: [{ content: 'done', status: 'pending' }] },
      ctx,
    );
    expect(result.summary).not.toContain('Currently in progress');
  });

  // ── R6.5 new tests ────────────────────────────────────────────────────────

  test('returns oldTodos and newTodos', async () => {
    const tool = createTodoWriteTool();
    await tool.execute({ todos: [{ content: 'first', status: 'pending' }] }, ctx);
    const result = await tool.execute(
      { todos: [{ content: 'first', status: 'in_progress' }] },
      ctx,
    );
    expect(result.oldTodos).toHaveLength(1);
    expect(result.oldTodos[0].status).toBe('pending');
    expect(result.newTodos).toHaveLength(1);
    expect(result.newTodos[0].status).toBe('in_progress');
  });

  test('oldTodos is empty array on first call', async () => {
    const tool = createTodoWriteTool();
    const result = await tool.execute(
      { todos: [{ content: 'first', status: 'pending' }] },
      ctx,
    );
    expect(result.oldTodos).toEqual([]);
    expect(result.newTodos).toHaveLength(1);
  });

  test('auto-clears list when all items completed', async () => {
    const tool = createTodoWriteTool();
    // Set up a pending item first
    await tool.execute({ todos: [{ content: 'done', status: 'pending' }] }, ctx);
    // Now mark it completed
    const result = await tool.execute(
      { todos: [{ content: 'done', status: 'completed' }] },
      ctx,
    );
    // The in-memory store should be cleared
    expect(getTodosForSession(ctx.sessionId)).toHaveLength(0);
    // newTodos should reflect the cleared state
    expect(result.newTodos).toHaveLength(0);
    // Summary should mention the clear
    expect(result.summary).toContain('cleared');
  });

  test('auto-clear fires onUpdate with empty array', async () => {
    let lastUpdate: TodoItem[] | undefined;
    const tool = createTodoWriteTool({
      onUpdate: (todos) => {
        lastUpdate = todos;
      },
    });
    await tool.execute({ todos: [{ content: 'task', status: 'completed' }] }, ctx);
    expect(lastUpdate).toEqual([]);
  });

  test('does not clear list when some items are not completed', async () => {
    const tool = createTodoWriteTool();
    await tool.execute(
      {
        todos: [
          { content: 'a', status: 'completed' },
          { content: 'b', status: 'pending' },
        ],
      },
      ctx,
    );
    expect(getTodosForSession(ctx.sessionId)).toHaveLength(2);
  });

  test('includes verification nudge when items are newly completed', async () => {
    const tool = createTodoWriteTool();
    await tool.execute({ todos: [{ content: 'task', status: 'in_progress' }] }, ctx);
    const result = await tool.execute(
      { todos: [{ content: 'task', status: 'completed' }] },
      ctx,
    );
    expect(result.summary).toContain('Verification');
    expect(result.summary).toContain('1 item(s) just completed');
  });

  test('no verification nudge when status was already completed', async () => {
    const tool = createTodoWriteTool();
    // Write a list where item is already completed
    await tool.execute({ todos: [{ content: 'done', status: 'completed' }] }, ctx);
    // Re-submit the same completed item — not a new completion
    // (auto-clear fires here so we need two items to avoid clearing on first call)
    clearTodoSessions();
    await tool.execute(
      {
        todos: [
          { content: 'done', status: 'completed' },
          { content: 'pending', status: 'pending' },
        ],
      },
      ctx,
    );
    // Re-submit — item[0] was already completed, item[1] stays pending
    const result = await tool.execute(
      {
        todos: [
          { content: 'done', status: 'completed' },
          { content: 'pending', status: 'pending' },
        ],
      },
      ctx,
    );
    expect(result.summary).not.toContain('Verification');
  });

  test('auto-generates activeForm for in_progress items without one', async () => {
    const tool = createTodoWriteTool();
    const result = await tool.execute(
      { todos: [{ content: 'Run tests', status: 'in_progress' }] },
      ctx,
    );
    expect(result.newTodos[0].activeForm).toBe('Working on: Run tests');
    expect(result.summary).toContain('Working on: Run tests');
  });

  test('preserves explicit activeForm for in_progress items', async () => {
    const tool = createTodoWriteTool();
    const result = await tool.execute(
      {
        todos: [
          { content: 'Run tests', status: 'in_progress', activeForm: 'Running test suite' },
        ],
      },
      ctx,
    );
    expect(result.newTodos[0].activeForm).toBe('Running test suite');
  });

  test('does not set activeForm for pending or completed items', async () => {
    const tool = createTodoWriteTool();
    const result = await tool.execute(
      {
        todos: [
          { content: 'Pending task', status: 'pending' },
          { content: 'Done task', status: 'completed' },
        ],
      },
      ctx,
    );
    // auto-clear fires because all items would... wait, 'pending' is not completed
    // Only completed item is one, pending is one — no auto-clear
    expect(result.newTodos[0].activeForm).toBeUndefined();
    expect(result.newTodos[1].activeForm).toBeUndefined();
  });

  test('setAppState is called when present in context', async () => {
    const tool = createTodoWriteTool();
    let capturedState: any = null;
    const ctxWithState = {
      ...ctx,
      setAppState: (updater: (prev: any) => any) => {
        capturedState = updater({});
      },
    };
    await tool.execute(
      { todos: [{ content: 'task', status: 'pending' }] },
      ctxWithState,
    );
    expect(capturedState).not.toBeNull();
    expect(capturedState.tasksState).toHaveLength(1);
    expect(capturedState.tasksState[0].content).toBe('task');
    expect(capturedState.tasksState[0].id).toContain('todo-');
  });
});
