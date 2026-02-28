import { describe, it, expect } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SessionManager } from '@open-agent/core';
import { query } from '../query.js';
import { createSdkMcpServer, tool } from '../mcp-helpers.js';

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
    expect(result).toHaveProperty('agents');
    expect(result).toHaveProperty('fast_mode_state');
    expect(Array.isArray(result.tools)).toBe(true);
    expect(typeof result.model).toBe('string');
    expect(typeof result.cwd).toBe('string');
    expect(typeof result.sessionId).toBe('string');
    expect(typeof result.permissionMode).toBe('string');
    expect(Array.isArray(result.agents)).toBe(true);
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
  it('does not abort caller-provided AbortController', async () => {
    const ac = new AbortController();
    const q = query('test', { model: 'claude-sonnet-4-6', abortController: ac });
    expect(ac.signal.aborted).toBe(false);
    await q.stopTask();
    expect(ac.signal.aborted).toBe(false);
    q.close();
  });

  it('accepts optional taskId parameter', async () => {
    const q = query('test', { model: 'claude-sonnet-4-6' });
    // Should not throw with or without taskId
    await q.stopTask();
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
  it('mcpServerStatus() returns empty array when no MCP manager', async () => {
    const q = query('test', { model: 'claude-sonnet-4-6' });
    const status = await q.mcpServerStatus();
    expect(status).toEqual([]);
    q.close();
  });

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

describe('query() MCP status shape', () => {
  it('initializationResult waits for MCP tools and mcpServerStatus returns official-like shape', async () => {
    const server = createSdkMcpServer({
      name: 'sdk-test',
      tools: [
        tool(
          'echo_status',
          'Echoes input status',
          { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
          async ({ text }: { text: string }) => text,
        ) as any,
      ],
    });

    const q = query('test', {
      model: 'claude-sonnet-4-6',
      mcpServers: {
        sdk_test: server as any,
      },
    });

    const init = await q.initializationResult();
    expect(init.tools).toContain('echo_status');

    const status = await q.mcpServerStatus();
    expect(status.length).toBe(1);
    expect(status[0].name).toBe('sdk_test');
    expect(status[0].status).toBe('connected');
    expect(status[0]).toHaveProperty('config');
    expect(status[0]).toHaveProperty('scope');
    expect(Array.isArray(status[0].tools)).toBe(true);
    expect(status[0].tools?.[0]?.name).toBe('echo_status');

    await q.toggleMcpServer('sdk_test', false);
    const disabled = await q.mcpServerStatus();
    expect(disabled[0].status).toBe('disabled');
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
    expect(result.error).toMatch(/not enabled/i);
    expect(result.filesChanged).toBeUndefined();
    q.close();
  });

  it('returns checkpoint-not-found when checkpointing is enabled but id is missing', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'open-agent-rewind-missing-'));
    const q = query('test', {
      model: 'claude-sonnet-4-6',
      cwd,
      sessionId: 'rewind-missing-session',
      enableFileCheckpointing: true,
    });
    const result = await q.rewindFiles('missing-tool-use-id');
    expect(result.canRewind).toBe(false);
    expect(result.error).toMatch(/checkpoint not found/i);
    q.close();
  });

  it('supports dryRun and actual rewind when checkpoints exist on disk', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'open-agent-rewind-dryrun-'));
    const sessionId = 'rewind-dryrun-session';
    const targetFile = join(cwd, 'demo.txt');
    writeFileSync(targetFile, 'after', 'utf-8');

    const sm = new SessionManager();
    const sessionDir = sm.getSessionDir(cwd, sessionId);
    const checkpointDir = join(sessionDir, 'checkpoints');
    mkdirSync(checkpointDir, { recursive: true });
    writeFileSync(
      join(checkpointDir, 'checkpoint-1.json'),
      JSON.stringify({
        toolUseId: 'tool-use-1',
        filePath: targetFile,
        originalContent: 'before',
        timestamp: Date.now(),
      }),
      'utf-8',
    );

    const q = query('test', {
      model: 'claude-sonnet-4-6',
      cwd,
      sessionId,
      enableFileCheckpointing: true,
    });

    const preview = await q.rewindFiles('tool-use-1', { dryRun: true });
    expect(preview.canRewind).toBe(true);
    expect(preview.filesChanged).toEqual([targetFile]);

    const applied = await q.rewindFiles('tool-use-1');
    expect(applied.canRewind).toBe(true);
    expect(applied.filesChanged).toEqual([targetFile]);
    expect(readFileSync(targetFile, 'utf-8')).toBe('before');
    q.close();
  });
});

// ---------------------------------------------------------------------------
// streamInput()
// ---------------------------------------------------------------------------

describe('query().streamInput()', () => {
  it('throws on non-stream prompt mode', async () => {
    const q = query('test', { model: 'claude-sonnet-4-6' });
    await expect(q.streamInput('additional message')).rejects.toThrow(/async-iterable/i);
    q.close();
  });

  it('accepts an async iterable input stream', async () => {
    const initialPrompt = (async function* () {
      // keep empty so the query stays in async-iterable mode without running a provider call
    })();
    const q = query({ prompt: initialPrompt, options: { model: 'claude-sonnet-4-6' } });
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
