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
    expect(result).toHaveProperty('commands');
    expect(result).toHaveProperty('agents');
    expect(result).toHaveProperty('output_style');
    expect(result).toHaveProperty('available_output_styles');
    expect(result).toHaveProperty('models');
    expect(result).toHaveProperty('account');
    if ('fast_mode_state' in result) {
      expect((result as any).fast_mode_state).toBeUndefined();
    }
    expect(Array.isArray(result.commands)).toBe(true);
    expect(Array.isArray(result.agents)).toBe(true);
    expect(Array.isArray(result.available_output_styles)).toBe(true);
    expect(typeof result.output_style).toBe('string');
    q.close();
  });

  it('returns official-style initialization keys only', async () => {
    const q = query('test', { model: 'claude-haiku-4-5' });
    const result = await q.initializationResult();
    const keys = Object.keys(result);
    expect(keys).toEqual(expect.arrayContaining([
      'account',
      'agents',
      'available_output_styles',
      'commands',
      'models',
      'output_style',
    ]));
    const allowedKeys = new Set([
      'account',
      'agents',
      'available_output_styles',
      'commands',
      'models',
      'output_style',
      'fast_mode_state',
    ]);
    expect(keys.every((k) => allowedKeys.has(k))).toBe(true);
    expect((result as any).model).toBeUndefined();
    expect((result as any).cwd).toBeUndefined();
    expect((result as any).sessionId).toBeUndefined();
    expect((result as any).permissionMode).toBeUndefined();
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
    await q.stopTask('task-1');
    expect(ac.signal.aborted).toBe(false);
    q.close();
  });

  it('accepts required taskId parameter', async () => {
    const q = query('test', { model: 'claude-sonnet-4-6' });
    // Should not throw with taskId
    await q.stopTask('task-1');
    await q.stopTask('some-task-id');
    q.close();
  });
});

describe('query().interrupt()', () => {
  it('aborts caller-provided AbortController', async () => {
    const ac = new AbortController();
    const q = query('test', { model: 'claude-sonnet-4-6', abortController: ac });
    expect(ac.signal.aborted).toBe(false);
    await q.interrupt();
    expect(ac.signal.aborted).toBe(true);
    q.close();
  });

  it('is idempotent when called multiple times', async () => {
    const ac = new AbortController();
    const q = query('test', { model: 'claude-sonnet-4-6', abortController: ac });
    await q.interrupt();
    await q.interrupt();
    expect(ac.signal.aborted).toBe(true);
    q.close();
  });
});

describe('query().setPermissionMode()', () => {
  it('rejects bypassPermissions at runtime without allowDangerouslySkipPermissions', async () => {
    const q = query('test', { model: 'claude-sonnet-4-6' });
    await expect(q.setPermissionMode('bypassPermissions')).rejects.toThrow(
      /allowDangerouslySkipPermissions/i,
    );
    q.close();
  });

  it('allows bypassPermissions at runtime when allowDangerouslySkipPermissions=true', async () => {
    const q = query('test', {
      model: 'claude-sonnet-4-6',
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
    });
    await expect(q.setPermissionMode('bypassPermissions')).resolves.toBeUndefined();
    q.close();
  });
});

describe('query() runtime setter validation', () => {
  it('setModel rejects empty string', async () => {
    const q = query('test', { model: 'claude-sonnet-4-6' });
    await expect(q.setModel('')).rejects.toThrow(/non-empty model string/i);
    await expect(q.setModel('   ' as any)).rejects.toThrow(/non-empty model string/i);
    q.close();
  });

  it('setMaxThinkingTokens rejects non-positive values', async () => {
    const q = query('test', { model: 'claude-sonnet-4-6' });
    await expect(q.setMaxThinkingTokens(0)).rejects.toThrow(/positive finite number/i);
    await expect(q.setMaxThinkingTokens(-1)).rejects.toThrow(/positive finite number/i);
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
    expect(Array.isArray(init.commands)).toBe(true);

    const status = await q.mcpServerStatus();
    expect(status.length).toBe(1);
    expect(status[0].name).toBe('sdk_test');
    expect(status[0].status).toBe('connected');
    expect(status[0]).toHaveProperty('config');
    expect((status[0] as any).config?.type).toBe('sdk');
    expect(Array.isArray(status[0].tools)).toBe(true);
    expect(status[0].tools?.[0]?.name).toBe('echo_status');

    await q.toggleMcpServer('sdk_test', false);
    const disabled = await q.mcpServerStatus();
    expect(disabled[0].status).toBe('disabled');
    q.close();
  });

  it('normalizes stdio config without explicit type in mcpServerStatus', async () => {
    const q = query('test', {
      model: 'claude-sonnet-4-6',
      mcpServers: {
        bad_stdio: {
          command: '__definitely_missing_mcp_binary__',
          args: ['--version'],
        } as any,
      },
    });

    await q.initializationResult();
    const status = await q.mcpServerStatus();
    expect(status).toHaveLength(1);
    expect((status[0] as any).config?.type).toBe('stdio');
    expect((status[0] as any).config?.command).toBe('__definitely_missing_mcp_binary__');
    q.close();
  });

  it('returns defensive copies from mcpServerStatus()', async () => {
    const server = createSdkMcpServer({
      name: 'copy-test',
      tools: [
        tool(
          'echo_copy',
          'Echo copy test',
          { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
          async ({ text }: { text: string }) => text,
        ) as any,
      ],
    });

    const q = query('test', {
      model: 'claude-sonnet-4-6',
      mcpServers: {
        copy_test: server as any,
      },
    });

    await q.initializationResult();
    const first = await q.mcpServerStatus();
    (first[0] as any).config.name = 'mutated';
    if (first[0].tools?.[0]) {
      (first[0].tools?.[0] as any).name = 'mutated_tool';
    }
    const second = await q.mcpServerStatus();
    expect((second[0] as any).config?.name).toBe('copy-test');
    expect(second[0].tools?.[0]?.name).toBe('echo_copy');
    q.close();
  });

  it('reconnectMcpServer throws when reconnect result is not connected', async () => {
    const q = query('test', {
      model: 'claude-sonnet-4-6',
      mcpServers: {
        bad_stdio: {
          command: '__definitely_missing_mcp_binary__',
        } as any,
      },
    });

    await q.initializationResult();
    await expect(q.reconnectMcpServer('bad_stdio')).rejects.toThrow(/failed to reconnect/i);
    q.close();
  });

  it('toggleMcpServer throws when enabling back fails', async () => {
    const q = query('test', {
      model: 'claude-sonnet-4-6',
      mcpServers: {
        bad_stdio: {
          command: '__definitely_missing_mcp_binary__',
        } as any,
      },
    });

    await q.initializationResult();
    await q.toggleMcpServer('bad_stdio', false);
    await expect(q.toggleMcpServer('bad_stdio', true)).rejects.toThrow(/failed to enable/i);
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
    expect(preview.insertions).toBe(1);
    expect(preview.deletions).toBe(1);

    const applied = await q.rewindFiles('tool-use-1');
    expect(applied.canRewind).toBe(true);
    expect(applied.filesChanged).toEqual([targetFile]);
    expect(applied.insertions).toBe(1);
    expect(applied.deletions).toBe(1);
    expect(readFileSync(targetFile, 'utf-8')).toBe('before');
    q.close();
  });

  it('computes deletion stats when rewinding to a non-existent original file', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'open-agent-rewind-delete-'));
    const sessionId = 'rewind-delete-session';
    const targetFile = join(cwd, 'remove-me.txt');
    writeFileSync(targetFile, 'line1\nline2', 'utf-8');

    const sm = new SessionManager();
    const sessionDir = sm.getSessionDir(cwd, sessionId);
    const checkpointDir = join(sessionDir, 'checkpoints');
    mkdirSync(checkpointDir, { recursive: true });
    writeFileSync(
      join(checkpointDir, 'checkpoint-delete.json'),
      JSON.stringify({
        toolUseId: 'tool-use-delete',
        filePath: targetFile,
        originalContent: null,
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

    const preview = await q.rewindFiles('tool-use-delete', { dryRun: true });
    expect(preview.insertions).toBe(0);
    expect(preview.deletions).toBe(2);

    const applied = await q.rewindFiles('tool-use-delete');
    expect(applied.insertions).toBe(0);
    expect(applied.deletions).toBe(2);
    expect(() => readFileSync(targetFile, 'utf-8')).toThrow();
    q.close();
  });

  it('accepts userMessageId by resolving to underlying toolUseId from transcript', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'open-agent-rewind-user-msg-'));
    const sessionId = 'rewind-user-msg-session';
    const targetFile = join(cwd, 'map-id.txt');
    writeFileSync(targetFile, 'after-map', 'utf-8');

    const sm = new SessionManager();
    const sessionDir = sm.getSessionDir(cwd, sessionId);
    const checkpointDir = join(sessionDir, 'checkpoints');
    mkdirSync(checkpointDir, { recursive: true });
    writeFileSync(
      join(checkpointDir, 'checkpoint-map.json'),
      JSON.stringify({
        toolUseId: 'tool-use-map',
        filePath: targetFile,
        originalContent: 'before-map',
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

    sm.appendToTranscript(cwd, sessionId, {
      type: 'user',
      uuid: 'user-msg-1',
      session_id: sessionId,
      message: 'rewrite this file',
    });
    sm.appendToTranscript(cwd, sessionId, {
      type: 'tool_result',
      tool_use_id: 'tool-use-map',
      session_id: sessionId,
      result: 'done',
      is_error: false,
    });

    const preview = await q.rewindFiles('user-msg-1', { dryRun: true });
    expect(preview.canRewind).toBe(true);
    expect(preview.filesChanged).toEqual([targetFile]);
    q.close();
  });

  it('stops resolving when a newer user message is encountered', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'open-agent-rewind-user-boundary-'));
    const sessionId = 'rewind-user-boundary-session';
    const targetFile = join(cwd, 'boundary.txt');
    writeFileSync(targetFile, 'after-boundary', 'utf-8');

    const sm = new SessionManager();
    const sessionDir = sm.getSessionDir(cwd, sessionId);
    const checkpointDir = join(sessionDir, 'checkpoints');
    mkdirSync(checkpointDir, { recursive: true });
    writeFileSync(
      join(checkpointDir, 'checkpoint-boundary.json'),
      JSON.stringify({
        toolUseId: 'tool-use-boundary',
        filePath: targetFile,
        originalContent: 'before-boundary',
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

    sm.appendToTranscript(cwd, sessionId, {
      type: 'user',
      uuid: 'user-msg-old',
      session_id: sessionId,
      message: 'old user message',
    });
    sm.appendToTranscript(cwd, sessionId, {
      type: 'user',
      uuid: 'user-msg-new',
      session_id: sessionId,
      message: 'newer user message',
    });
    sm.appendToTranscript(cwd, sessionId, {
      type: 'tool_result',
      tool_use_id: 'tool-use-boundary',
      session_id: sessionId,
      result: 'done',
      is_error: false,
    });

    const preview = await q.rewindFiles('user-msg-old', { dryRun: true });
    expect(preview.canRewind).toBe(false);
    expect(preview.error).toMatch(/checkpoint not found/i);
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
