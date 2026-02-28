import { describe, it, expect } from 'bun:test';

// We test the pure helper functions and construction logic that don't require
// a running LLM provider.  Full integration tests need mock providers and are
// covered in the core package.

// Import the module to verify exports compile correctly.
import { query } from '../query.js';

describe('query()', () => {
  it('is a function with the expected signature', () => {
    expect(typeof query).toBe('function');
  });
});

// --------------------------------------------------------------------------
// guessProviderFromModel — exercised via the module-private function.
// We verify indirectly by checking query() does not throw for known prefixes.
// --------------------------------------------------------------------------

describe('query() provider resolution (smoke)', () => {
  // We can't fully run query() without providers, but we can verify it doesn't
  // throw synchronously during setup for various model prefixes.
  // The actual API call will fail, but construction should succeed.

  it('accepts claude model prefix without throwing during setup', () => {
    // query() returns a Query synchronously, the async generator hasn't started.
    const q = query('test', { model: 'claude-sonnet-4-6' });
    expect(q).toBeDefined();
    expect(typeof q.interrupt).toBe('function');
    expect(typeof q.close).toBe('function');
    expect(typeof q.setModel).toBe('function');
    expect(typeof q.setPermissionMode).toBe('function');
    expect(typeof q.setMaxThinkingTokens).toBe('function');
    expect(typeof q.supportedCommands).toBe('function');
    expect(typeof q.supportedModels).toBe('function');
    expect(typeof q.mcpServerStatus).toBe('function');
    expect(typeof q.accountInfo).toBe('function');
    q.close();
  });

  it('accepts object-style call signature', () => {
    const q = query({ prompt: 'test', options: { model: 'claude-sonnet-4-6' } });
    expect(q).toBeDefined();
    q.close();
  });
});
