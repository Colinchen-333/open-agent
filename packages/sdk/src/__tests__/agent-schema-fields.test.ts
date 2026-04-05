/**
 * R6.2 — agent schema field consumption tests
 *
 * Covers the 6 fields wired into runtime in this lane:
 *   - permissionMode  (Part 2)
 *   - requiredMcpServers (Part 3)
 *   - omitClaudeMd (Part 4)
 *   - memory (Part 5)
 *   - background (Part 6)
 *   - hooks (Part 7)
 *
 * These are unit-style tests that exercise the construction/validation path
 * of query() without requiring a live LLM provider.
 */

import { describe, it, expect, afterEach, spyOn } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { AgentDefinition } from '@open-agent/core';
import { query } from '../query.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(prefix: string): { dir: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return {
    dir,
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function baseAgent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    description: 'Test agent',
    prompt: 'You are a test agent.',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Part 2 — permissionMode field
// ---------------------------------------------------------------------------
describe('agent permissionMode field', () => {
  it('uses agent permissionMode when no caller override is given', async () => {
    const q = query('hello', {
      model: 'claude-sonnet-4-6',
      agent: 'custom-agent',
      agents: {
        'custom-agent': baseAgent({ permissionMode: 'plan' }),
      },
    });

    const state = await q.getSessionState();
    expect(state.permissionMode).toBe('plan');
    q.close();
  });

  it('caller-level permissionMode overrides agent permissionMode', async () => {
    const q = query('hello', {
      model: 'claude-sonnet-4-6',
      agent: 'custom-agent',
      permissionMode: 'acceptEdits',
      agents: {
        'custom-agent': baseAgent({ permissionMode: 'plan' }),
      },
    });

    const state = await q.getSessionState();
    expect(state.permissionMode).toBe('acceptEdits');
    q.close();
  });

  it('falls back to agent.mode (legacy) when permissionMode is not set', async () => {
    const q = query('hello', {
      model: 'claude-sonnet-4-6',
      agent: 'custom-agent',
      agents: {
        'custom-agent': baseAgent({ mode: 'dontAsk' } as AgentDefinition),
      },
    });

    const state = await q.getSessionState();
    expect(state.permissionMode).toBe('dontAsk');
    q.close();
  });

  it('permissionMode takes precedence over legacy mode field', async () => {
    const q = query('hello', {
      model: 'claude-sonnet-4-6',
      agent: 'custom-agent',
      agents: {
        'custom-agent': baseAgent({ permissionMode: 'acceptEdits', mode: 'plan' } as AgentDefinition),
      },
    });

    const state = await q.getSessionState();
    expect(state.permissionMode).toBe('acceptEdits');
    q.close();
  });
});

// ---------------------------------------------------------------------------
// Part 3 — requiredMcpServers field
// ---------------------------------------------------------------------------
describe('agent requiredMcpServers field', () => {
  it('throws when a required MCP server is not configured', () => {
    expect(() => {
      query('hello', {
        model: 'claude-sonnet-4-6',
        agent: 'strict-agent',
        agents: {
          'strict-agent': baseAgent({
            requiredMcpServers: ['my-db-server', 'my-search-server'],
          }),
        },
        // No mcpServers configured — both required servers are missing.
      });
    }).toThrow("Agent 'strict-agent' requires MCP servers that are not configured: my-db-server, my-search-server");
  });

  it('throws listing only the missing servers when some are present', () => {
    expect(() => {
      query('hello', {
        model: 'claude-sonnet-4-6',
        agent: 'strict-agent',
        agents: {
          'strict-agent': baseAgent({
            requiredMcpServers: ['present-server', 'missing-server'],
          }),
        },
        mcpServers: {
          'present-server': { command: 'echo', args: ['ok'] },
        },
      });
    }).toThrow("Agent 'strict-agent' requires MCP servers that are not configured: missing-server");
  });

  it('does not throw when all required servers are configured', () => {
    expect(() => {
      const q = query('hello', {
        model: 'claude-sonnet-4-6',
        agent: 'strict-agent',
        agents: {
          'strict-agent': baseAgent({
            requiredMcpServers: ['my-server'],
          }),
        },
        mcpServers: {
          'my-server': { command: 'echo', args: ['ok'] },
        },
      });
      q.close();
    }).not.toThrow();
  });

  it('does not throw when requiredMcpServers is empty', () => {
    expect(() => {
      const q = query('hello', {
        model: 'claude-sonnet-4-6',
        agent: 'empty-req-agent',
        agents: {
          'empty-req-agent': baseAgent({ requiredMcpServers: [] }),
        },
      });
      q.close();
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Part 4 — omitClaudeMd field
// ---------------------------------------------------------------------------
describe('agent omitClaudeMd field', () => {
  it('agent with omitClaudeMd:true constructs without error', () => {
    const tmp = makeTempDir('open-agent-omitclaudemd-');
    try {
      // Write a CLAUDE.md so the provider would normally pick it up.
      writeFileSync(join(tmp.dir, 'CLAUDE.md'), '# Project Instructions\nAlways use TypeScript.\n');
      mkdirSync(join(tmp.dir, '.open-agent'), { recursive: true });

      expect(() => {
        const q = query('hello', {
          cwd: tmp.dir,
          model: 'claude-sonnet-4-6',
          agent: 'sandboxed-agent',
          settingSources: ['project'],
          agents: {
            'sandboxed-agent': baseAgent({ omitClaudeMd: true }),
          },
        });
        q.close();
      }).not.toThrow();
    } finally {
      tmp.cleanup();
    }
  });

  it('agent without omitClaudeMd constructs normally', () => {
    const tmp = makeTempDir('open-agent-withclaudemd-');
    try {
      writeFileSync(join(tmp.dir, 'CLAUDE.md'), '# Project Instructions\nAlways use TypeScript.\n');
      mkdirSync(join(tmp.dir, '.open-agent'), { recursive: true });

      expect(() => {
        const q = query('hello', {
          cwd: tmp.dir,
          model: 'claude-sonnet-4-6',
          agent: 'normal-agent',
          settingSources: ['project'],
          agents: {
            'normal-agent': baseAgent({ omitClaudeMd: false }),
          },
        });
        q.close();
      }).not.toThrow();
    } finally {
      tmp.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Part 5 — memory field
// ---------------------------------------------------------------------------
describe('agent memory field', () => {
  it('agent with inline memory constructs without error', () => {
    expect(() => {
      const q = query('hello', {
        model: 'claude-sonnet-4-6',
        agent: 'mem-agent',
        agents: {
          'mem-agent': baseAgent({ memory: '## Agent Memory\nRemember: always be concise.' }),
        },
      });
      q.close();
    }).not.toThrow();
  });

  it('agent with file-path memory reads file if present', () => {
    const tmp = makeTempDir('open-agent-memory-file-');
    try {
      const memFile = join(tmp.dir, 'agent-memory.md');
      writeFileSync(memFile, '## Persistent Context\nThis project uses Bun.\n');

      expect(() => {
        const q = query('hello', {
          model: 'claude-sonnet-4-6',
          agent: 'file-mem-agent',
          agents: {
            'file-mem-agent': baseAgent({ memory: memFile }),
          },
        });
        q.close();
      }).not.toThrow();
    } finally {
      tmp.cleanup();
    }
  });

  it('agent with missing memory file constructs without error (graceful fallback)', () => {
    expect(() => {
      const q = query('hello', {
        model: 'claude-sonnet-4-6',
        agent: 'missing-mem-agent',
        agents: {
          'missing-mem-agent': baseAgent({ memory: '/nonexistent/path/memory.md' }),
        },
      });
      q.close();
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Part 6 — background field
// ---------------------------------------------------------------------------
describe('agent background field', () => {
  it('agent with background:true emits a console.warn and constructs normally', () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const q = query('hello', {
        model: 'claude-sonnet-4-6',
        agent: 'bg-agent',
        agents: {
          'bg-agent': baseAgent({ background: true }),
        },
      });
      q.close();

      const warned = warnSpy.mock.calls.some(
        (args) => String(args[0]).includes("bg-agent") && String(args[0]).includes("background"),
      );
      expect(warned).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('agent with background:false does not warn', () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const q = query('hello', {
        model: 'claude-sonnet-4-6',
        agent: 'fg-agent',
        agents: {
          'fg-agent': baseAgent({ background: false }),
        },
      });
      q.close();

      const warned = warnSpy.mock.calls.some(
        (args) => String(args[0]).includes("fg-agent") && String(args[0]).includes("background"),
      );
      expect(warned).toBe(false);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Part 7 — hooks field
// ---------------------------------------------------------------------------
describe('agent hooks field', () => {
  it('agent with hooks constructs without error and query is functional', () => {
    expect(() => {
      const q = query('hello', {
        model: 'claude-sonnet-4-6',
        agent: 'hook-agent',
        agents: {
          'hook-agent': baseAgent({
            hooks: {
              PreToolUse: [{ command: 'echo pre-tool-use', timeout: 5 }],
              PostToolUse: [{ command: 'echo post-tool-use', timeout: 5 }],
            },
          }),
        },
      });
      q.close();
    }).not.toThrow();
  });

  it('agent hooks are merged with caller-level hooks (no conflict)', () => {
    expect(() => {
      const q = query('hello', {
        model: 'claude-sonnet-4-6',
        agent: 'hook-agent-merged',
        hooks: {
          PreToolUse: [{ command: 'echo caller-hook', timeout: 5 }],
        },
        agents: {
          'hook-agent-merged': baseAgent({
            hooks: {
              PostToolUse: [{ command: 'echo agent-hook', timeout: 5 }],
            },
          }),
        },
      });
      q.close();
    }).not.toThrow();
  });

  it('agent without hooks field constructs normally', () => {
    expect(() => {
      const q = query('hello', {
        model: 'claude-sonnet-4-6',
        agent: 'no-hook-agent',
        agents: {
          'no-hook-agent': baseAgent(),
        },
      });
      q.close();
    }).not.toThrow();
  });
});
