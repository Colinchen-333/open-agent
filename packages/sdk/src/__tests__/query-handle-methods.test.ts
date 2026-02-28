import { describe, it, expect } from 'bun:test';
import { query } from '../query.js';

// ---------------------------------------------------------------------------
// initializationResult()
// ---------------------------------------------------------------------------

describe('query().initializationResult()', () => {
  it('returns the expected shape', async () => {
    const q = query('test', { model: 'claude-sonnet-4-6' });
    const result = await q.initializationResult();
    expect(result).toHaveProperty('tools');
    expect(result).toHaveProperty('model');
    expect(result).toHaveProperty('cwd');
    expect(result).toHaveProperty('sessionId');
    expect(result).toHaveProperty('permissionMode');
    expect(result).toHaveProperty('commands');
    expect(result).toHaveProperty('output_style');
    expect(result).toHaveProperty('available_output_styles');
    expect(result).toHaveProperty('models');
    expect(result).toHaveProperty('account');
    expect(Array.isArray(result.tools)).toBe(true);
    expect(typeof result.model).toBe('string');
    expect(typeof result.cwd).toBe('string');
    expect(typeof result.sessionId).toBe('string');
    expect(typeof result.permissionMode).toBe('string');
    q.close();
  });

  it('reflects the model passed in options', async () => {
    const q = query('test', { model: 'claude-haiku-4-5' });
    const result = await q.initializationResult();
    expect(result.model).toBe('claude-haiku-4-5');
    q.close();
  });

  it('reflects the cwd passed in options', async () => {
    const q = query('test', { model: 'claude-sonnet-4-6', cwd: '/tmp' });
    const result = await q.initializationResult();
    expect(result.cwd).toBe('/tmp');
    q.close();
  });

  it('reflects the sessionId passed in options', async () => {
    const q = query('test', { model: 'claude-sonnet-4-6', sessionId: 'test-session-123' });
    const result = await q.initializationResult();
    expect(result.sessionId).toBe('test-session-123');
    q.close();
  });

  it('returns a fresh copy each time (not the same reference)', async () => {
    const q = query('test', { model: 'claude-sonnet-4-6' });
    const a = await q.initializationResult();
    const b = await q.initializationResult();
    expect(a).not.toBe(b); // different object reference
    expect(a).toEqual(b);  // same values
    q.close();
  });
});

// ---------------------------------------------------------------------------
// stopTask()
// ---------------------------------------------------------------------------

describe('query().stopTask()', () => {
  it('aborts the internal abort controller', async () => {
    const ac = new AbortController();
    const q = query('test', { model: 'claude-sonnet-4-6', abortController: ac });
    expect(ac.signal.aborted).toBe(false);
    await q.stopTask('task-1');
    expect(ac.signal.aborted).toBe(true);
    q.close();
  });

  it('accepts an optional taskId parameter', async () => {
    const q = query('test', { model: 'claude-sonnet-4-6' });
    // Should not throw with or without taskId
    await q.stopTask('some-task-id');
    q.close();
  });
});

// ---------------------------------------------------------------------------
// close() abort behavior with caller-provided AbortController
// ---------------------------------------------------------------------------

describe('query().close()', () => {
  it('does not abort caller-provided AbortController', () => {
    const ac = new AbortController();
    const q = query('test', { model: 'claude-sonnet-4-6', abortController: ac });
    expect(ac.signal.aborted).toBe(false);
    q.close();
    expect(ac.signal.aborted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// reconnectMcpServer() / toggleMcpServer() — no MCP configured
// ---------------------------------------------------------------------------

describe('query() MCP methods without mcpServers', () => {
  it('reconnectMcpServer() throws when no MCP manager', async () => {
    const q = query('test', { model: 'claude-sonnet-4-6' });
    await expect(q.reconnectMcpServer('foo')).rejects.toThrow(/MCP/i);
    q.close();
  });

  it('toggleMcpServer() throws when no MCP manager', async () => {
    const q = query('test', { model: 'claude-sonnet-4-6' });
    await expect(q.toggleMcpServer('foo', false)).rejects.toThrow(/MCP/i);
    q.close();
  });

  it('setMcpServers({}) creates manager on the fly and returns empty result', async () => {
    const q = query('test', { model: 'claude-sonnet-4-6' });
    const result = await q.setMcpServers({});
    expect(result).toHaveProperty('added');
    expect(result).toHaveProperty('removed');
    expect(result).toHaveProperty('errors');
    expect(Array.isArray(result.added)).toBe(true);
    expect(Array.isArray(result.removed)).toBe(true);
    q.close();
  });
});

// ---------------------------------------------------------------------------
// rewindFiles()
// ---------------------------------------------------------------------------

describe('query().rewindFiles()', () => {
  it('returns false when file checkpointing is not enabled', async () => {
    const q = query('test', { model: 'claude-sonnet-4-6' });
    const result = await q.rewindFiles('some-tool-use-id');
    expect(result.canRewind).toBe(false);
    expect(Array.isArray(result.filesChanged)).toBe(true);
    q.close();
  });
});

// ---------------------------------------------------------------------------
// streamInput()
// ---------------------------------------------------------------------------

describe('query().streamInput()', () => {
  it('does not throw (logs warning to stderr)', async () => {
    const q = query('test', { model: 'claude-sonnet-4-6' });
    // Should not throw
    await q.streamInput('additional message');
    q.close();
  });

  it('accepts an async iterable input stream', async () => {
    const q = query('test', { model: 'claude-sonnet-4-6' });
    const stream = (async function* () {
      yield {
        type: 'user',
        message: 'hello',
        parent_tool_use_id: null,
        session_id: 's',
        uuid: 'u',
      } as any;
    })();
    await q.streamInput(stream);
    q.close();
  });
});

// ---------------------------------------------------------------------------
// canUseTool option
// ---------------------------------------------------------------------------

describe('query() with canUseTool option', () => {
  it('accepts a canUseTool callback without error', () => {
    const q = query('test', {
      model: 'claude-sonnet-4-6',
      canUseTool: (_tool, _input) => true,
    });
    expect(q).toBeDefined();
    q.close();
  });

  it('accepts a canUseTool callback that returns false', () => {
    const q = query('test', {
      model: 'claude-sonnet-4-6',
      canUseTool: () => false,
    });
    expect(q).toBeDefined();
    q.close();
  });
});

// ---------------------------------------------------------------------------
// permissionPromptToolName option
// ---------------------------------------------------------------------------

describe('query() with permissionPromptToolName option', () => {
  it('accepts the option without error', () => {
    const q = query('test', {
      model: 'claude-sonnet-4-6',
      permissionPromptToolName: 'mcp__my-server__permission_prompt',
    });
    expect(q).toBeDefined();
    q.close();
  });
});

// ---------------------------------------------------------------------------
// settingSources option
// ---------------------------------------------------------------------------

describe('query() with settingSources option', () => {
  it('accepts an empty array without error', () => {
    const q = query('test', {
      model: 'claude-sonnet-4-6',
      settingSources: [],
    });
    expect(q).toBeDefined();
    q.close();
  });

  it('accepts user-only sources', () => {
    const q = query('test', {
      model: 'claude-sonnet-4-6',
      settingSources: ['user'],
    });
    expect(q).toBeDefined();
    q.close();
  });

  it('accepts all sources', () => {
    const q = query('test', {
      model: 'claude-sonnet-4-6',
      settingSources: ['user', 'project', 'local'],
    });
    expect(q).toBeDefined();
    q.close();
  });
});
