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

  test('replaces previous list entirely', async () => {
    const tool = createTodoWriteTool();
    await tool.execute({ todos: [{ content: 'first', status: 'pending' }] }, ctx);
    await tool.execute({ todos: [{ content: 'second', status: 'completed' }] }, ctx);
    const stored = getTodosForSession('sess-1');
    expect(stored).toHaveLength(1);
    expect(stored[0]!.content).toBe('second');
    expect(stored[0]!.status).toBe('completed');
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
      { todos: [{ content: 'done', status: 'completed' }] },
      ctx,
    );
    expect(result.summary).not.toContain('Currently in progress');
  });
});
