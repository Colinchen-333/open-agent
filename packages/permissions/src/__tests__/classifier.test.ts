import { describe, expect, test } from 'bun:test';
import { classifyPermissionRequest } from '../classifier';

describe('classifier', () => {
  test('approves readOnly tool via annotation', () => {
    const decision = classifyPermissionRequest(
      { toolName: 'Read', input: { file_path: '/tmp/x' }, toolUseId: 'test-1', annotations: { readOnly: true } },
      {},
    );
    expect(decision?.approved).toBe(true);
    expect(decision?.rationale).toContain('read-only');
  });

  test('does not approve destructive tool via annotation', () => {
    const decision = classifyPermissionRequest(
      { toolName: 'Write', input: { file_path: '/tmp/x', content: 'x' }, toolUseId: 'test-2', annotations: { destructive: true } },
      {},
    );
    expect(decision).toBeNull();
  });

  test('approves via allowedPrompt semantic match (all keywords present)', () => {
    const decision = classifyPermissionRequest(
      { toolName: 'Bash', input: { command: 'bun test packages/core/' }, toolUseId: 'test-3' },
      { allowedPrompts: [{ tool: 'Bash', prompt: 'run tests' }] },
    );
    expect(decision?.approved).toBe(true);
    expect(decision?.rationale).toContain('run tests');
  });

  test('does not approve via allowedPrompt when keywords missing', () => {
    const decision = classifyPermissionRequest(
      { toolName: 'Bash', input: { command: 'echo hi' }, toolUseId: 'test-4' },
      { allowedPrompts: [{ tool: 'Bash', prompt: 'run tests' }] },
    );
    expect(decision).toBeNull();
  });

  test('does not approve allowedPrompt with wrong tool', () => {
    const decision = classifyPermissionRequest(
      { toolName: 'Write', input: { file_path: '/tmp/x' }, toolUseId: 'test-5' },
      { allowedPrompts: [{ tool: 'Bash', prompt: 'run tests' }] },
    );
    expect(decision).toBeNull();
  });

  test('approves via explicit user approval phrase in recent message', () => {
    const decision = classifyPermissionRequest(
      { toolName: 'Bash', input: { command: 'any' }, toolUseId: 'test-6' },
      { recentUserMessages: ['yes proceed'] },
    );
    expect(decision?.approved).toBe(true);
    expect(decision?.rationale).toContain('approved');
  });

  test('approves on Chinese approval phrase', () => {
    const decision = classifyPermissionRequest(
      { toolName: 'Bash', input: { command: 'any' }, toolUseId: 'test-7' },
      { recentUserMessages: ['继续'] },
    );
    expect(decision?.approved).toBe(true);
  });

  test('returns null when no rule matches', () => {
    const decision = classifyPermissionRequest(
      { toolName: 'Bash', input: { command: 'rm -rf /' }, toolUseId: 'test-8' },
      { recentUserMessages: ['what do you think'] },
    );
    expect(decision).toBeNull();
  });
});
