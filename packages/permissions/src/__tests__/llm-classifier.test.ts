import { describe, test, expect } from 'bun:test';
import { createLLMClassifier } from '../llm-classifier.js';

function makeRequest(toolName: string, input: Record<string, unknown> = {}) {
  return { toolName, input, toolUseId: 'test-id' };
}

describe('createLLMClassifier', () => {
  test('approves when response contains APPROVE', async () => {
    const provider = { classify: async () => 'APPROVE' };
    const classify = createLLMClassifier(provider);
    const result = await classify(makeRequest('Bash', { command: 'ls' }), {});
    expect(result?.approved).toBe(true);
    expect(result?.rationale).toContain('Bash');
  });

  test('denies when response contains DENY', async () => {
    const provider = { classify: async () => 'DENY' };
    const classify = createLLMClassifier(provider);
    const result = await classify(makeRequest('Bash', { command: 'rm -rf /' }), {});
    expect(result?.approved).toBe(false);
    expect(result?.rationale).toContain('Bash');
  });

  test('returns null on ambiguous response', async () => {
    const provider = { classify: async () => 'Maybe...' };
    const classify = createLLMClassifier(provider);
    const result = await classify(makeRequest('Read', {}), {});
    expect(result).toBeNull();
  });

  test('returns null on provider error', async () => {
    const provider = {
      classify: async (): Promise<string> => {
        throw new Error('API down');
      },
    };
    const classify = createLLMClassifier(provider);
    const result = await classify(makeRequest('Read', {}), {});
    expect(result).toBeNull();
  });

  test('passes read-only annotation into the prompt', async () => {
    let capturedPrompt = '';
    const provider = {
      classify: async (prompt: string) => {
        capturedPrompt = prompt;
        return 'APPROVE';
      },
    };
    const classify = createLLMClassifier(provider);
    await classify(
      { toolName: 'Read', input: {}, toolUseId: 'x', annotations: { readOnly: true } },
      {},
    );
    expect(capturedPrompt).toContain('read-only');
  });

  test('passes destructive annotation into the prompt', async () => {
    let capturedPrompt = '';
    const provider = {
      classify: async (prompt: string) => {
        capturedPrompt = prompt;
        return 'DENY';
      },
    };
    const classify = createLLMClassifier(provider);
    await classify(
      { toolName: 'Bash', input: { command: 'rm -rf /' }, toolUseId: 'x', annotations: { destructive: true } },
      {},
    );
    expect(capturedPrompt).toContain('WARNING');
  });

  test('includes recent user context in prompt', async () => {
    let capturedPrompt = '';
    const provider = {
      classify: async (prompt: string) => {
        capturedPrompt = prompt;
        return 'APPROVE';
      },
    };
    const classify = createLLMClassifier(provider);
    await classify(makeRequest('Glob', {}), {
      recentUserMessages: ['find all ts files', 'run tests', 'check types'],
    });
    expect(capturedPrompt).toContain('check types');
    // Only the last 3 messages should appear
    expect(capturedPrompt).toContain('run tests');
  });

  test('includes allowedPrompts in prompt', async () => {
    let capturedPrompt = '';
    const provider = {
      classify: async (prompt: string) => {
        capturedPrompt = prompt;
        return 'APPROVE';
      },
    };
    const classify = createLLMClassifier(provider);
    await classify(makeRequest('Bash', { command: 'bun test' }), {
      allowedPrompts: [{ tool: 'Bash', prompt: 'run the tests' }],
    });
    expect(capturedPrompt).toContain('run the tests');
  });

  test('handles case-insensitive APPROVE response', async () => {
    const provider = { classify: async () => 'approve' };
    const classify = createLLMClassifier(provider);
    const result = await classify(makeRequest('Read', {}), {});
    expect(result?.approved).toBe(true);
  });

  test('truncates large JSON inputs to 500 chars', async () => {
    let capturedPrompt = '';
    const provider = {
      classify: async (prompt: string) => {
        capturedPrompt = prompt;
        return 'APPROVE';
      },
    };
    const classify = createLLMClassifier(provider);
    const largeInput = { content: 'x'.repeat(2000) };
    await classify(makeRequest('Write', largeInput), {});
    // The JSON serialized input in the prompt should be truncated
    const inputSection = capturedPrompt.split('\n').find((l) => l.startsWith('Input:')) ?? '';
    expect(inputSection.length).toBeLessThanOrEqual('Input: '.length + 500);
  });
});
