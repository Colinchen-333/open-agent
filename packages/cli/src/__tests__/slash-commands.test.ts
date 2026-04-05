import { describe, expect, it, beforeEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  getSlashCommands,
  handleSlashCommand,
  loadUserSlashCommands,
  clearUserCommandCache,
} from '../slash-commands.js';

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

describe('/output-style', () => {
  it('lists built-in styles when called without args', async () => {
    const result = await handleSlashCommand('/output-style', baseCtx);
    expect(result?.handled).toBe(true);
    expect(result?.output).toContain('Available output styles:');
    expect(result?.output).toContain('default');
    expect(result?.output).toContain('verbose');
    expect(result?.output).toContain('terse');
  });

  it('/outputstyle alias also lists styles', async () => {
    const result = await handleSlashCommand('/outputstyle', baseCtx);
    expect(result?.handled).toBe(true);
    expect(result?.output).toContain('Available output styles:');
    expect(result?.output).toContain('default');
  });

  it('/style alias also lists styles', async () => {
    const result = await handleSlashCommand('/style', baseCtx);
    expect(result?.handled).toBe(true);
    expect(result?.output).toContain('Available output styles:');
    expect(result?.output).toContain('default');
  });

  it('reports the picked style name when a valid name is given', async () => {
    const result = await handleSlashCommand('/output-style verbose', baseCtx);
    expect(result?.handled).toBe(true);
    expect(result?.output).toContain('verbose');
  });

  it('falls back to "default" style when an unknown name is given', async () => {
    const result = await handleSlashCommand('/output-style nonexistent-xyz', baseCtx);
    expect(result?.handled).toBe(true);
    expect(result?.output).toContain('default');
  });

  it('calls setOutputStyleName with the resolved name when the callback is provided', async () => {
    const recorded: string[] = [];
    const ctx = {
      ...baseCtx,
      setOutputStyleName: (name: string) => { recorded.push(name); },
    };
    const result = await handleSlashCommand('/output-style verbose', ctx);
    expect(result?.handled).toBe(true);
    expect(result?.output).toContain('verbose');
    // Callback must have been called with the canonical style name.
    expect(recorded).toEqual(['verbose']);
    // When the setter is present the message must NOT include the deferred note.
    expect(result?.output).not.toContain('effect on next query');
  });

  it('emits a deferred note when no setOutputStyleName callback is available', async () => {
    // baseCtx has no setOutputStyleName, so the handler falls back to the
    // "effect on next query" variant.
    const result = await handleSlashCommand('/output-style terse', baseCtx);
    expect(result?.handled).toBe(true);
    expect(result?.output).toContain('terse');
    expect(result?.output).toContain('effect on next query');
  });

  it('/outputstyle alias calls setOutputStyleName when provided', async () => {
    const recorded: string[] = [];
    const ctx = {
      ...baseCtx,
      setOutputStyleName: (name: string) => { recorded.push(name); },
    };
    const result = await handleSlashCommand('/outputstyle verbose', ctx);
    expect(result?.handled).toBe(true);
    expect(recorded).toEqual(['verbose']);
  });

  it('/style alias calls setOutputStyleName when provided', async () => {
    const recorded: string[] = [];
    const ctx = {
      ...baseCtx,
      setOutputStyleName: (name: string) => { recorded.push(name); },
    };
    const result = await handleSlashCommand('/style terse', ctx);
    expect(result?.handled).toBe(true);
    expect(recorded).toEqual(['terse']);
  });
});

describe('/resume', () => {
  it('returns no sessions message when session manager is empty', async () => {
    const ctx = {
      ...baseCtx,
      sessionMgr: { listSessions: () => [] },
    } as any;
    const result = await handleSlashCommand('/resume', ctx);
    expect(result?.handled).toBe(true);
    expect(result?.output).toContain('No sessions');
  });

  it('lists all sessions when called with no query', async () => {
    const ctx = {
      ...baseCtx,
      cwd: '/proj/a',
      sessionMgr: {
        listSessions: () => [
          { id: 'aaaaaaaa-0000-0000-0000-000000000000', title: 'Fix auth bug', cwd: '/proj/a', model: 'gpt-4', createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString() },
          { id: 'bbbbbbbb-0000-0000-0000-000000000000', title: 'Refactor payments', cwd: '/proj/a', model: 'gpt-4', createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString() },
        ],
      },
    } as any;
    const result = await handleSlashCommand('/resume', ctx);
    expect(result?.handled).toBe(true);
    expect(result?.output).toContain('Found 2 session(s)');
    expect(result?.output).toContain('aaaaaaaa');
    expect(result?.output).toContain('Fix auth bug');
    expect(result?.output).toContain('bbbbbbbb');
    expect(result?.output).toContain('Refactor payments');
  });

  it('lists matching sessions when a keyword query is provided', async () => {
    // Use an old lastActiveAt for the non-matching session so its recency bonus
    // is zero, ensuring the text-score=0 session is filtered out by searchSessions.
    const oldDate = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const ctx = {
      ...baseCtx,
      cwd: '/proj/a',
      sessionMgr: {
        listSessions: () => [
          { id: 'aaaaaaaa-0000-0000-0000-000000000000', title: 'Fix auth bug', cwd: '/proj/a', model: 'gpt-4', createdAt: oldDate, lastActiveAt: new Date().toISOString() },
          { id: 'bbbbbbbb-0000-0000-0000-000000000000', title: 'Refactor payments', cwd: '/proj/a', model: 'gpt-4', createdAt: oldDate, lastActiveAt: oldDate },
        ],
      },
    } as any;
    const result = await handleSlashCommand('/resume auth', ctx);
    expect(result?.handled).toBe(true);
    expect(result?.output).toContain('aaaaaaaa');
    expect(result?.output).toContain('Fix auth bug');
    // payments session has no text match and no recency bonus — filtered out
    expect(result?.output).not.toContain('Refactor payments');
  });

  it('marks cross-project sessions with marker and hint', async () => {
    const ctx = {
      ...baseCtx,
      cwd: '/proj/a',
      sessionMgr: {
        listSessions: () => [
          { id: 'cccccccc-0000-0000-0000-000000000000', title: 'Other project work', cwd: '/proj/b', model: 'gpt-4', createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString() },
        ],
      },
    } as any;
    const result = await handleSlashCommand('/resume', ctx);
    expect(result?.handled).toBe(true);
    expect(result?.output).toContain('cccccccc');
    expect(result?.output).toContain('different project');
  });

  it('returns no-session-manager message when sessionMgr is absent', async () => {
    const result = await handleSlashCommand('/resume', baseCtx as any);
    expect(result?.handled).toBe(true);
    expect(result?.output).toContain('No session manager available');
  });

  it('returns no-match message when query finds nothing', async () => {
    // Use an old lastActiveAt so the recency bonus is zero; an unmatched session
    // with score=0 (no recency, no text match) is filtered by searchSessions.
    const oldDate = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const ctx = {
      ...baseCtx,
      cwd: '/proj/a',
      sessionMgr: {
        listSessions: () => [
          { id: 'dddddddd-0000-0000-0000-000000000000', title: 'Fix payments', cwd: '/proj/a', model: 'gpt-4', createdAt: oldDate, lastActiveAt: oldDate },
        ],
      },
    } as any;
    const result = await handleSlashCommand('/resume zzzunknownzzz', ctx);
    expect(result?.handled).toBe(true);
    expect(result?.output).toContain('No sessions matching');
    expect(result?.output).toContain('zzzunknownzzz');
  });

  it('includes /resume in getSlashCommands registry', () => {
    const commands = getSlashCommands();
    const names = commands.map((c) => c.name);
    expect(names).toContain('/resume');
  });

  it('shows numbered choices in search results', async () => {
    const ctx = {
      ...baseCtx,
      cwd: '/proj/a',
      sessionMgr: {
        listSessions: () => [
          { id: 'aaaaaaaa-0000-0000-0000-000000000000', title: 'Fix auth bug', cwd: '/proj/a', model: 'gpt-4', createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString() },
          { id: 'bbbbbbbb-0000-0000-0000-000000000000', title: 'Payments module', cwd: '/proj/a', model: 'gpt-4', createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString() },
        ],
      },
    } as any;
    const result = await handleSlashCommand('/resume', ctx);
    expect(result?.handled).toBe(true);
    expect(result?.output).toContain('[1]');
    expect(result?.output).toContain('[2]');
    expect(result?.output).toContain('/resume <number>');
  });
});

describe('/resume hydration', () => {
  it('hydrates directly when args is a session-id prefix (8+ hex chars)', async () => {
    const sessions = [
      { id: 'abcd1234-5678-0000-0000-000000000000', title: 'Test session', cwd: '/proj', lastActiveAt: new Date().toISOString() },
    ];
    const ctx = {
      ...baseCtx,
      cwd: '/proj',
      sessionMgr: {
        listSessions: () => sessions,
        loadTranscript: () => [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'hi' },
        ],
      },
    } as any;
    const result = await handleSlashCommand('/resume abcd1234', ctx);
    expect(result?.handled).toBe(true);
    expect(result?.output).toContain('Resuming session');
    expect(result?.shouldResume).toBe('abcd1234-5678-0000-0000-000000000000');
    expect(result?.resumeTranscript).toHaveLength(2);
  });

  it('selects from cached results when args is a single digit', async () => {
    const sessions = [
      { id: 'aaaa1111-0000-0000-0000-000000000000', title: 'First', cwd: '/proj/digit', lastActiveAt: new Date().toISOString() },
      { id: 'bbbb2222-0000-0000-0000-000000000000', title: 'Second', cwd: '/proj/digit', lastActiveAt: new Date().toISOString() },
    ];
    const ctx = {
      ...baseCtx,
      cwd: '/proj/digit',
      sessionMgr: {
        listSessions: () => sessions,
        loadTranscript: () => [{ role: 'user', content: 'x' }],
      },
    } as any;
    // Populate the cache via a text search
    await handleSlashCommand('/resume test', ctx);
    // Now select by number
    const result = await handleSlashCommand('/resume 1', ctx);
    expect(result?.handled).toBe(true);
    expect(result?.shouldResume).toBeDefined();
  });

  it('shows transcript summary in hydration output', async () => {
    const ctx = {
      ...baseCtx,
      cwd: '/proj',
      sessionMgr: {
        listSessions: () => [
          { id: 'cafe1234abcdef00-0000-0000-000000000000', title: 'My work', cwd: '/proj', lastActiveAt: new Date().toISOString() },
        ],
        loadTranscript: () => [
          { role: 'user', content: 'write tests' },
          { role: 'assistant', content: 'ok' },
          { role: 'user', content: 'now commit' },
        ],
      },
    } as any;
    // cafe1234 is 8 hex chars — triggers the prefix path
    const result = await handleSlashCommand('/resume cafe1234', ctx);
    expect(result?.output).toContain('3 messages');
    expect(result?.output).toContain('2 user');
  });

  it('reports no-transcript when transcript is empty', async () => {
    const ctx = {
      ...baseCtx,
      cwd: '/proj',
      sessionMgr: {
        listSessions: () => [
          { id: 'deadc0de12345678-0000-0000-000000000000', title: 'Empty', cwd: '/proj', lastActiveAt: new Date().toISOString() },
        ],
        loadTranscript: () => [],
      },
    } as any;
    // deadc0de is 8 hex chars — triggers the prefix path
    const result = await handleSlashCommand('/resume deadc0de', ctx);
    expect(result?.output).toContain('no transcript');
  });

  it('reports no-number-cache when /resume <digit> is called without prior search', async () => {
    const ctx = {
      ...baseCtx,
      cwd: '/proj/nocache-' + Math.random(),
      sessionMgr: { listSessions: () => [] },
    } as any;
    const result = await handleSlashCommand('/resume 3', ctx);
    expect(result?.handled).toBe(true);
    expect(result?.output).toContain('No cached results');
  });

  it('sets shouldResume and resumeTranscript on successful hydration', async () => {
    const transcript = [
      { role: 'user', content: 'hello world' },
      { role: 'assistant', content: 'greetings' },
      { role: 'user', content: 'bye' },
    ];
    const ctx = {
      ...baseCtx,
      cwd: '/proj',
      sessionMgr: {
        listSessions: () => [
          { id: 'deadbeef-cafe-0000-0000-000000000000', title: 'Sample', cwd: '/proj', lastActiveAt: new Date().toISOString() },
        ],
        loadTranscript: () => transcript,
      },
    } as any;
    const result = await handleSlashCommand('/resume deadbeef', ctx);
    expect(result?.shouldResume).toBe('deadbeef-cafe-0000-0000-000000000000');
    expect(result?.resumeTranscript).toEqual(transcript);
  });
});

describe('loadUserSlashCommands', () => {
  function makeTempDir() {
    return mkdtempSync(join(tmpdir(), 'open-agent-cmds-'));
  }

  it('loads a command from <cwd>/.claude/commands/', async () => {
    const home = makeTempDir(); // isolated home so real ~/.claude is not read
    const cwd = makeTempDir();
    const cmdsDir = join(cwd, '.claude', 'commands');
    mkdirSync(cmdsDir, { recursive: true });
    writeFileSync(
      join(cmdsDir, 'greet.md'),
      `---
name: greet
description: Greet the user warmly
---
Say hello and introduce yourself.`,
      'utf-8',
    );

    const commands = await loadUserSlashCommands(cwd, home);
    expect(commands).toHaveLength(1);
    expect(commands[0].name).toBe('greet');
    expect(commands[0].description).toBe('Greet the user warmly');
    expect(commands[0].body).toContain('Say hello and introduce yourself.');
  });

  it('uses filename stem as name when frontmatter name is absent', async () => {
    const home = makeTempDir();
    const cwd = makeTempDir();
    const cmdsDir = join(cwd, '.claude', 'commands');
    mkdirSync(cmdsDir, { recursive: true });
    writeFileSync(
      join(cmdsDir, 'auto-cmd.md'),
      `---
description: No name in frontmatter
---
Body content.`,
      'utf-8',
    );

    const commands = await loadUserSlashCommands(cwd, home);
    expect(commands[0].name).toBe('auto-cmd');
  });

  it('returns empty array when no .claude/commands directory exists', async () => {
    const home = makeTempDir();
    const cwd = makeTempDir();
    const commands = await loadUserSlashCommands(cwd, home);
    expect(commands).toHaveLength(0);
  });

  it('project layer overrides user layer for same name', async () => {
    const home = makeTempDir();
    const cwd = makeTempDir();

    const userCmdsDir = join(home, '.claude', 'commands');
    const projectCmdsDir = join(cwd, '.claude', 'commands');
    mkdirSync(userCmdsDir, { recursive: true });
    mkdirSync(projectCmdsDir, { recursive: true });

    writeFileSync(
      join(userCmdsDir, 'greet.md'),
      `---\nname: greet\ndescription: User version\n---\nUser body.`,
      'utf-8',
    );
    writeFileSync(
      join(projectCmdsDir, 'greet.md'),
      `---\nname: greet\ndescription: Project version\n---\nProject body.`,
      'utf-8',
    );

    const commands = await loadUserSlashCommands(cwd, home);
    const greets = commands.filter((c) => c.name === 'greet');
    expect(greets).toHaveLength(1);
    expect(greets[0].description).toBe('Project version');
    expect(greets[0].body).toContain('Project body.');
  });
});

describe('user slash command dispatch via handleSlashCommand', () => {
  beforeEach(() => {
    clearUserCommandCache();
  });

  it('dispatches a user markdown command by emitting its body', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'open-agent-dispatch-'));
    const cmdsDir = join(cwd, '.claude', 'commands');
    mkdirSync(cmdsDir, { recursive: true });
    writeFileSync(
      join(cmdsDir, 'greet.md'),
      `---\nname: greet\ndescription: Greet\n---\nSay hello warmly.`,
      'utf-8',
    );

    const ctx = { ...baseCtx, cwd };
    const result = await handleSlashCommand('/greet', ctx);
    expect(result).not.toBeNull();
    // handled: false means REPL re-dispatches the body as a user message
    expect(result?.handled).toBe(false);
    expect(result?.output).toContain('Say hello warmly.');
  });

  it('falls through to unknown-command when no user command matches', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'open-agent-dispatch-miss-'));
    const ctx = { ...baseCtx, cwd };
    const result = await handleSlashCommand('/nonexistent', ctx);
    expect(result?.handled).toBe(true);
    expect(result?.output).toContain('Unknown command');
  });

  it('user command takes priority over unknown-command fallback', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'open-agent-dispatch-prio-'));
    const cmdsDir = join(cwd, '.claude', 'commands');
    mkdirSync(cmdsDir, { recursive: true });
    writeFileSync(
      join(cmdsDir, 'mycommand.md'),
      `---\nname: mycommand\ndescription: Custom\n---\nCustom prompt body.`,
      'utf-8',
    );

    const ctx = { ...baseCtx, cwd };
    const result = await handleSlashCommand('/mycommand', ctx);
    expect(result?.handled).toBe(false);
    expect(result?.output).not.toContain('Unknown command');
    expect(result?.output).toContain('Custom prompt body.');
  });
});
