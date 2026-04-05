import { describe, expect, test } from 'bun:test';
import {
  createForkContext,
  DEFAULT_CHILD_DIRECTIVE,
  findOrphanedToolUseIds,
  type ForkableContext,
} from '../fork-context';

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
    // fork.messages = [original parent user msg, directive user msg]
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
  // Cache-stable fork behaviors (R6.3)
  // The directive is now the LAST message (role: 'user'), not a leading system msg.
  // ---------------------------------------------------------------------------

  test('appends the default child directive as the last user message text block', () => {
    const parent: ForkableContext = {
      permissionMode: 'default',
      allowedTools: new Set(['Read']),
      messages: [{ role: 'user', content: 'hello' }],
    };
    const fork = createForkContext(parent);
    // The directive is the LAST message, not the first
    const last = fork.messages[fork.messages.length - 1] as any;
    expect(last.role).toBe('user');
    expect(Array.isArray(last.content)).toBe(true);
    // The text block is the final block in the content array
    const textBlock = last.content[last.content.length - 1];
    expect(textBlock.type).toBe('text');
    expect(textBlock.text).toBe(DEFAULT_CHILD_DIRECTIVE);
    expect(textBlock.text).toContain('forked subagent');
  });

  test('accepts a custom childDirective', () => {
    const parent: ForkableContext = {
      permissionMode: 'default',
      allowedTools: new Set(),
      messages: [],
    };
    const fork = createForkContext(parent, { childDirective: 'custom directive' });
    const last = fork.messages[fork.messages.length - 1] as any;
    expect(last.role).toBe('user');
    const textBlock = last.content[last.content.length - 1];
    expect(textBlock.type).toBe('text');
    expect(textBlock.text).toBe('custom directive');
  });

  test('includes a worktree notice in the directive text block when cwd differs from parentCwd', () => {
    const parent: ForkableContext = {
      permissionMode: 'default',
      allowedTools: new Set(),
      messages: [],
      cwd: '/work/branch-a',
      parentCwd: '/work/main',
    };
    const fork = createForkContext(parent);
    // Only ONE extra message is appended (the directive user message)
    expect(fork.messages).toHaveLength(1);
    const last = fork.messages[fork.messages.length - 1] as any;
    expect(last.role).toBe('user');
    const textBlock = last.content[last.content.length - 1];
    expect(textBlock.type).toBe('text');
    expect(textBlock.text).toContain('worktree notice');
    expect(textBlock.text).toContain('/work/branch-a');
    expect(textBlock.text).toContain('/work/main');
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
    // Only the directive user message appended; no extra system messages
    expect(fork.messages).toHaveLength(1);
    const last = fork.messages[0] as any;
    const textBlock = last.content[last.content.length - 1];
    expect(textBlock.text).not.toContain('worktree notice');
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
    // Only the directive user message, no worktree text
    expect(fork.messages).toHaveLength(1);
    const last = fork.messages[0] as any;
    const textBlock = last.content[last.content.length - 1];
    expect(textBlock.text).not.toContain('worktree notice');
  });

  test('synthesizes placeholder tool_result for orphaned tool_use in the directive message', () => {
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
    // fork.messages = [parent-assistant-with-tool-use, directive-user-msg]
    expect(fork.messages).toHaveLength(2);
    const last = fork.messages[1] as any;
    expect(last.role).toBe('user');
    expect(Array.isArray(last.content)).toBe(true);
    // First block is the tool_result placeholder; last block is the text directive
    expect(last.content[0].type).toBe('tool_result');
    expect(last.content[0].tool_use_id).toBe('orphan-1');
    expect(last.content[0].content).toContain('forked');
    expect(last.content[0].is_error).toBe(false);
    expect(last.content[last.content.length - 1].type).toBe('text');
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
    // [parent-assistant, parent-user(tool_result), directive-user-msg]
    expect(fork.messages).toHaveLength(3);
    // The directive user message has only the text block (no placeholder tool_results)
    const last = fork.messages[2] as any;
    expect(last.role).toBe('user');
    expect(last.content).toHaveLength(1);
    expect(last.content[0].type).toBe('text');
  });

  test('synthesizes placeholders for multiple orphaned tool_use blocks in the directive message', () => {
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
    // [parent-assistant-msg, directive-user-msg]
    expect(fork.messages).toHaveLength(2);
    const last = fork.messages[1] as any;
    // 2 tool_result placeholders + 1 text directive block
    expect(last.content).toHaveLength(3);
    const placeholderIds = last.content
      .filter((b: any) => b.type === 'tool_result')
      .map((b: any) => b.tool_use_id)
      .sort();
    expect(placeholderIds).toEqual(['a', 'b']);
    expect(last.content[last.content.length - 1].type).toBe('text');
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
    // [parent-assistant, parent-user(resolved), directive-user-msg]
    expect(fork.messages).toHaveLength(3);
    const last = fork.messages[2] as any;
    // 1 placeholder for 'orphan' + 1 text block
    expect(last.content).toHaveLength(2);
    expect(last.content[0].type).toBe('tool_result');
    expect(last.content[0].tool_use_id).toBe('orphan');
    expect(last.content[1].type).toBe('text');
  });

  test('no system messages are inserted into the message array', () => {
    const parent: ForkableContext = {
      permissionMode: 'default',
      allowedTools: new Set(),
      messages: [{ role: 'user', content: 'start' }, { role: 'assistant', content: 'ok' }],
      cwd: '/work/branch',
      parentCwd: '/work/main',
    };
    const fork = createForkContext(parent);
    for (const msg of fork.messages) {
      expect((msg as any).role).not.toBe('system');
    }
  });

  test('parent messages are left byte-identical (not mutated or reordered)', () => {
    const parentMsgs = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' },
    ];
    const parent: ForkableContext = {
      permissionMode: 'default',
      allowedTools: new Set(),
      messages: parentMsgs,
    };
    const fork = createForkContext(parent);
    // The first two messages in the fork must be the exact same objects
    expect(fork.messages[0]).toBe(parentMsgs[0]);
    expect(fork.messages[1]).toBe(parentMsgs[1]);
  });
});

// ---------------------------------------------------------------------------
// findOrphanedToolUseIds unit tests
// ---------------------------------------------------------------------------

describe('findOrphanedToolUseIds', () => {
  test('returns empty array when no tool_use blocks exist', () => {
    const msgs = [{ role: 'user', content: 'hi' }];
    expect(findOrphanedToolUseIds(msgs)).toEqual([]);
  });

  test('returns empty array when all tool_use blocks are resolved', () => {
    const msgs = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'x', name: 'T', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'done' }] },
    ];
    expect(findOrphanedToolUseIds(msgs)).toEqual([]);
  });

  test('returns orphan ids', () => {
    const msgs = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'orphan', name: 'T', input: {} }] },
    ];
    expect(findOrphanedToolUseIds(msgs)).toContain('orphan');
  });

  test('handles mixed resolved and orphan blocks', () => {
    const msgs = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'r', name: 'T', input: {} },
          { type: 'tool_use', id: 'o', name: 'T', input: {} },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'r', content: 'ok' }] },
    ];
    const orphans = findOrphanedToolUseIds(msgs);
    expect(orphans).toContain('o');
    expect(orphans).not.toContain('r');
  });
});
