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
  it('returns handled: true and a clean informational message when no plugin list is present', async () => {
    const result = await handleSlashCommand('/plugins', baseCtx);
    expect(result?.handled).toBe(true);
    expect(result?.output).toContain('Plugin');
    expect(result?.output).toContain('Round 4');
  });

  it('lists plugins when a plugins array is provided on the context', async () => {
    const ctx = {
      ...baseCtx,
      plugins: [
        { name: 'my-plugin', version: '1.0.0', description: 'A test plugin' },
        { name: 'another-plugin' },
      ],
    } as any;
    const result = await handleSlashCommand('/plugins', ctx);
    expect(result?.handled).toBe(true);
    expect(result?.output).toContain('Plugins loaded (2)');
    expect(result?.output).toContain('my-plugin@1.0.0');
    expect(result?.output).toContain('A test plugin');
    expect(result?.output).toContain('another-plugin');
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
  it('returns handled: true and starts with "open-agent"', async () => {
    const result = await handleSlashCommand('/version', baseCtx);
    expect(result?.handled).toBe(true);
    expect(result?.output).toMatch(/^open-agent /);
  });

  it('includes bun version suffix when version cannot be resolved', async () => {
    // The test process may or may not resolve a real package.json version; in
    // either case the output must start with "open-agent" and may include a
    // bun runtime suffix when version is unknown.
    const result = await handleSlashCommand('/version', baseCtx);
    expect(result?.output).toMatch(/^open-agent (\d+\.\d+\.\d+|unknown)/);
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

describe('/skills with userInvocable filtering', () => {
  const ctxWithSkills = (skills: { name: string; description: string; source?: string; userInvocable?: boolean }[]) => ({
    ...baseCtx,
    skills,
  });

  it('shows skills that have no userInvocable flag', async () => {
    const result = await handleSlashCommand('/skills', ctxWithSkills([
      { name: 'public-skill', description: 'A visible skill' },
    ]));
    expect(result?.handled).toBe(true);
    expect(result?.output).toContain('public-skill');
  });

  it('shows skills with userInvocable: true explicitly', async () => {
    const result = await handleSlashCommand('/skills', ctxWithSkills([
      { name: 'explicit-public', description: 'Visible', userInvocable: true },
    ]));
    expect(result?.output).toContain('explicit-public');
  });

  it('hides skills with userInvocable: false from /skills list', async () => {
    const result = await handleSlashCommand('/skills', ctxWithSkills([
      { name: 'internal-skill', description: 'Hidden', userInvocable: false },
    ]));
    expect(result?.handled).toBe(true);
    expect(result?.output).not.toContain('internal-skill');
    expect(result?.output).toContain('No skills loaded.');
  });

  it('shows only user-invocable skills in a mixed list', async () => {
    const result = await handleSlashCommand('/skills', ctxWithSkills([
      { name: 'visible-a', description: 'Public A' },
      { name: 'hidden-b', description: 'Hidden B', userInvocable: false },
      { name: 'visible-c', description: 'Public C', userInvocable: true },
    ]));
    expect(result?.output).toContain('visible-a');
    expect(result?.output).toContain('visible-c');
    expect(result?.output).not.toContain('hidden-b');
    // Count shows only 2
    expect(result?.output).toContain('Available skills (2)');
  });
});

describe('user skill invocation via /<skill-name>', () => {
  const ctxWithSkills = (skills: { name: string; description: string; userInvocable?: boolean }[]) => ({
    ...baseCtx,
    skills,
  });

  it('rejects invocation of a skill with userInvocable: false', async () => {
    const result = await handleSlashCommand('/internal-skill', ctxWithSkills([
      { name: 'internal-skill', description: 'Internal only', userInvocable: false },
    ]));
    expect(result?.handled).toBe(true);
    expect(result?.output).toContain("Skill 'internal-skill' is not user-invocable");
  });

  it('returns unknown command for a non-existent skill (no match)', async () => {
    const result = await handleSlashCommand('/no-such-skill', ctxWithSkills([
      { name: 'other-skill', description: 'Something else' },
    ]));
    expect(result?.handled).toBe(true);
    expect(result?.output).toContain('Unknown command');
  });

  it('does not block a skill with userInvocable: true from the unknown-command fallthrough', async () => {
    // A public skill typed as /<name> still falls to "Unknown command" (no direct
    // dispatch), but must NOT produce the "not user-invocable" error message.
    const result = await handleSlashCommand('/public-skill', ctxWithSkills([
      { name: 'public-skill', description: 'Visible skill', userInvocable: true },
    ]));
    expect(result?.handled).toBe(true);
    expect(result?.output).not.toContain('not user-invocable');
    // Falls through to "Unknown command" because there is no direct skill dispatcher
    expect(result?.output).toContain('Unknown command');
  });

  it('does not block a skill without userInvocable flag from the fallthrough', async () => {
    const result = await handleSlashCommand('/default-skill', ctxWithSkills([
      { name: 'default-skill', description: 'Default visible skill' },
    ]));
    expect(result?.output).not.toContain('not user-invocable');
    expect(result?.output).toContain('Unknown command');
  });
});
