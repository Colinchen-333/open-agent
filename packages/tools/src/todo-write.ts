import { withToolDefaults } from './tool-defaults.js';
import type { ToolDefinition, ToolContext } from './types.js';

/**
 * A single todo item in the task list.
 *
 * `activeForm` is the present-continuous phrasing of the todo (e.g., "Running tests")
 * shown in the UI while the task is `in_progress`. `content` is the imperative form
 * shown in lists ("Run tests").
 *
 * When an item is `in_progress` and `activeForm` is not supplied, the tool
 * auto-generates one by prepending "Working on: " to `content`.
 */
export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string;
}

export interface TodoWriteOptions {
  /**
   * Optional persistence callback called whenever the todo list is rewritten.
   * Receives the new todo array so the host can persist or display them.
   */
  onUpdate?: (todos: TodoItem[]) => void | Promise<void>;
}

/** In-memory todo list keyed by sessionId. */
const todosBySession = new Map<string, TodoItem[]>();

/** Test-only: clear all session todos. */
export function clearTodoSessions(): void {
  todosBySession.clear();
}

/** Read the current todo list for a session (for CLI display, tests, etc.). */
export function getTodosForSession(sessionId: string): TodoItem[] {
  return todosBySession.get(sessionId) ?? [];
}

/**
 * Factory for the `TodoWrite` tool. The tool takes a single argument: the
 * complete replacement todo list. Semantics match Claude Code:
 *   - Input completely replaces the previous list (stateless call → stateful store)
 *   - Status transitions: pending → in_progress → completed
 *   - Exactly one item should be in_progress at a time (not enforced, but recommended)
 *   - Removing an item by omitting it from the list is allowed but uncommon
 *   - Returns both `oldTodos` and `newTodos` so callers can diff the change
 *   - Auto-clears the session list when every item is completed
 *   - Emits a verification nudge when items are newly marked completed
 *   - Auto-generates `activeForm` for in_progress items that omit it
 */
export function createTodoWriteTool(options: TodoWriteOptions = {}): ToolDefinition {
  return withToolDefaults({
    name: 'TodoWrite',
    description:
      "Manage the agent's task todo list. Pass the complete array of todos each time — " +
      'the list is replaced entirely. Use this to plan multi-step tasks, track progress, and ' +
      'signal which item is currently in progress. Every item needs `content` (imperative, ' +
      'e.g. "Run tests") and `status` ("pending" | "in_progress" | "completed"). Prefer one ' +
      'in_progress item at a time. `activeForm` (present continuous, e.g. "Running tests") is ' +
      'shown while that item is in progress — omitting it for in_progress items causes an ' +
      'auto-generated form ("Working on: <content>") to be used.',
    inputSchema: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string', description: 'Imperative form of the todo' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
              activeForm: {
                type: 'string',
                description: 'Present continuous form (e.g. "Running tests")',
              },
            },
            required: ['content', 'status'],
          },
          description: 'The complete replacement todo list',
        },
      },
      required: ['todos'],
    },
    capability: {
      category: 'task',
      risk: 'low',
      readOnly: false,
      concurrencySafe: false,
    },
    annotations: {
      readOnly: false,
      idempotent: true, // replacing the same list twice yields the same state
    },
    async execute(input: { todos: TodoItem[] }, ctx: ToolContext) {
      if (!Array.isArray(input.todos)) {
        throw new Error('TodoWrite: `todos` must be an array');
      }

      // Snapshot previous list before making changes
      const sessionKey = ctx.sessionId ?? '_default_';
      const previousList: TodoItem[] = todosBySession.get(sessionKey) ?? [];

      // Validate every item
      const validated: TodoItem[] = [];
      for (const [idx, item] of input.todos.entries()) {
        if (!item || typeof item !== 'object') {
          throw new Error(`TodoWrite: todos[${idx}] must be an object`);
        }
        if (typeof item.content !== 'string' || item.content.trim().length === 0) {
          throw new Error(`TodoWrite: todos[${idx}].content must be a non-empty string`);
        }
        if (!['pending', 'in_progress', 'completed'].includes(item.status)) {
          throw new Error(
            `TodoWrite: todos[${idx}].status must be pending | in_progress | completed`,
          );
        }
        const validatedItem: TodoItem = {
          content: item.content.trim(),
          status: item.status,
        };
        if (typeof item.activeForm === 'string' && item.activeForm.trim().length > 0) {
          validatedItem.activeForm = item.activeForm.trim();
        }
        // Part 5: auto-generate activeForm for in_progress items that omit it
        if (item.status === 'in_progress' && !validatedItem.activeForm) {
          validatedItem.activeForm = `Working on: ${validatedItem.content}`;
        }
        validated.push(validatedItem);
      }

      // Part 4: Identify items newly transitioned to completed for the verification nudge.
      // We match by index so the nudge fires even if content was also changed.
      const justCompleted = validated.filter((t, i) => {
        const old = previousList[i];
        return t.status === 'completed' && old?.status !== 'completed';
      });

      // Part 3: Auto-clear when every item is completed
      const allCompleted =
        validated.length > 0 && validated.every((t) => t.status === 'completed');

      if (allCompleted) {
        todosBySession.delete(sessionKey);
      } else {
        todosBySession.set(sessionKey, validated);
      }

      // Fire update callback (best-effort)
      if (options.onUpdate) {
        try {
          await Promise.resolve(options.onUpdate(allCompleted ? [] : validated));
        } catch {
          /* swallow */
        }
      }

      // Format summary for the model
      const counts = { pending: 0, in_progress: 0, completed: 0 };
      for (const t of validated) counts[t.status]++;

      const inProgressList = validated
        .filter((t) => t.status === 'in_progress')
        .map((t) => `  → ${t.activeForm ?? t.content}`);

      const lines: string[] = [
        `Todo list updated (${validated.length} items: ${counts.completed} done, ${counts.in_progress} in progress, ${counts.pending} pending)`,
      ];
      if (inProgressList.length > 0) {
        lines.push('Currently in progress:');
        lines.push(...inProgressList);
      }
      if (allCompleted) {
        lines.push('All todos completed — list cleared.');
      }
      if (justCompleted.length > 0) {
        lines.push(
          `Verification reminder: ${justCompleted.length} item(s) just completed — confirm they actually work before reporting done.`,
        );
      }

      // Part 6: Update reactive app state if the context supports it.
      // When auto-clear fired (allCompleted), write [] to tasksState so the UI
      // does not retain a ghost list of completed items (split-state bug R7.5).
      if (typeof (ctx as any).setAppState === 'function') {
        try {
          (ctx as any).setAppState((prev: any) => ({
            ...prev,
            tasksState: allCompleted
              ? []
              : validated.map((t, i) => ({
                  ...t,
                  id: `todo-${sessionKey}-${i}`,
                })),
          }));
        } catch {
          /* setAppState is optional — swallow errors */
        }
      }

      // Part 2: Return both oldTodos and newTodos alongside the existing `todos` alias
      const newTodos = allCompleted ? [] : validated;
      return {
        oldTodos: previousList,
        newTodos,
        todos: newTodos, // backward-compat alias used by existing callers
        summary: lines.join('\n'),
      };
    },
    extractSearchText: (output: unknown) => {
      const o = output as { summary?: string };
      return o.summary ?? '';
    },
  });
}
