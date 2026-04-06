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

  // ── Security: strict approval phrase checks ─────────────────────────────

  test('negation "do not continue" is NOT treated as approval', async () => {
    const decision = await classifyPermissionRequest(
      { toolName: 'Bash', input: { command: 'rm -rf /' }, toolUseId: 'sec-1' },
      { recentUserMessages: ['do not continue'] },
    );
    expect(decision).toBeNull();
  });

  test('negation "不要继续" is NOT treated as approval', async () => {
    const decision = await classifyPermissionRequest(
      { toolName: 'Bash', input: { command: 'rm -rf /' }, toolUseId: 'sec-2' },
      { recentUserMessages: ['不要继续'] },
    );
    expect(decision).toBeNull();
  });

  test('long message containing "yes" does NOT auto-approve', async () => {
    const longMessage =
      'I was reviewing the code and yes I think there might be an issue with the logic here';
    const decision = await classifyPermissionRequest(
      { toolName: 'Bash', input: { command: 'rm -rf /' }, toolUseId: 'sec-3' },
      { recentUserMessages: [longMessage] },
    );
    expect(decision).toBeNull();
  });

  test('"yes" exactly (short message) IS approved', async () => {
    const decision = await classifyPermissionRequest(
      { toolName: 'Bash', input: { command: 'echo hello' }, toolUseId: 'sec-4' },
      { recentUserMessages: ['yes'] },
    );
    expect(decision?.approved).toBe(true);
  });

  test('"好的" exactly IS approved', async () => {
    const decision = await classifyPermissionRequest(
      { toolName: 'Bash', input: { command: 'echo hello' }, toolUseId: 'sec-5' },
      { recentUserMessages: ['好的'] },
    );
    expect(decision?.approved).toBe(true);
  });

  test('"never stop" is NOT treated as approval despite containing no approval phrase', async () => {
    const decision = await classifyPermissionRequest(
      { toolName: 'Bash', input: { command: 'rm -rf /' }, toolUseId: 'sec-6' },
      { recentUserMessages: ['never stop'] },
    );
    expect(decision).toBeNull();
  });

  // ── Security: command-anchored allowedPrompts (privilege escalation fix) ──

  test('SECURITY: rm -rf ./tests does NOT match allowedPrompt "run tests"', async () => {
    // Classic privilege escalation: input contains "tests" as a path argument,
    // but the command is destructive.  Must NOT be approved.
    const decision = await classifyPermissionRequest(
      { toolName: 'Bash', input: { command: 'rm -rf ./tests' }, toolUseId: 'sec-pwn-1' },
      { allowedPrompts: [{ tool: 'Bash', prompt: 'run tests' }] },
    );
    expect(decision).toBeNull();
  });

  test('SECURITY: bun test packages/core/ IS approved by allowedPrompt "run tests"', async () => {
    const decision = await classifyPermissionRequest(
      { toolName: 'Bash', input: { command: 'bun test packages/core/' }, toolUseId: 'sec-pwn-2' },
      { allowedPrompts: [{ tool: 'Bash', prompt: 'run tests' }] },
    );
    expect(decision?.approved).toBe(true);
    expect(decision?.rationale).toContain('run tests');
  });

  test('SECURITY: npm install express IS approved by allowedPrompt "install dependencies"', async () => {
    const decision = await classifyPermissionRequest(
      { toolName: 'Bash', input: { command: 'npm install express' }, toolUseId: 'sec-pwn-3' },
      { allowedPrompts: [{ tool: 'Bash', prompt: 'install dependencies' }] },
    );
    expect(decision?.approved).toBe(true);
    expect(decision?.rationale).toContain('install dependencies');
  });

  test('SECURITY: rm -rf node_modules && npm install is NOT approved — first subcommand is destructive', async () => {
    // Even though the second subcommand matches "install dependencies", the first
    // subcommand (rm -rf) does not, so the whole chain must be rejected.
    const decision = await classifyPermissionRequest(
      {
        toolName: 'Bash',
        input: { command: 'rm -rf node_modules && npm install' },
        toolUseId: 'sec-pwn-4',
      },
      { allowedPrompts: [{ tool: 'Bash', prompt: 'install dependencies' }] },
    );
    expect(decision).toBeNull();
  });

  // ── Security: non-Bash allowedPrompts must be scoped to the target input ──

  test('SECURITY: Write /etc/passwd is NOT approved by allowedPrompt "update README"', async () => {
    // The prompt says "update README" but the file being written is /etc/passwd.
    // A bare tool-name match would approve this — the fix must NOT.
    const decision = await classifyPermissionRequest(
      {
        toolName: 'Write',
        input: { file_path: '/etc/passwd', content: 'malicious' },
        toolUseId: 'sec-write-1',
      },
      { allowedPrompts: [{ tool: 'Write', prompt: 'update README' }] },
    );
    expect(decision).toBeNull();
  });

  test('SECURITY: Write README.md IS approved by allowedPrompt "update README"', async () => {
    // The prompt term "readme" appears in the file path — this should be approved.
    const decision = await classifyPermissionRequest(
      {
        toolName: 'Write',
        input: { file_path: 'README.md', content: '# My Project' },
        toolUseId: 'sec-write-2',
      },
      { allowedPrompts: [{ tool: 'Write', prompt: 'update README' }] },
    );
    expect(decision?.approved).toBe(true);
    expect(decision?.rationale).toContain('update README');
  });
});
