import { describe, expect, it } from 'bun:test';
import { getSlashCommands, handleSlashCommand } from '../slash-commands.js';

// Minimal mock loop sufficient for all new commands.
const mockLoop = {
  compact: async () => {},
  setModel: () => {},
  setThinking: () => {},
  setEffort: () => {},
  getTurnCount: () => 7,
  getTotalCost: () => ({ totalCostUsd: 0.000042, totalInputTokens: 1200, totalOutputTokens: 300 }),
} as any;

const baseCtx = {
  loop: mockLoop,
  cwd: '/tmp/test-project',
  model: 'test-model',
  sessionId: 'session-abc',
};

describe('/plugins', () => {
  it('returns handled: true and a stub message', async () => {
    const result = await handleSlashCommand('/plugins', baseCtx);
    expect(result?.handled).toBe(true);
    expect(result?.output).toContain('Plugin');
  });
});

describe('/workflow', () => {
  it('returns handled: true and a not-implemented message', async () => {
    const result = await handleSlashCommand('/workflow', baseCtx);
    expect(result?.handled).toBe(true);
    expect(result?.output).toContain('not yet implemented');
  });
});

describe('/keybindings', () => {
  it('returns handled: true and a stub message', async () => {
    const result = await handleSlashCommand('/keybindings', baseCtx);
    expect(result?.handled).toBe(true);
    expect(result?.output).toContain('not yet implemented');
  });
});

describe('/insights', () => {
  it('returns handled: true and session statistics', async () => {
    const result = await handleSlashCommand('/insights', baseCtx);
    expect(result?.handled).toBe(true);
    expect(result?.output).toContain('Turns');
    expect(result?.output).toContain('7');
    expect(result?.output).toContain('tokens');
  });

  it('includes cost information', async () => {
    const result = await handleSlashCommand('/insights', baseCtx);
    expect(result?.output).toContain('cost');
  });
});

describe('/upgrade', () => {
  it('returns handled: true and a stub message', async () => {
    const result = await handleSlashCommand('/upgrade', baseCtx);
    expect(result?.handled).toBe(true);
    expect(result?.output).toContain('not yet implemented');
  });
});

describe('/version', () => {
  it('returns handled: true and contains a version string', async () => {
    const result = await handleSlashCommand('/version', baseCtx);
    expect(result?.handled).toBe(true);
    expect(result?.output).toContain('open-agent version');
  });
});

describe('/env', () => {
  it('returns handled: true and includes CWD and platform', async () => {
    const result = await handleSlashCommand('/env', baseCtx);
    expect(result?.handled).toBe(true);
    expect(result?.output).toContain('CWD');
    expect(result?.output).toContain('/tmp/test-project');
    expect(result?.output).toContain('Platform');
  });

  it('includes the model name', async () => {
    const result = await handleSlashCommand('/env', baseCtx);
    expect(result?.output).toContain('test-model');
  });
});

describe('getSlashCommands', () => {
  it('exposes all new commands in the registry', () => {
    const commands = getSlashCommands();
    const names = commands.map((c) => c.name);
    expect(names).toContain('/plugins');
    expect(names).toContain('/workflow');
    expect(names).toContain('/keybindings');
    expect(names).toContain('/insights');
    expect(names).toContain('/upgrade');
    expect(names).toContain('/version');
    expect(names).toContain('/env');
  });
});
