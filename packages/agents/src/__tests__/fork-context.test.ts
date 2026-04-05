import { describe, expect, test } from 'bun:test';
import { createForkContext, DEFAULT_CHILD_DIRECTIVE, type ForkableContext } from '../fork-context';

describe('createForkContext', () => {
  test('clones parent permission/tool context snapshot', () => {
    const parent: ForkableContext = {
      permissionMode: 'default',
      allowedTools: new Set(['Read', 'Grep']),
      messages: [{ role: 'user', content: 'hi' }],
    };
    const fork = createForkContext(parent);
    // Mutate parent after fork
    parent.allowedTools.add('Bash');
    parent.messages.push({ role: 'assistant', content: 'late' });
    // Fork must NOT reflect post-fork mutations
    expect(fork.allowedTools.has('Bash')).toBe(false);
    // fork.messages = [directive, original parent user msg]
    expect(fork.messages).toHaveLength(2);
    expect(fork.permissionMode).toBe('default');
  });

  test('fork has independent message array identity', () => {
    const parent: ForkableContext = { permissionMode: 'plan', allowedTools: new Set<string>(), messages: [] };
    const fork = createForkContext(parent);
    expect(fork.messages).not.toBe(parent.messages);
  });

  test('fork has independent allowedTools Set identity', () => {
    const parent: ForkableContext = { permissionMode: 'default', allowedTools: new Set(['Read']), messages: [] };
    const fork = createForkContext(parent);
    expect(fork.allowedTools).not.toBe(parent.allowedTools);
    expect(fork.allowedTools.has('Read')).toBe(true);
  });

  test('preserves all permissionMode variants', () => {
    for (const mode of ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'dontAsk'] as const) {
      const parent: ForkableContext = { permissionMode: mode, allowedTools: new Set<string>(), messages: [] };
      const fork = createForkContext(parent);
      expect(fork.permissionMode).toBe(mode);
    }
  });

  test('extra fields on parent are preserved through spread', () => {
    const parent = {
      permissionMode: 'default' as const,
      allowedTools: new Set<string>(),
      messages: [] as unknown[],
      agentType: 'coordinator',
    };
    const fork = createForkContext(parent as any);
    expect((fork as any).agentType).toBe('coordinator');
  });

  // ---------------------------------------------------------------------------
  // Cache-safe fork behaviors (R5.4)
  // ---------------------------------------------------------------------------

  test('prepends the default child directive as a system message', () => {
    const parent: ForkableContext = {
      permissionMode: 'default',
      allowedTools: new Set(['Read']),
      messages: [{ role: 'user', content: 'hello' }],
    };
    const fork = createForkContext(parent);
    const first = fork.messages[0] as any;
    expect(first.role).toBe('system');
    expect(first.content).toBe(DEFAULT_CHILD_DIRECTIVE);
    expect(first.content).toContain('forked subagent');
  });

  test('accepts a custom childDirective', () => {
    const parent: ForkableContext = {
      permissionMode: 'default',
      allowedTools: new Set(),
      messages: [],
    };
    const fork = createForkContext(parent, { childDirective: 'custom directive' });
    expect((fork.messages[0] as any).content).toBe('custom directive');
  });

  test('includes a worktree notice when cwd differs from parentCwd', () => {
    const parent: ForkableContext = {
      permissionMode: 'default',
      allowedTools: new Set(),
      messages: [],
      cwd: '/work/branch-a',
      parentCwd: '/work/main',
    };
    const fork = createForkContext(parent);
    // First msg = directive, second = worktree notice
    const notice = fork.messages[1] as any;
    expect(notice.role).toBe('system');
    expect(notice.content).toContain('worktree notice');
    expect(notice.content).toContain('/work/branch-a');
    expect(notice.content).toContain('/work/main');
  });

  test('omits worktree notice when cwd === parentCwd', () => {
    const parent: ForkableContext = {
      permissionMode: 'default',
      allowedTools: new Set(),
      messages: [],
      cwd: '/same',
      parentCwd: '/same',
    };
    const fork = createForkContext(parent);
    // Only directive, no worktree notice
    expect(fork.messages).toHaveLength(1);
  });

  test('omits worktree notice when includeWorktreeNotice is false', () => {
    const parent: ForkableContext = {
      permissionMode: 'default',
      allowedTools: new Set(),
      messages: [],
      cwd: '/work/branch-a',
      parentCwd: '/work/main',
    };
    const fork = createForkContext(parent, { includeWorktreeNotice: false });
    expect(fork.messages).toHaveLength(1);
  });

  test('synthesizes placeholder tool_result for orphaned tool_use', () => {
    const parent: ForkableContext = {
      permissionMode: 'default',
      allowedTools: new Set(['Bash']),
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'orphan-1', name: 'Bash', input: { command: 'ls' } },
          ],
        },
      ],
    };
    const fork = createForkContext(parent);
    // fork.messages = [directive, parent-assistant-with-tool-use, synthetic-tool-result]
    expect(fork.messages).toHaveLength(3);
    const last = fork.messages[2] as any;
    expect(last.role).toBe('user');
    expect(Array.isArray(last.content)).toBe(true);
    expect(last.content[0].type).toBe('tool_result');
    expect(last.content[0].tool_use_id).toBe('orphan-1');
    expect(last.content[0].content).toContain('forked');
    expect(last.content[0].is_error).toBe(false);
  });

  test('does NOT synthesize placeholder when tool_result is already present', () => {
    const parent: ForkableContext = {
      permissionMode: 'default',
      allowedTools: new Set(),
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/x' } }],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file contents' }],
        },
      ],
    };
    const fork = createForkContext(parent);
    // [directive, parent msgs...] — no synthetic placeholder
    expect(fork.messages).toHaveLength(3);
    // Last message is the existing tool_result, not a synthesized one
    const last = fork.messages[2] as any;
    expect(last.content[0].content).toBe('file contents');
  });

  test('synthesizes placeholders for multiple orphaned tool_use blocks', () => {
    const parent: ForkableContext = {
      permissionMode: 'default',
      allowedTools: new Set(['Bash', 'Read']),
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'x' } },
            { type: 'tool_use', id: 'b', name: 'Read', input: { file_path: '/y' } },
          ],
        },
      ],
    };
    const fork = createForkContext(parent);
    // fork.messages = [directive, parent-msg, synthetic-placeholder]
    expect(fork.messages).toHaveLength(3);
    const placeholder = fork.messages[2] as any;
    expect(placeholder.content).toHaveLength(2);
    const ids = placeholder.content.map((b: any) => b.tool_use_id).sort();
    expect(ids).toEqual(['a', 'b']);
  });

  test('synthesizes only for unmatched tool_use when some are resolved', () => {
    const parent: ForkableContext = {
      permissionMode: 'default',
      allowedTools: new Set(),
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'resolved', name: 'R', input: {} },
            { type: 'tool_use', id: 'orphan', name: 'R', input: {} },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'resolved', content: 'ok' }],
        },
      ],
    };
    const fork = createForkContext(parent);
    // fork.messages = [directive, assistant, user(resolved), synthetic(orphan)]
    expect(fork.messages).toHaveLength(4);
    const synthetic = fork.messages[3] as any;
    expect(synthetic.content).toHaveLength(1);
    expect(synthetic.content[0].tool_use_id).toBe('orphan');
  });
});
