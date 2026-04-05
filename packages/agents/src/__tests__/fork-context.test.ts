import { describe, expect, test } from 'bun:test';
import { createForkContext } from '../fork-context';

describe('createForkContext', () => {
  test('clones parent permission/tool context snapshot', () => {
    const parent = {
      permissionMode: 'default' as const,
      allowedTools: new Set(['Read', 'Grep']),
      messages: [{ type: 'user', text: 'hi' }],
    };
    const fork = createForkContext(parent);
    // Mutate parent after fork
    parent.allowedTools.add('Bash');
    parent.messages.push({ type: 'assistant', text: 'late' });
    // Fork must NOT reflect post-fork mutations
    expect(fork.allowedTools.has('Bash')).toBe(false);
    expect(fork.messages).toHaveLength(1);
    expect(fork.permissionMode).toBe('default');
  });

  test('fork has independent message array identity', () => {
    const parent = { permissionMode: 'plan' as const, allowedTools: new Set<string>(), messages: [] as unknown[] };
    const fork = createForkContext(parent);
    expect(fork.messages).not.toBe(parent.messages);
  });

  test('fork has independent allowedTools Set identity', () => {
    const parent = { permissionMode: 'default' as const, allowedTools: new Set(['Read']), messages: [] as unknown[] };
    const fork = createForkContext(parent);
    expect(fork.allowedTools).not.toBe(parent.allowedTools);
    expect(fork.allowedTools.has('Read')).toBe(true);
  });

  test('preserves all permissionMode variants', () => {
    for (const mode of ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'dontAsk'] as const) {
      const parent = { permissionMode: mode, allowedTools: new Set<string>(), messages: [] as unknown[] };
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
});
