import { describe, expect, test } from 'bun:test';
import { classifyPermissionRequest, SAFE_AUTO_APPROVE_TOOLS } from '../classifier';

// ────────────────────────────────────────────────────────────────────────────
// Safe-tool whitelist
// ────────────────────────────────────────────────────────────────────────────

describe('safe-tool whitelist', () => {
  test('Read → auto-approved without LLM call', async () => {
    let llmCalled = false;
    const decision = await classifyPermissionRequest(
      { toolName: 'Read', input: { file_path: '/tmp/x' }, toolUseId: 'wl-1' },
      {
        llmProvider: {
          classify: async () => {
            llmCalled = true;
            return 'BLOCK';
          },
        },
      },
    );
    expect(decision?.approved).toBe(true);
    expect(decision?.rationale).toContain('safe-tool whitelist');
    expect(llmCalled).toBe(false);
  });

  test('Grep → auto-approved without LLM call', async () => {
    const decision = await classifyPermissionRequest(
      { toolName: 'Grep', input: { pattern: 'foo' }, toolUseId: 'wl-2' },
      {},
    );
    expect(decision?.approved).toBe(true);
    expect(decision?.rationale).toContain('Grep');
  });

  test('Glob → auto-approved without LLM call', async () => {
    const decision = await classifyPermissionRequest(
      { toolName: 'Glob', input: { pattern: '**/*.ts' }, toolUseId: 'wl-3' },
      {},
    );
    expect(decision?.approved).toBe(true);
  });

  test('WebSearch → auto-approved without LLM call', async () => {
    const decision = await classifyPermissionRequest(
      { toolName: 'WebSearch', input: { query: 'typescript docs' }, toolUseId: 'wl-4' },
      {},
    );
    expect(decision?.approved).toBe(true);
  });

  test('WebFetch → auto-approved without LLM call', async () => {
    const decision = await classifyPermissionRequest(
      { toolName: 'WebFetch', input: { url: 'https://example.com' }, toolUseId: 'wl-5' },
      {},
    );
    expect(decision?.approved).toBe(true);
  });

  test('TodoWrite → auto-approved without LLM call', async () => {
    const decision = await classifyPermissionRequest(
      { toolName: 'TodoWrite', input: {}, toolUseId: 'wl-6' },
      {},
    );
    expect(decision?.approved).toBe(true);
  });

  test('AskUserQuestion → auto-approved without LLM call', async () => {
    const decision = await classifyPermissionRequest(
      { toolName: 'AskUserQuestion', input: {}, toolUseId: 'wl-7' },
      {},
    );
    expect(decision?.approved).toBe(true);
  });

  test('SAFE_AUTO_APPROVE_TOOLS export contains expected members', () => {
    expect(SAFE_AUTO_APPROVE_TOOLS.has('Read')).toBe(true);
    expect(SAFE_AUTO_APPROVE_TOOLS.has('Grep')).toBe(true);
    expect(SAFE_AUTO_APPROVE_TOOLS.has('Glob')).toBe(true);
    expect(SAFE_AUTO_APPROVE_TOOLS.has('TodoWrite')).toBe(true);
    // Bash is NOT whitelisted — it needs evaluation
    expect(SAFE_AUTO_APPROVE_TOOLS.has('Bash')).toBe(false);
    // Write is NOT whitelisted — it mutates files
    expect(SAFE_AUTO_APPROVE_TOOLS.has('Write')).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// readOnly annotation
// ────────────────────────────────────────────────────────────────────────────

describe('readOnly annotation', () => {
  test('custom tool with readOnly annotation → auto-approved, no LLM call', async () => {
    let llmCalled = false;
    const decision = await classifyPermissionRequest(
      {
        toolName: 'mcp__docs__lookup',
        input: { query: 'typescript' },
        toolUseId: 'ann-1',
        annotations: { readOnly: true },
      },
      {
        llmProvider: {
          classify: async () => {
            llmCalled = true;
            return 'BLOCK';
          },
        },
      },
    );
    expect(decision?.approved).toBe(true);
    expect(decision?.rationale).toContain('read-only tool annotation');
    expect(llmCalled).toBe(false);
  });

  test('tool with destructive annotation → falls through to LLM (annotation does not auto-deny)', async () => {
    let llmCalled = false;
    const decision = await classifyPermissionRequest(
      {
        toolName: 'CustomTool',
        input: {},
        toolUseId: 'ann-2',
        annotations: { destructive: true },
      },
      {
        llmProvider: {
          classify: async () => {
            llmCalled = true;
            return 'APPROVE';
          },
        },
      },
    );
    // destructive annotation does not block — only readOnly fast-paths
    expect(llmCalled).toBe(true);
    // LLM said APPROVE so it passes
    expect(decision?.approved).toBe(true);
  });

  test('tool without readOnly annotation → goes to LLM stage', async () => {
    let llmCalled = false;
    await classifyPermissionRequest(
      { toolName: 'Write', input: { file_path: '/tmp/x' }, toolUseId: 'ann-3' },
      {
        llmProvider: {
          classify: async () => {
            llmCalled = true;
            return 'APPROVE';
          },
        },
      },
    );
    expect(llmCalled).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// LLM classifier
// ────────────────────────────────────────────────────────────────────────────

describe('LLM classifier', () => {
  test('mock LLM returns "APPROVE" → approved', async () => {
    const decision = await classifyPermissionRequest(
      { toolName: 'Bash', input: { command: 'bun test' }, toolUseId: 'llm-1' },
      {
        llmProvider: { classify: async () => 'APPROVE' },
      },
    );
    expect(decision?.approved).toBe(true);
    expect(decision?.rationale).toContain('LLM classifier approved');
  });

  test('mock LLM returns "BLOCK" → denied', async () => {
    const decision = await classifyPermissionRequest(
      { toolName: 'Bash', input: { command: 'rm -rf /' }, toolUseId: 'llm-2' },
      {
        llmProvider: { classify: async () => 'BLOCK' },
      },
    );
    expect(decision?.approved).toBe(false);
    expect(decision?.rationale).toContain('LLM classifier blocked');
  });

  test('mock LLM returns multiline "BLOCK\\nReason: destructive" → denied with reason', async () => {
    const decision = await classifyPermissionRequest(
      { toolName: 'Bash', input: { command: 'rm -rf /' }, toolUseId: 'llm-3' },
      {
        llmProvider: { classify: async () => 'BLOCK\nReason: destructive command' },
      },
    );
    expect(decision?.approved).toBe(false);
    expect(decision?.rationale).toContain('LLM classifier blocked');
  });

  test('mock LLM returns multiline "APPROVE\\nLooks safe" → approved with reason', async () => {
    const decision = await classifyPermissionRequest(
      { toolName: 'Bash', input: { command: 'echo hello' }, toolUseId: 'llm-4' },
      {
        llmProvider: { classify: async () => 'APPROVE\nLooks safe to run' },
      },
    );
    expect(decision?.approved).toBe(true);
  });

  test('no LLM provider → null (pass through to user prompt)', async () => {
    const decision = await classifyPermissionRequest(
      { toolName: 'Bash', input: { command: 'rm -rf /' }, toolUseId: 'llm-5' },
      {},
    );
    expect(decision).toBeNull();
  });

  test('ambiguous LLM response → null (fail-safe pass-through)', async () => {
    const decision = await classifyPermissionRequest(
      { toolName: 'Bash', input: { command: 'echo hi' }, toolUseId: 'llm-6' },
      {
        llmProvider: { classify: async () => 'I am not sure about this one.' },
      },
    );
    expect(decision).toBeNull();
  });

  test('LLM provider throws → null (fail-safe pass-through)', async () => {
    const decision = await classifyPermissionRequest(
      { toolName: 'Bash', input: { command: 'echo hi' }, toolUseId: 'llm-7' },
      {
        llmProvider: {
          classify: async () => {
            throw new Error('provider unavailable');
          },
        },
      },
    );
    expect(decision).toBeNull();
  });

  test('"DISAPPROVE" does not match APPROVE (word-boundary safety)', async () => {
    const decision = await classifyPermissionRequest(
      { toolName: 'Bash', input: { command: 'echo hi' }, toolUseId: 'llm-8' },
      {
        llmProvider: { classify: async () => 'DISAPPROVE' },
      },
    );
    // "DISAPPROVE" contains APPROVE as a substring but should NOT match
    expect(decision).toBeNull();
  });

  test('"BLOCKADE" does not match BLOCK (word-boundary safety)', async () => {
    const decision = await classifyPermissionRequest(
      { toolName: 'Bash', input: { command: 'rm -rf /' }, toolUseId: 'llm-9' },
      {
        llmProvider: { classify: async () => 'BLOCKADE' },
      },
    );
    expect(decision).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Security: rm -rf ./tests with allowedPrompts "run tests"
// The LLM should block this — and without the LLM we confirm null (ask user)
// ────────────────────────────────────────────────────────────────────────────

describe('security: rm -rf ./tests with allowedPrompt "run tests"', () => {
  test('LLM that correctly blocks rm -rf → denied', async () => {
    // A real LLM would block this because "rm -rf ./tests" is destructive,
    // not a test runner. We simulate the correct LLM decision.
    const decision = await classifyPermissionRequest(
      { toolName: 'Bash', input: { command: 'rm -rf ./tests' }, toolUseId: 'sec-1' },
      {
        allowedPrompts: [{ tool: 'Bash', prompt: 'run tests' }],
        llmProvider: { classify: async () => 'BLOCK\nDestructive command does not match "run tests" intent' },
      },
    );
    expect(decision?.approved).toBe(false);
  });

  test('without LLM → null (user must approve, not auto-approved)', async () => {
    const decision = await classifyPermissionRequest(
      { toolName: 'Bash', input: { command: 'rm -rf ./tests' }, toolUseId: 'sec-2' },
      {
        allowedPrompts: [{ tool: 'Bash', prompt: 'run tests' }],
        // No llmProvider — no keyword matching can auto-approve this
      },
    );
    // Without LLM, non-whitelisted tool with no readOnly annotation → null
    expect(decision).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Security: bun test with allowedPrompts "run tests"
// The LLM should approve this
// ────────────────────────────────────────────────────────────────────────────

describe('security: bun test with allowedPrompt "run tests"', () => {
  test('LLM that correctly approves bun test → approved', async () => {
    const decision = await classifyPermissionRequest(
      { toolName: 'Bash', input: { command: 'bun test packages/core/' }, toolUseId: 'sec-3' },
      {
        allowedPrompts: [{ tool: 'Bash', prompt: 'run tests' }],
        llmProvider: { classify: async () => 'APPROVE\nMatches "run tests" intent' },
      },
    );
    expect(decision?.approved).toBe(true);
    expect(decision?.rationale).toContain('LLM classifier approved');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// LLM classifier receives allowedPrompts in its prompt context
// ────────────────────────────────────────────────────────────────────────────

describe('LLM receives context', () => {
  test('allowedPrompts are passed to LLM prompt text', async () => {
    let capturedPrompt = '';
    await classifyPermissionRequest(
      { toolName: 'Bash', input: { command: 'bun test' }, toolUseId: 'ctx-1' },
      {
        allowedPrompts: [{ tool: 'Bash', prompt: 'run tests' }],
        recentUserMessages: ['please run the tests'],
        llmProvider: {
          classify: async (prompt) => {
            capturedPrompt = prompt;
            return 'APPROVE';
          },
        },
      },
    );
    // Verify the LLM prompt contains the allowedPrompts as semantic hints
    expect(capturedPrompt).toContain('run tests');
    expect(capturedPrompt).toContain('Pre-approved intents');
    // Verify recent user messages are included
    expect(capturedPrompt).toContain('please run the tests');
  });

  test('tool input is included in LLM prompt', async () => {
    let capturedPrompt = '';
    await classifyPermissionRequest(
      { toolName: 'Write', input: { file_path: '/tmp/out.txt', content: 'hello' }, toolUseId: 'ctx-2' },
      {
        llmProvider: {
          classify: async (prompt) => {
            capturedPrompt = prompt;
            return 'APPROVE';
          },
        },
      },
    );
    expect(capturedPrompt).toContain('Write');
    expect(capturedPrompt).toContain('/tmp/out.txt');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Stage ordering: whitelist > annotation > LLM
// ────────────────────────────────────────────────────────────────────────────

describe('stage ordering', () => {
  test('whitelisted tool skips annotation and LLM stages entirely', async () => {
    // Read is whitelisted, so even a destructive annotation + blocking LLM
    // should not change the outcome.
    let llmCalled = false;
    const decision = await classifyPermissionRequest(
      {
        toolName: 'Read',
        input: { file_path: '/etc/passwd' },
        toolUseId: 'ord-1',
        annotations: { destructive: true },
      },
      {
        llmProvider: {
          classify: async () => {
            llmCalled = true;
            return 'BLOCK';
          },
        },
      },
    );
    expect(decision?.approved).toBe(true);
    expect(llmCalled).toBe(false);
  });

  test('non-whitelisted readOnly tool skips LLM', async () => {
    let llmCalled = false;
    const decision = await classifyPermissionRequest(
      {
        toolName: 'mcp__custom__tool',
        input: {},
        toolUseId: 'ord-2',
        annotations: { readOnly: true },
      },
      {
        llmProvider: {
          classify: async () => {
            llmCalled = true;
            return 'BLOCK';
          },
        },
      },
    );
    expect(decision?.approved).toBe(true);
    expect(llmCalled).toBe(false);
  });

  test('non-whitelisted non-readOnly tool goes to LLM', async () => {
    let llmCalled = false;
    await classifyPermissionRequest(
      { toolName: 'Bash', input: { command: 'echo hi' }, toolUseId: 'ord-3' },
      {
        llmProvider: {
          classify: async () => {
            llmCalled = true;
            return 'APPROVE';
          },
        },
      },
    );
    expect(llmCalled).toBe(true);
  });
});
