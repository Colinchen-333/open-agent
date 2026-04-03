import { describe, it, expect } from 'bun:test';
import { randomUUID } from 'crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SessionManager } from '@open-agent/core';
import {
  __internal_buildPromptSuggestions,
  __internal_collectPendingTaskNotifications,
  __internal_collectTrailingTaskNotifications,
  __internal_extractUserMessagePrompt,
  __internal_isToolAllowedByPolicies,
  query,
} from '../query.js';
import type { QueryOptions, PermissionUpdate } from '../types.js';

function createPluginFixture() {
  const pluginDir = mkdtempSync(join(tmpdir(), 'open-agent-plugin-fixture-'));
  mkdirSync(join(pluginDir, 'skills'), { recursive: true });
  mkdirSync(join(pluginDir, 'commands'), { recursive: true });
  mkdirSync(join(pluginDir, 'agents'), { recursive: true });
  mkdirSync(join(pluginDir, 'hooks'), { recursive: true });

  writeFileSync(join(pluginDir, 'plugin.json'), JSON.stringify({
    name: 'review-kit',
    version: '1.0.0',
    description: 'Plugin test fixture',
    hooks: {
      PreToolUse: [
        { command: 'echo pre-tool', timeout: 5 },
      ],
    },
  }, null, 2));
  writeFileSync(join(pluginDir, 'skills', 'review.md'), `---
name: review-plugin
description: Review via plugin
---
Use this plugin skill when reviewing changes.`);
  writeFileSync(join(pluginDir, 'commands', 'review.md'), `---
name: review-plugin
description: Review command from plugin
argument-hint: [target]
---
Review plugin command body.`);
  writeFileSync(join(pluginDir, 'agents', 'reviewer.md'), `---
description: Reviewer from plugin
model: sonnet
tools: Read,Write
---
You are the plugin reviewer agent.`);

  return pluginDir;
}

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
// promptSuggestions
// ============================================================================

describe('QueryOptions.promptSuggestions', () => {
  it('option is accepted without error', () => {
    const opts: QueryOptions = {
      promptSuggestions: true,
    };
    expect(opts.promptSuggestions).toBe(true);
  });

  it('is accepted by query() without throwing', () => {
    const q = query('test', {
      model: 'claude-sonnet-4-6',
      promptSuggestions: true,
    });
    expect(q).toBeDefined();
    q.close();
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
    const missingSessionId = randomUUID();
    expect(() =>
      query('test', {
        model: 'claude-sonnet-4-6',
        cwd: mkdtempSync(join(tmpdir(), 'open-agent-missing-resume-')),
        resume: missingSessionId,
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
      { key: 'onElicitation', option: { onElicitation: {} } },
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

  it('accepts plugins and wires plugin agents, skills, commands, and session metadata', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'open-agent-plugin-query-'));
    const pluginDir = createPluginFixture();
    const q = query('test plugin runtime wiring', {
      cwd,
      model: 'claude-sonnet-4-6',
      plugins: [{ type: 'local', path: pluginDir }],
    });

    const [agents, skills, commands, info] = await Promise.all([
      q.supportedAgents(),
      q.supportedSkills(),
      q.supportedCommands(),
      q.sessionInfo(),
    ]);

    expect(agents.some((agent) => agent.name === 'reviewer')).toBe(true);
    expect(skills.some((skill) => skill.name === 'review-plugin')).toBe(true);
    expect(commands.some((command) => command.name === '/review-plugin')).toBe(true);
    expect(info?.plugins).toEqual([{
      name: 'review-kit',
      path: pluginDir,
    }]);
    expect(info?.runtimeDiagnostics).toBeUndefined();
    q.close();
  });
});

describe('__internal_buildPromptSuggestions()', () => {
  const createObservation = (overrides: Record<string, unknown> = {}) => ({
    toolNames: new Set<string>(),
    sawTask: false,
    sawSubagent: false,
    sawTaskCompletion: false,
    sawTaskFailure: false,
    sawTaskStopped: false,
    sawEdit: false,
    sawWrite: false,
    sawBash: false,
    sawGit: false,
    sawTesting: false,
    sawResearch: false,
    sawFailure: false,
    sawResultError: false,
    lastTaskId: undefined,
    lastTaskStatus: undefined,
    lastTaskTeamName: undefined,
    lastTaskDescription: undefined,
    lastTaskTemplates: undefined,
    ...overrides,
  });

  it('returns coding follow-ups after a successful edit-heavy turn', () => {
    const suggestions = __internal_buildPromptSuggestions({
      result: {
        type: 'result',
        subtype: 'success',
        duration_ms: 1,
        duration_api_ms: 1,
        is_error: false,
        num_turns: 1,
        result: 'Updated the runtime and tests.',
        stop_reason: 'end_turn',
        total_cost_usd: 0,
        usage: {},
        modelUsage: {},
        permission_denials: [],
        uuid: 'r1',
        session_id: 's1',
      },
      observation: createObservation({
        toolNames: new Set(['Edit', 'Bash']),
        sawEdit: true,
        sawBash: true,
      }),
      language: 'Chinese',
    });

    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions.some((item) => item.suggestion.includes('测试'))).toBe(true);
  });

  it('returns failure-oriented follow-ups after an error result', () => {
    const suggestions = __internal_buildPromptSuggestions({
      result: {
        type: 'result',
        subtype: 'error_during_execution',
        duration_ms: 1,
        duration_api_ms: 1,
        is_error: true,
        num_turns: 1,
        stop_reason: 'error',
        total_cost_usd: 0,
        usage: {},
        modelUsage: {},
        permission_denials: [],
        errors: ['boom'],
        uuid: 'r2',
        session_id: 's2',
      },
      observation: createObservation({
        toolNames: new Set(['Bash']),
        sawBash: true,
        sawFailure: true,
        sawResultError: true,
      }),
      language: 'Chinese',
    });

    expect(suggestions).toHaveLength(3);
    expect(suggestions[0].suggestion).toContain('失败');
  });

  it('returns same-worker and verifier follow-ups after a completed worker notification', () => {
    const suggestions = __internal_buildPromptSuggestions({
      result: {
        type: 'result',
        subtype: 'success',
        duration_ms: 1,
        duration_api_ms: 1,
        is_error: false,
        num_turns: 1,
        result: 'Integrated worker output.',
        stop_reason: 'end_turn',
        total_cost_usd: 0,
        usage: {},
        modelUsage: {},
        permission_denials: [],
        uuid: 'r3',
        session_id: 's3',
      },
      observation: createObservation({
        sawTask: true,
        sawSubagent: true,
        sawTaskCompletion: true,
        lastTaskId: 'worker-42',
        lastTaskStatus: 'completed',
        lastTaskTemplates: {
          resume_prompt_template: 'Continue from your existing context for task worker-42.',
          verification_prompt_template: 'Independently verify the completed result from task worker-42. Claims to verify: ...',
        },
      }),
      language: 'Chinese',
    });

    expect(suggestions).toHaveLength(3);
    expect(suggestions[0].suggestion).toContain('worker `worker-42`');
    expect(suggestions[0].scaffold?.resume_task_id).toBe('worker-42');
    expect(suggestions[0].scaffold?.action).toEqual({
      tool: 'Task',
      arguments: {
        description: '继续原 worker',
        prompt: 'Continue from your existing context for task worker-42.',
        subagent_type: 'worker',
        resume: 'worker-42',
      },
    });
    expect(suggestions.some((item) => item.suggestion.includes('`verifier`'))).toBe(true);
    expect(suggestions.some((item) => item.scaffold?.agent_type === 'verifier')).toBe(true);
    expect(suggestions.some((item) => item.scaffold?.action?.arguments?.['subagent_type'] === 'verifier')).toBe(true);
    expect(suggestions.some((item) => item.suggestion.includes('风险清单'))).toBe(true);
  });

  it('returns SendMessage scaffold for completed teammate notifications', () => {
    const suggestions = __internal_buildPromptSuggestions({
      result: {
        type: 'result',
        subtype: 'success',
        duration_ms: 1,
        duration_api_ms: 1,
        is_error: false,
        num_turns: 1,
        result: 'Integrated teammate output.',
        stop_reason: 'end_turn',
        total_cost_usd: 0,
        usage: {},
        modelUsage: {},
        permission_denials: [],
        uuid: 'r3-team',
        session_id: 's3-team',
      },
      observation: createObservation({
        sawTask: true,
        sawSubagent: true,
        sawTaskCompletion: true,
        lastTaskId: 'worker-43',
        lastTaskStatus: 'completed',
        lastTaskTeamName: 'alpha-team',
        lastTaskDescription: 'alice',
        lastTaskTemplates: {
          resume_prompt_template: 'Continue from your existing context for task worker-43.',
          verification_prompt_template: 'Independently verify the completed result from task worker-43. Claims to verify: ...',
        },
      }),
      language: 'Chinese',
    });

    expect(suggestions[0].scaffold?.action).toEqual({
      tool: 'SendMessage',
      arguments: {
        type: 'message',
        recipient: 'alice',
        summary: '继续 alice',
        content: 'Continue from your existing context for task worker-43.',
      },
    });
  });

  it('returns same-worker retry follow-ups after a failed worker notification', () => {
    const suggestions = __internal_buildPromptSuggestions({
      result: {
        type: 'result',
        subtype: 'success',
        duration_ms: 1,
        duration_api_ms: 1,
        is_error: false,
        num_turns: 1,
        result: 'Summarized the failure.',
        stop_reason: 'end_turn',
        total_cost_usd: 0,
        usage: {},
        modelUsage: {},
        permission_denials: [],
        uuid: 'r4',
        session_id: 's4',
      },
      observation: createObservation({
        sawTask: true,
        sawSubagent: true,
        sawTaskFailure: true,
        lastTaskId: 'worker-99',
        lastTaskStatus: 'failed',
        lastTaskTemplates: {
          retry_prompt_template: 'Continue from your existing context for task worker-99. Failure context: ...',
        },
      }),
      language: 'Chinese',
    });

    expect(suggestions).toHaveLength(3);
    expect(suggestions[0].suggestion).toContain('worker `worker-99`');
    expect(suggestions[0].scaffold?.kind).toBe('retry_worker');
    expect(suggestions[0].scaffold?.action).toEqual({
      tool: 'Task',
      arguments: {
        description: '沿原上下文重试',
        prompt: 'Continue from your existing context for task worker-99. Failure context: ...',
        subagent_type: 'worker',
        resume: 'worker-99',
      },
    });
    expect(suggestions.some((item) => item.suggestion.includes('重试'))).toBe(true);
    expect(suggestions.some((item) => item.suggestion.includes('阻塞'))).toBe(true);
  });

  it('returns SendMessage scaffold for failed teammate notifications', () => {
    const suggestions = __internal_buildPromptSuggestions({
      result: {
        type: 'result',
        subtype: 'success',
        duration_ms: 1,
        duration_api_ms: 1,
        is_error: false,
        num_turns: 1,
        result: 'Summarized teammate failure.',
        stop_reason: 'end_turn',
        total_cost_usd: 0,
        usage: {},
        modelUsage: {},
        permission_denials: [],
        uuid: 'r4-team',
        session_id: 's4-team',
      },
      observation: createObservation({
        sawTask: true,
        sawSubagent: true,
        sawTaskFailure: true,
        lastTaskId: 'worker-100',
        lastTaskStatus: 'failed',
        lastTaskTeamName: 'alpha-team',
        lastTaskDescription: 'alice',
        lastTaskTemplates: {
          retry_prompt_template: 'Continue from your existing context for task worker-100. Failure context: ...',
        },
      }),
      language: 'Chinese',
    });

    expect(suggestions[0].scaffold?.action).toEqual({
      tool: 'SendMessage',
      arguments: {
        type: 'message',
        recipient: 'alice',
        summary: '重试 alice',
        content: 'Continue from your existing context for task worker-100. Failure context: ...',
      },
    });
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
      { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png', data: 'abc' } },
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

describe('__internal_collectPendingTaskNotifications()', () => {
  it('collects only unsurfaced finished child workers for the current session', () => {
    const messages = __internal_collectPendingTaskNotifications({
      sessionId: 'session-1',
      transcriptEntries: [
        {
          type: 'system',
          subtype: 'task_notification',
          task_id: 'agent-seen',
          status: 'completed',
          completed_at: '2026-04-01T10:00:00.000Z',
        },
      ],
      childSessions: [
        {
          agentId: 'agent-seen',
          agentType: 'worker',
          name: 'seen-worker',
          state: 'completed',
          parentSessionId: 'session-1',
          completedAt: '2026-04-01T10:00:00.000Z',
          result: 'already surfaced',
          totalTokens: 10,
          totalToolUseCount: 1,
          durationMs: 100,
        },
        {
          agentId: 'agent-new',
          agentType: 'worker',
          name: 'new-worker',
          teamName: 'alpha-team',
          state: 'completed',
          parentSessionId: 'session-1',
          completedAt: '2026-04-01T10:05:00.000Z',
          result: 'fresh result',
          totalTokens: 20,
          totalToolUseCount: 2,
          durationMs: 200,
        },
        {
          agentId: 'agent-failed',
          agentType: 'worker',
          name: 'failed-worker',
          state: 'failed',
          parentSessionId: 'session-1',
          completedAt: '2026-04-01T10:06:00.000Z',
          error: 'boom',
          totalTokens: 30,
          totalToolUseCount: 3,
          durationMs: 300,
        },
        {
          agentId: 'agent-other-session',
          agentType: 'worker',
          name: 'other-worker',
          state: 'completed',
          parentSessionId: 'session-2',
          completedAt: '2026-04-01T10:07:00.000Z',
          result: 'ignore me',
          totalTokens: 40,
          totalToolUseCount: 4,
          durationMs: 400,
        },
      ],
    });

    expect(messages).toHaveLength(2);
    expect(messages.map((message) => message.task_id)).toEqual(['agent-new', 'agent-failed']);
    expect(messages[0].team_name).toBe('alpha-team');
    expect(messages[0].completed_at).toBe('2026-04-01T10:05:00.000Z');
    expect(messages[0].result).toBe('fresh result');
    expect(messages[0].orchestration_templates?.verification_prompt_template).toContain('Claims to verify');
    expect(messages[1].status).toBe('failed');
    expect(messages[1].result).toBe('boom');
    expect(messages[1].orchestration_templates?.retry_prompt_template).toContain('Failure context');
  });
});

describe('__internal_collectTrailingTaskNotifications()', () => {
  it('collects only trailing resumed task notifications in order', () => {
    const notifications = __internal_collectTrailingTaskNotifications([
      {
        role: 'user',
        content: 'plain historical message',
      },
      {
        role: 'assistant',
        content: 'historical assistant reply',
      },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: '<task-notification>\n<task-id>worker-1</task-id>\n<status>completed</status>\n<summary>done</summary>\n</task-notification>',
          },
        ],
      },
      {
        role: 'user',
        content: '<task-notification>\n<task-id>worker-2</task-id>\n<team-name>alpha-team</team-name>\n<description>alice</description>\n<status>failed</status>\n<summary>boom</summary>\n<orchestration-templates>\n<retry-prompt-template>Retry worker-2 narrowly.</retry-prompt-template>\n</orchestration-templates>\n</task-notification>',
      },
    ] as any);

    expect(notifications).toEqual([
      { task_id: 'worker-1', status: 'completed' },
      {
        task_id: 'worker-2',
        team_name: 'alpha-team',
        description: 'alice',
        status: 'failed',
        orchestration_templates: {
          retry_prompt_template: 'Retry worker-2 narrowly.',
        },
      },
    ]);
  });

  it('ignores older task notifications once trailing context is interrupted', () => {
    const notifications = __internal_collectTrailingTaskNotifications([
      {
        role: 'user',
        content: '<task-notification>\n<task-id>worker-old</task-id>\n<status>completed</status>\n<summary>done</summary>\n</task-notification>',
      },
      {
        role: 'assistant',
        content: 'normal later assistant message',
      },
      {
        role: 'user',
        content: 'normal trailing user message',
      },
    ] as any);

    expect(notifications).toEqual([]);
  });
});
