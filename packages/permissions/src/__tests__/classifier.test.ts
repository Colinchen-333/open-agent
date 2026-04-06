import { describe, expect, test } from 'bun:test';
import { classifyPermissionRequest } from '../classifier';

describe('classifier', () => {
  test('approves readOnly tool via annotation', async () => {
    const decision = await classifyPermissionRequest(
      { toolName: 'Read', input: { file_path: '/tmp/x' }, toolUseId: 'test-1', annotations: { readOnly: true } },
      {},
    );
    expect(decision?.approved).toBe(true);
    expect(decision?.rationale).toContain('read-only');
  });

  test('does not approve destructive tool via annotation', async () => {
    const decision = await classifyPermissionRequest(
      { toolName: 'Write', input: { file_path: '/tmp/x', content: 'x' }, toolUseId: 'test-2', annotations: { destructive: true } },
      {},
    );
    expect(decision).toBeNull();
  });

  test('approves via allowedPrompt semantic match (all keywords present)', async () => {
    const decision = await classifyPermissionRequest(
      { toolName: 'Bash', input: { command: 'bun test packages/core/' }, toolUseId: 'test-3' },
      { allowedPrompts: [{ tool: 'Bash', prompt: 'run tests' }] },
    );
    expect(decision?.approved).toBe(true);
    expect(decision?.rationale).toContain('run tests');
  });

  test('does not approve via allowedPrompt when keywords missing', async () => {
    const decision = await classifyPermissionRequest(
      { toolName: 'Bash', input: { command: 'echo hi' }, toolUseId: 'test-4' },
      { allowedPrompts: [{ tool: 'Bash', prompt: 'run tests' }] },
    );
    expect(decision).toBeNull();
  });

  test('does not approve allowedPrompt with wrong tool', async () => {
    const decision = await classifyPermissionRequest(
      { toolName: 'Write', input: { file_path: '/tmp/x' }, toolUseId: 'test-5' },
      { allowedPrompts: [{ tool: 'Bash', prompt: 'run tests' }] },
    );
    expect(decision).toBeNull();
  });

  test('approves via explicit user approval phrase in recent message', async () => {
    const decision = await classifyPermissionRequest(
      { toolName: 'Bash', input: { command: 'any' }, toolUseId: 'test-6' },
      { recentUserMessages: ['yes proceed'] },
    );
    expect(decision?.approved).toBe(true);
    expect(decision?.rationale).toContain('approved');
  });

  test('approves on Chinese approval phrase', async () => {
    const decision = await classifyPermissionRequest(
      { toolName: 'Bash', input: { command: 'any' }, toolUseId: 'test-7' },
      { recentUserMessages: ['继续'] },
    );
    expect(decision?.approved).toBe(true);
  });

  test('returns null when no rule matches', async () => {
    const decision = await classifyPermissionRequest(
      { toolName: 'Bash', input: { command: 'rm -rf /' }, toolUseId: 'test-8' },
      { recentUserMessages: ['what do you think'] },
    );
    expect(decision).toBeNull();
  });

  test('LLM provider is called when no rule-based decision is made', async () => {
    let called = false;
    const decision = await classifyPermissionRequest(
      { toolName: 'Bash', input: { command: 'rm -rf /' }, toolUseId: 'test-llm-1' },
      {
        recentUserMessages: ['what do you think'],
        llmProvider: {
          classify: async () => {
            called = true;
            return 'DENY';
          },
        },
      },
    );
    expect(called).toBe(true);
    expect(decision?.approved).toBe(false);
  });

  test('LLM provider is NOT called when a rule-based decision already matched', async () => {
    let called = false;
    const decision = await classifyPermissionRequest(
      { toolName: 'Read', input: {}, toolUseId: 'test-llm-2', annotations: { readOnly: true } },
      {
        llmProvider: {
          classify: async () => {
            called = true;
            return 'DENY';
          },
        },
      },
    );
    // readOnly rule fires first — LLM should not be consulted
    expect(called).toBe(false);
    expect(decision?.approved).toBe(true);
  });
});
