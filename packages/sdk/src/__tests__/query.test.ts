import { describe, it, expect } from 'bun:test';

// We test the pure helper functions and construction logic that don't require
// a running LLM provider.  Full integration tests need mock providers and are
// covered in the core package.

// Import the module to verify exports compile correctly.
import { query } from '../query.js';

// ---------------------------------------------------------------------------
// supportedCommands() — verify the slash command list
// ---------------------------------------------------------------------------

describe('query().supportedCommands()', () => {
  it('returns an array of 22 commands', async () => {
    const q = query('test', { model: 'claude-sonnet-4-6' });
    const commands = await q.supportedCommands();
    expect(Array.isArray(commands)).toBe(true);
    expect(commands).toHaveLength(22);
    q.close();
  });

  it('every command has name, description, and argumentHint fields', async () => {
    const q = query('test', { model: 'claude-sonnet-4-6' });
    const commands = await q.supportedCommands();
    for (const cmd of commands) {
      expect(typeof cmd.name).toBe('string');
      expect(typeof cmd.description).toBe('string');
      expect(typeof cmd.argumentHint).toBe('string');
    }
    q.close();
  });

  it('all command names start with /', async () => {
    const q = query('test', { model: 'claude-sonnet-4-6' });
    const commands = await q.supportedCommands();
    for (const cmd of commands) {
      expect(cmd.name.startsWith('/')).toBe(true);
    }
    q.close();
  });

  it('includes known commands: /help, /model, /exit', async () => {
    const q = query('test', { model: 'claude-sonnet-4-6' });
    const commands = await q.supportedCommands();
    const names = commands.map(c => c.name);
    expect(names).toContain('/help');
    expect(names).toContain('/model');
    expect(names).toContain('/exit');
    q.close();
  });
});

describe('query().supportedAgents()', () => {
  it('returns at least one built-in agent descriptor', async () => {
    const q = query('test', { model: 'claude-sonnet-4-6' });
    const agents = await q.supportedAgents();
    expect(Array.isArray(agents)).toBe(true);
    expect(agents.length).toBeGreaterThan(0);
    expect(typeof agents[0].name).toBe('string');
    q.close();
  });

  it('includes canonical built-in agent names', async () => {
    const q = query('test', { model: 'claude-sonnet-4-6' });
    const agents = await q.supportedAgents();
    const names = new Set(agents.map((a) => a.name));
    expect(names.has('Explore')).toBe(true);
    expect(names.has('Plan')).toBe(true);
    expect(names.has('Bash')).toBe(true);
    q.close();
  });

  it('merges custom agents from options.agents', async () => {
    const q = query('test', {
      model: 'claude-sonnet-4-6',
      agents: {
        custom_main: {
          description: 'Custom main-thread agent',
          prompt: 'Be precise.',
          model: 'sonnet',
        },
      },
    });
    const agents = await q.supportedAgents();
    expect(agents.some((a) => a.name === 'custom_main')).toBe(true);
    q.close();
  });
});

describe('query() agent selection', () => {
  it('throws when options.agent does not exist', () => {
    expect(() =>
      query('test', {
        model: 'claude-sonnet-4-6',
        agent: 'non-existent-agent',
      }),
    ).toThrow(/not found/i);
  });

  it('accepts built-in agent names case-insensitively', () => {
    const q = query('test', {
      model: 'claude-sonnet-4-6',
      agent: 'explore',
    });
    expect(q).toBeDefined();
    q.close();
  });
});

// ---------------------------------------------------------------------------
// accountInfo() — verify apiKeySource determination
// ---------------------------------------------------------------------------

describe('query().accountInfo()', () => {
  it('returns "direct" apiKeySource when options.apiKey is provided', async () => {
    const q = query('test', { model: 'claude-sonnet-4-6', apiKey: 'sk-test-key' });
    const info = await q.accountInfo();
    expect(info.apiKeySource).toBe('direct');
    q.close();
  });

  it('returns "env_override" when env contains an API_KEY key', async () => {
    const q = query('test', {
      model: 'claude-sonnet-4-6',
      env: { TEST_API_KEY: 'override-value' },
    });
    const info = await q.accountInfo();
    expect(info.apiKeySource).toBe('env_override');
    q.close();
  });

  it('accountInfo returns tokenSource and organization fields', async () => {
    const q = query('test', { model: 'claude-sonnet-4-6', apiKey: 'sk-abc' });
    const info = await q.accountInfo();
    expect(typeof info.tokenSource).toBe('string');
    expect(typeof info.organization).toBe('string');
    q.close();
  });
});

describe('query() env/debug lifecycle', () => {
  it('restores env overrides on close() even when not iterated', () => {
    const originalFoo = process.env.SDK_ENV_RESTORE_TEST;
    const q = query('test', {
      model: 'claude-sonnet-4-6',
      env: { SDK_ENV_RESTORE_TEST: 'temporary-value' },
    });
    expect(process.env.SDK_ENV_RESTORE_TEST).toBe('temporary-value');
    q.close();
    expect(process.env.SDK_ENV_RESTORE_TEST).toBe(originalFoo);
  });

  it('restores DEBUG after debug=true + close() without iteration', () => {
    const originalDebug = process.env.DEBUG;
    const q = query('test', { model: 'claude-sonnet-4-6', debug: true });
    expect(process.env.DEBUG).toContain('open-agent:*');
    q.close();
    expect(process.env.DEBUG).toBe(originalDebug);
  });

  it('restores env overrides on interrupt() even when not iterated', async () => {
    const originalFoo = process.env.SDK_ENV_INTERRUPT_RESTORE_TEST;
    const q = query('test', {
      model: 'claude-sonnet-4-6',
      env: { SDK_ENV_INTERRUPT_RESTORE_TEST: 'temporary-value' },
    });
    expect(process.env.SDK_ENV_INTERRUPT_RESTORE_TEST).toBe('temporary-value');
    await q.interrupt();
    expect(process.env.SDK_ENV_INTERRUPT_RESTORE_TEST).toBe(originalFoo);
  });

  it('restores env overrides on stopTask() even when not iterated', async () => {
    const originalFoo = process.env.SDK_ENV_STOP_RESTORE_TEST;
    const q = query('test', {
      model: 'claude-sonnet-4-6',
      env: { SDK_ENV_STOP_RESTORE_TEST: 'temporary-value' },
    });
    expect(process.env.SDK_ENV_STOP_RESTORE_TEST).toBe('temporary-value');
    await q.stopTask('task-1');
    expect(process.env.SDK_ENV_STOP_RESTORE_TEST).toBe(originalFoo);
  });
});

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
    expect(typeof q.supportedAgents).toBe('function');
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
