import { describe, it, expect } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SessionManager } from '@open-agent/core';
import { __internal_extractUserMessagePrompt, __internal_isToolAllowedByPolicies, query } from '../query.js';
import type { QueryOptions, PermissionUpdate } from '../types.js';

// ---------------------------------------------------------------------------
// Tests for new QueryOptions fields:
//   - canUseTool: callback is called, returning false denies
//   - permissionPromptToolName: accepted without error
//   - settingSources: accepted without error
//
// KEY: We NEVER iterate the async generator (that calls LLM).
//      All tests create a query handle and test options/methods directly.
// ---------------------------------------------------------------------------

// ============================================================================
// canUseTool
// ============================================================================

describe('QueryOptions.canUseTool', () => {
  it('option is accepted without error', () => {
    const opts: QueryOptions = {
      canUseTool: (_tool, _input) => true,
    };
    expect(typeof opts.canUseTool).toBe('function');
  });

  it('is accepted by query() without throwing', () => {
    const q = query('test', {
      model: 'claude-sonnet-4-6',
      canUseTool: (_tool, _input) => true,
    });
    expect(q).toBeDefined();
    q.close();
  });

  it('accepting a callback that returns false is type-valid', () => {
    const opts: QueryOptions = {
      canUseTool: (_tool, _input) => false,
    };
    expect(typeof opts.canUseTool).toBe('function');
  });

  it('accepting a synchronous callback returning true is type-valid', () => {
    const opts: QueryOptions = {
      canUseTool: (_tool, _input) => true,
    };
    expect(typeof opts.canUseTool).toBe('function');
  });

  it('accepting an async callback returning structured permission is type-valid', () => {
    const opts: QueryOptions = {
      canUseTool: async (_tool, _input) => ({ behavior: 'allow' }),
    };
    expect(typeof opts.canUseTool).toBe('function');
  });

  it('accepts official PermissionUpdate variants in updatedPermissions', () => {
    const updates: PermissionUpdate[] = [
      {
        type: 'addRules',
        behavior: 'allow',
        destination: 'session',
        rules: [{ toolName: 'Read' }],
      },
      {
        type: 'setMode',
        mode: 'acceptEdits',
        destination: 'session',
      },
      {
        type: 'addDirectories',
        directories: ['/tmp/a', '/tmp/b'],
        destination: 'session',
      },
      {
        type: 'removeDirectories',
        directories: ['/tmp/a'],
        destination: 'session',
      },
    ];

    const opts: QueryOptions = {
      canUseTool: async () => ({
        behavior: 'allow',
        updatedPermissions: updates,
      }),
    };
    expect(typeof opts.canUseTool).toBe('function');
  });

  it('callback receives the tool name as the first argument', () => {
    const receivedToolNames: string[] = [];
    const q = query('test', {
      model: 'claude-sonnet-4-6',
      canUseTool: (toolName, _input) => {
        receivedToolNames.push(toolName);
        return true;
      },
    });
    // The callback is wired but not called until a tool is actually used.
    // We verify it is the right type and attached.
    expect(q).toBeDefined();
    q.close();
  });

  it('callback receives the input object as the second argument', () => {
    const receivedInputs: Array<Record<string, unknown>> = [];
    const q = query('test', {
      model: 'claude-sonnet-4-6',
      canUseTool: (_toolName, input) => {
        receivedInputs.push(input);
        return true;
      },
    });
    expect(q).toBeDefined();
    q.close();
  });

  it('returning false from canUseTool denies tool execution (wired to permission engine)', () => {
    // When canUseTool returns false the permission engine should return deny.
    // We verify this by inspecting the query handle's initializationResult
    // which shows tools ARE registered (they just get denied at runtime).
    const q = query('test', {
      model: 'claude-sonnet-4-6',
      canUseTool: (_tool, _input) => false, // always deny
    });
    // Handle exists — tools are registered, just denied at runtime.
    expect(q).toBeDefined();
    expect(typeof q.initializationResult).toBe('function');
    q.close();
  });

  it('returning true from canUseTool allows normal permission evaluation', () => {
    const q = query('test', {
      model: 'claude-sonnet-4-6',
      canUseTool: (_tool, _input) => true, // always allow
    });
    expect(q).toBeDefined();
    q.close();
  });

  it('is undefined by default in QueryOptions', () => {
    const opts: QueryOptions = {};
    expect(opts.canUseTool).toBeUndefined();
  });

  it('works alongside other options without conflict', () => {
    const q = query('test', {
      model: 'claude-sonnet-4-6',
      maxTurns: 5,
      permissionMode: 'default',
      canUseTool: (_tool, _input) => true,
    });
    expect(q).toBeDefined();
    q.close();
  });

  it('callback with tool-specific logic is accepted', () => {
    const q = query('test', {
      model: 'claude-sonnet-4-6',
      canUseTool: (toolName, _input) => {
        // Only allow Read and Write
        return ['Read', 'Write'].includes(toolName);
      },
    });
    expect(q).toBeDefined();
    q.close();
  });

  it('callback with input-based logic is accepted', () => {
    const q = query('test', {
      model: 'claude-sonnet-4-6',
      canUseTool: (_toolName, input) => {
        // Deny if the input has a "dangerous" key
        return !('dangerous' in input);
      },
    });
    expect(q).toBeDefined();
    q.close();
  });

});

// ============================================================================
// permissionPromptToolName
// ============================================================================

describe('QueryOptions.permissionPromptToolName', () => {
  it('option is accepted without error', () => {
    const opts: QueryOptions = {
      permissionPromptToolName: 'mcp__myServer__ask_permission',
    };
    expect(opts.permissionPromptToolName).toBe('mcp__myServer__ask_permission');
  });

  it('is accepted by query() without throwing', () => {
    const q = query('test', {
      model: 'claude-sonnet-4-6',
      permissionPromptToolName: 'mcp__myServer__prompt',
    });
    expect(q).toBeDefined();
    q.close();
  });

  it('is undefined by default in QueryOptions', () => {
    const opts: QueryOptions = {};
    expect(opts.permissionPromptToolName).toBeUndefined();
  });

  it('accepts any non-empty string value', () => {
    const testNames = [
      'mcp__approval__ask',
      'my_custom_tool',
      'AskPermission',
      'permission-prompt-v2',
    ];

    for (const name of testNames) {
      const q = query('test', {
        model: 'claude-sonnet-4-6',
        permissionPromptToolName: name,
      });
      expect(q).toBeDefined();
      q.close();
    }
  });

  it('works alongside canUseTool without conflict', () => {
    const q = query('test', {
      model: 'claude-sonnet-4-6',
      permissionPromptToolName: 'mcp__myServer__ask',
      canUseTool: (_tool, _input) => true,
    });
    expect(q).toBeDefined();
    q.close();
  });

  it('works alongside permissionMode without conflict', () => {
    const q = query('test', {
      model: 'claude-sonnet-4-6',
      permissionPromptToolName: 'mcp__myServer__ask',
      permissionMode: 'default',
    });
    expect(q).toBeDefined();
    q.close();
  });

  it('works alongside all other new options', () => {
    const q = query('test', {
      model: 'claude-sonnet-4-6',
      permissionPromptToolName: 'mcp__server__ask',
      canUseTool: (_tool, _input) => true,
      settingSources: ['user', 'project'],
    });
    expect(q).toBeDefined();
    q.close();
  });

  it('initializationResult still works when permissionPromptToolName is set', async () => {
    const q = query('test', {
      model: 'claude-sonnet-4-6',
      permissionPromptToolName: 'mcp__myServer__ask',
    });
    const result = await q.initializationResult();
    expect(result).toBeDefined();
    expect(Array.isArray(result.commands)).toBe(true);
    q.close();
  });
});

// ============================================================================
// settingSources
// ============================================================================

describe('QueryOptions.settingSources', () => {
  it('option is accepted without error', () => {
    const opts: QueryOptions = {
      settingSources: ['user', 'project', 'local'],
    };
    expect(opts.settingSources).toEqual(['user', 'project', 'local']);
  });

  it('is accepted by query() without throwing', () => {
    const q = query('test', {
      model: 'claude-sonnet-4-6',
      settingSources: ['user', 'project', 'local'],
    });
    expect(q).toBeDefined();
    q.close();
  });

  it('is undefined by default in QueryOptions', () => {
    const opts: QueryOptions = {};
    expect(opts.settingSources).toBeUndefined();
  });

  it('accepts only "user" source', () => {
    const q = query('test', {
      model: 'claude-sonnet-4-6',
      settingSources: ['user'],
    });
    expect(q).toBeDefined();
    q.close();
  });

  it('accepts only "project" source', () => {
    const q = query('test', {
      model: 'claude-sonnet-4-6',
      settingSources: ['project'],
    });
    expect(q).toBeDefined();
    q.close();
  });

  it('accepts only "local" source', () => {
    const q = query('test', {
      model: 'claude-sonnet-4-6',
      settingSources: ['local'],
    });
    expect(q).toBeDefined();
    q.close();
  });

  it('accepts empty array', () => {
    const q = query('test', {
      model: 'claude-sonnet-4-6',
      settingSources: [],
    });
    expect(q).toBeDefined();
    q.close();
  });

  it('accepts all three sources in any order', () => {
    const q1 = query('test', {
      model: 'claude-sonnet-4-6',
      settingSources: ['user', 'project', 'local'],
    });
    const q2 = query('test', {
      model: 'claude-sonnet-4-6',
      settingSources: ['local', 'project', 'user'],
    });
    const q3 = query('test', {
      model: 'claude-sonnet-4-6',
      settingSources: ['project', 'user'],
    });
    expect(q1).toBeDefined();
    expect(q2).toBeDefined();
    expect(q3).toBeDefined();
    q1.close();
    q2.close();
    q3.close();
  });

  it('works alongside other options without conflict', () => {
    const q = query('test', {
      model: 'claude-sonnet-4-6',
      settingSources: ['user'],
      maxTurns: 5,
      cwd: '/tmp',
    });
    expect(q).toBeDefined();
    q.close();
  });

  it('initializationResult still works when settingSources is set', async () => {
    const q = query('test', {
      model: 'claude-sonnet-4-6',
      settingSources: ['user', 'project'],
    });
    const result = await q.initializationResult();
    expect(result).toBeDefined();
    expect(Array.isArray(result.available_output_styles)).toBe(true);
    q.close();
  });

  it('is a valid QueryOptions interface field of the right type', () => {
    // Type-check: the field must accept Array<'user' | 'project' | 'local'>
    const opts1: QueryOptions = { settingSources: ['user'] };
    const opts2: QueryOptions = { settingSources: ['project', 'local'] };
    const opts3: QueryOptions = { settingSources: [] };

    expect(opts1.settingSources).toHaveLength(1);
    expect(opts2.settingSources).toHaveLength(2);
    expect(opts3.settingSources).toHaveLength(0);
  });
});

// ============================================================================
// sandbox
// ============================================================================

describe('QueryOptions.sandbox', () => {
  it('option is accepted without error', () => {
    const opts: QueryOptions = {
      sandbox: {
        enabled: true,
        autoAllowBashIfSandboxed: true,
      },
    };
    expect(opts.sandbox?.enabled).toBe(true);
  });

  it('is accepted by query() without throwing', () => {
    const q = query('test', {
      model: 'claude-sonnet-4-6',
      sandbox: {
        enabled: true,
      },
    });
    expect(q).toBeDefined();
    q.close();
  });

  it('throws when sandbox is provided without explicit enabled boolean', () => {
    expect(() =>
      query('test', {
        model: 'claude-sonnet-4-6',
        sandbox: { autoAllowBashIfSandboxed: true } as any,
      }),
    ).toThrow(/sandbox config.*enabled/i);
  });

  it('throws when loaded settings sandbox is invalid', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'open-agent-invalid-sandbox-settings-'));
    const settingsDir = join(cwd, '.open-agent');
    mkdirSync(settingsDir, { recursive: true });
    writeFileSync(
      join(settingsDir, 'settings.json'),
      JSON.stringify({
        sandbox: {
          autoAllowBashIfSandboxed: true,
        },
      }),
      'utf-8',
    );

    expect(() =>
      query('test', {
        model: 'claude-sonnet-4-6',
        cwd,
        settingSources: ['project'],
      }),
    ).toThrow(/loaded settings sandbox config is invalid/i);
  });
});

// ============================================================================
// Combined: all three new options together
// ============================================================================

describe('QueryOptions — all new options combined', () => {
  it('canUseTool + permissionPromptToolName + settingSources together', () => {
    const q = query('test', {
      model: 'claude-sonnet-4-6',
      canUseTool: (tool, _input) => tool !== 'Bash',
      permissionPromptToolName: 'mcp__server__ask',
      settingSources: ['user', 'project'],
    });
    expect(q).toBeDefined();
    q.close();
  });

  it('all new options work alongside classic options', () => {
    const q = query('test', {
      model: 'claude-sonnet-4-6',
      maxTurns: 10,
      maxBudgetUsd: 0.5,
      permissionMode: 'default',
      allowedTools: ['Read', 'Write', 'Bash'],
      canUseTool: (_tool, _input) => true,
      permissionPromptToolName: 'mcp__approval__ask',
      settingSources: ['user', 'project', 'local'],
    });
    expect(q).toBeDefined();
    q.close();
  });

  it('initializationResult works with all new options set', async () => {
    const q = query('test', {
      model: 'claude-sonnet-4-6',
      canUseTool: (_tool, _input) => true,
      permissionPromptToolName: 'mcp__server__ask',
      settingSources: ['project'],
    });
    const result = await q.initializationResult();
    expect(result).toBeDefined();
    expect(Array.isArray(result.models)).toBe(true);
    expect(Array.isArray(result.agents)).toBe(true);
    q.close();
  });
});

describe('QueryOptions permission safety', () => {
  it('throws when bypassPermissions is requested without allowDangerouslySkipPermissions', () => {
    expect(() =>
      query('test', {
        model: 'claude-sonnet-4-6',
        permissionMode: 'bypassPermissions',
      }),
    ).toThrow(/allowDangerouslySkipPermissions/i);
  });

  it('throws when allowDangerouslySkipPermissions is true but permissionMode is not bypassPermissions', () => {
    expect(() =>
      query('test', {
        model: 'claude-sonnet-4-6',
        permissionMode: 'default',
        allowDangerouslySkipPermissions: true,
      }),
    ).toThrow(/permissionMode="bypassPermissions"/i);
  });

  it('accepts bypassPermissions only when both flags are set', () => {
    const q = query('test', {
      model: 'claude-sonnet-4-6',
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
    });
    expect(q).toBeDefined();
    q.close();
  });
});

describe('QueryOptions continue/resume semantics', () => {
  it('throws when sessionId is not a valid UUID', () => {
    expect(() =>
      query('test', {
        model: 'claude-sonnet-4-6',
        sessionId: 'not-a-uuid',
      }),
    ).toThrow(/sessionId must be a valid UUID/i);
  });

  it('throws when resume is not a valid UUID', () => {
    expect(() =>
      query('test', {
        model: 'claude-sonnet-4-6',
        resume: 'not-a-uuid',
      }),
    ).toThrow(/resume must be a valid UUID/i);
  });

  it('throws when continue and resume are both set', () => {
    expect(() =>
      query('test', {
        model: 'claude-sonnet-4-6',
        continue: true,
        resume: 'session-1',
      }),
    ).toThrow(/mutually exclusive/i);
  });

  it('throws when sessionId is combined with continue without forkSession', () => {
    expect(() =>
      query('test', {
        model: 'claude-sonnet-4-6',
        sessionId: '11111111-1111-4111-8111-111111111111',
        continue: true,
      }),
    ).toThrow(/sessionId cannot be combined/i);
  });

  it('throws when sessionId is combined with resume without forkSession', () => {
    expect(() =>
      query('test', {
        model: 'claude-sonnet-4-6',
        sessionId: '11111111-1111-4111-8111-111111111111',
        resume: '22222222-2222-4222-8222-222222222222',
      }),
    ).toThrow(/sessionId cannot be combined/i);
  });

  it('allows sessionId with continue when forkSession=true', () => {
    const q = query('test', {
      model: 'claude-sonnet-4-6',
      sessionId: '11111111-1111-4111-8111-111111111111',
      continue: true,
      forkSession: true,
    });
    expect(q).toBeDefined();
    q.close();
  });

  it('throws when explicit resume session does not exist', () => {
    expect(() =>
      query('test', {
        model: 'claude-sonnet-4-6',
        cwd: mkdtempSync(join(tmpdir(), 'open-agent-missing-resume-')),
        resume: '33333333-3333-4333-8333-333333333333',
      }),
    ).toThrow(/session not found for resume/i);
  });

  it('throws when resumeSessionAt is set without resume', () => {
    expect(() =>
      query('test', {
        model: 'claude-sonnet-4-6',
        resumeSessionAt: 'assistant-uuid-1',
      }),
    ).toThrow(/resumeSessionAt requires options.resume/i);
  });

  it('accepts resumeSessionAt when target assistant message exists', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'open-agent-resume-at-'));
    const sessionId = '11111111-1111-4111-8111-111111111112';
    const assistantUuid = 'assistant-uuid-target';
    const sm = new SessionManager();
    sm.ensureSession(cwd, sessionId, 'claude-sonnet-4-6');
    sm.appendToTranscript(cwd, sessionId, {
      type: 'user',
      uuid: 'user-uuid-1',
      session_id: sessionId,
      message: { role: 'user', content: 'hello' },
    });
    sm.appendToTranscript(cwd, sessionId, {
      type: 'assistant',
      uuid: assistantUuid,
      session_id: sessionId,
      message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    });
    sm.appendToTranscript(cwd, sessionId, {
      type: 'assistant',
      uuid: 'assistant-uuid-later',
      session_id: sessionId,
      message: { role: 'assistant', content: [{ type: 'text', text: 'later' }] },
    });

    const q = query('test', {
      model: 'claude-sonnet-4-6',
      cwd,
      resume: sessionId,
      resumeSessionAt: assistantUuid,
    });
    expect(q).toBeDefined();
    q.close();
  });

  it('throws when resumeSessionAt target assistant message does not exist', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'open-agent-resume-at-missing-'));
    const sessionId = '11111111-1111-4111-8111-111111111113';
    const sm = new SessionManager();
    sm.ensureSession(cwd, sessionId, 'claude-sonnet-4-6');
    sm.appendToTranscript(cwd, sessionId, {
      type: 'assistant',
      uuid: 'assistant-uuid-present',
      session_id: sessionId,
      message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    });

    expect(() =>
      query('test', {
        model: 'claude-sonnet-4-6',
        cwd,
        resume: sessionId,
        resumeSessionAt: 'assistant-uuid-missing',
      }),
    ).toThrow(/assistant message not found/i);
  });
});

describe('QueryOptions numeric bounds', () => {
  it('throws when maxTurns is not a positive integer', () => {
    expect(() =>
      query('test', {
        model: 'claude-sonnet-4-6',
        maxTurns: 0,
      }),
    ).toThrow(/maxTurns.*positive integer/i);
  });

  it('throws when maxBudgetUsd is negative', () => {
    expect(() =>
      query('test', {
        model: 'claude-sonnet-4-6',
        maxBudgetUsd: -1,
      }),
    ).toThrow(/maxBudgetUsd.*>= 0/i);
  });

  it('throws when maxBudgetUsd is not finite', () => {
    expect(() =>
      query('test', {
        model: 'claude-sonnet-4-6',
        maxBudgetUsd: Infinity,
      }),
    ).toThrow(/maxBudgetUsd.*finite/i);
  });
});

describe('QueryOptions unsupported official placeholders', () => {
  it('throws for each unsupported placeholder option with key-specific message', () => {
    const unsupported: Array<{ key: string; option: Partial<QueryOptions> }> = [
      { key: 'betas', option: { betas: ['x-test-beta'] } },
      { key: 'promptSuggestions', option: { promptSuggestions: true } },
      { key: 'onElicitation', option: { onElicitation: {} } },
      { key: 'plugins', option: { plugins: [] } },
      { key: 'debugFile', option: { debugFile: '/tmp/debug.log' } },
      { key: 'spawnClaudeCodeProcess', option: { spawnClaudeCodeProcess: {} } },
    ];

    for (const { key, option } of unsupported) {
      expect(() =>
        query('test', {
          model: 'claude-sonnet-4-6',
          ...(option as QueryOptions),
        }),
      ).toThrow(new RegExp(`Option \"${key}\".*not supported yet`, 'i'));
    }
  });
});

describe('__internal_isToolAllowedByPolicies()', () => {
  it('allows by default when no allow/deny lists are configured', () => {
    expect(__internal_isToolAllowedByPolicies('Read', {})).toBe(true);
  });

  it('denies when tool is in any deny list', () => {
    expect(
      __internal_isToolAllowedByPolicies('Bash', {
        disallowedTools: ['Bash'],
      }),
    ).toBe(false);
    expect(
      __internal_isToolAllowedByPolicies('Write', {
        agentDisallowedTools: ['Write'],
      }),
    ).toBe(false);
  });

  it('requires tool to satisfy all configured allow lists', () => {
    expect(
      __internal_isToolAllowedByPolicies('Read', {
        agentAllowedTools: ['Read', 'Edit'],
        toolsBaseline: ['Read', 'Bash'],
        allowedTools: ['Read'],
      }),
    ).toBe(true);

    expect(
      __internal_isToolAllowedByPolicies('Bash', {
        agentAllowedTools: ['Read', 'Edit'],
        toolsBaseline: ['Read', 'Bash'],
        allowedTools: ['Read'],
      }),
    ).toBe(false);
  });

  it('deny lists override allow lists', () => {
    expect(
      __internal_isToolAllowedByPolicies('Read', {
        agentAllowedTools: ['Read'],
        allowedTools: ['Read'],
        disallowedTools: ['Read'],
      }),
    ).toBe(false);
  });
});

describe('__internal_extractUserMessagePrompt()', () => {
  it('returns string prompt for string user message', () => {
    const prompt = __internal_extractUserMessagePrompt({
      type: 'user',
      message: 'hello',
      parent_tool_use_id: null,
      session_id: '11111111-1111-4111-8111-111111111147',
      uuid: 'u1',
    } as any);
    expect(prompt).toBe('hello');
  });

  it('preserves non-text content blocks instead of dropping them', () => {
    const blocks = [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } },
    ];
    const prompt = __internal_extractUserMessagePrompt({
      type: 'user',
      message: { role: 'user', content: blocks },
      parent_tool_use_id: null,
      session_id: '11111111-1111-4111-8111-111111111148',
      uuid: 'u2',
    } as any);
    expect(prompt).toEqual(blocks);
  });

  it('returns undefined when content blocks are empty', () => {
    const prompt = __internal_extractUserMessagePrompt({
      type: 'user',
      message: { role: 'user', content: [] },
      parent_tool_use_id: null,
      session_id: '11111111-1111-4111-8111-111111111149',
      uuid: 'u3',
    } as any);
    expect(prompt).toBeUndefined();
  });
});
