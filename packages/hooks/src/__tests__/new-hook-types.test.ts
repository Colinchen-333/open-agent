/**
 * Tests for the three new hook types: prompt, http, and agent.
 */
import { describe, expect, it, test } from 'bun:test';
import { HookExecutor } from '../executor.js';
import type {
  AgentHookDefinition,
  HttpHookDefinition,
  PromptHookDefinition,
} from '../types.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function makePreToolInput() {
  return {
    hook_event_name: 'PreToolUse' as const,
    session_id: 'sess-42',
    transcript_path: '/tmp/sess-42.jsonl',
    cwd: '/workspace',
    permission_mode: 'default',
    tool_name: 'Bash',
    tool_input: { command: 'ls' },
    tool_use_id: 'tu-42',
  };
}

function makeSessionStartInput() {
  return {
    hook_event_name: 'SessionStart' as const,
    session_id: 'sess-start',
    transcript_path: '/tmp/start.jsonl',
    cwd: '/workspace',
    source: 'startup' as const,
  };
}

// ===========================================================================
// Prompt hook tests
// ===========================================================================

describe('PromptHookDefinition', () => {
  it('returns the template text as additionalContext', async () => {
    const executor = new HookExecutor();
    const hook: PromptHookDefinition = {
      type: 'prompt',
      template: 'Always double-check before deleting files.',
    };
    executor.registerPromptHook('PreToolUse', hook);

    const result = await executor.execute('PreToolUse', makePreToolInput());
    expect(result.continue).toBeTruthy();
    expect(result.additionalContext).toBe('Always double-check before deleting files.');
  });

  it('renders {{toolName}} placeholder', async () => {
    const executor = new HookExecutor();
    const hook: PromptHookDefinition = {
      type: 'prompt',
      template: 'Tool {{toolName}} is about to run.',
    };
    executor.registerPromptHook('PreToolUse', hook);

    const result = await executor.execute('PreToolUse', makePreToolInput());
    expect(result.additionalContext).toBe('Tool Bash is about to run.');
  });

  it('renders {{event}} and {{sessionId}} placeholders', async () => {
    const executor = new HookExecutor();
    const hook: PromptHookDefinition = {
      type: 'prompt',
      template: 'Event: {{event}} | Session: {{sessionId}}',
    };
    executor.registerPromptHook('SessionStart', hook);

    const result = await executor.execute('SessionStart', makeSessionStartInput());
    expect(result.additionalContext).toBe('Event: SessionStart | Session: sess-start');
  });

  it('respects matcher: skips hook when tool_name does not match', async () => {
    const executor = new HookExecutor();
    const hook: PromptHookDefinition = {
      type: 'prompt',
      template: 'Write tool context',
      matcher: 'Write',
    };
    executor.registerPromptHook('PreToolUse', hook);

    // Input has tool_name 'Bash', not 'Write' — hook must be skipped.
    const result = await executor.execute('PreToolUse', makePreToolInput());
    expect(result.additionalContext).toBeUndefined();
  });

  it('concatenates additionalContext from multiple prompt hooks', async () => {
    const executor = new HookExecutor();
    executor.registerPromptHook('PreToolUse', {
      type: 'prompt',
      template: 'Instruction A.',
    });
    executor.registerPromptHook('PreToolUse', {
      type: 'prompt',
      template: 'Instruction B.',
    });

    const result = await executor.execute('PreToolUse', makePreToolInput());
    expect(result.additionalContext).toBe('Instruction A.\nInstruction B.');
  });

  it('is registered via registerHook dispatch and loadAnyFromConfig', async () => {
    const executor = new HookExecutor();
    executor.loadAnyFromConfig({
      PreToolUse: [
        { type: 'prompt', template: 'Loaded from config.' } satisfies PromptHookDefinition,
      ],
    });

    const result = await executor.execute('PreToolUse', makePreToolInput());
    expect(result.additionalContext).toBe('Loaded from config.');
  });
});

// ===========================================================================
// HTTP hook tests
// ===========================================================================

describe('HttpHookDefinition', () => {
  it('returns continue:true and no additionalContext when server responds with empty body', async () => {
    // Spin up a tiny HTTP server that returns 200 with an empty body.
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response('', { status: 200 });
      },
    });

    try {
      const executor = new HookExecutor();
      const hook: HttpHookDefinition = {
        type: 'http',
        url: `http://localhost:${server.port}/hook`,
      };
      executor.registerHttpHook('PreToolUse', hook);

      const result = await executor.execute('PreToolUse', makePreToolInput());
      expect(result.continue).toBeTruthy();
      expect(result.additionalContext).toBeUndefined();
    } finally {
      server.stop(true);
    }
  });

  it('parses a valid JSON HookOutput from the server response', async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(
          JSON.stringify({ continue: true, additionalContext: 'webhook-ok' }),
          { headers: { 'Content-Type': 'application/json' } },
        );
      },
    });

    try {
      const executor = new HookExecutor();
      executor.registerHttpHook('PreToolUse', {
        type: 'http',
        url: `http://localhost:${server.port}/hook`,
      });

      const result = await executor.execute('PreToolUse', makePreToolInput());
      expect(result.additionalContext).toBe('webhook-ok');
    } finally {
      server.stop(true);
    }
  });

  it('attaches non-JSON response body as additionalContext', async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response('plain text response', { status: 200 });
      },
    });

    try {
      const executor = new HookExecutor();
      executor.registerHttpHook('PreToolUse', {
        type: 'http',
        url: `http://localhost:${server.port}/hook`,
      });

      const result = await executor.execute('PreToolUse', makePreToolInput());
      expect(result.additionalContext).toBe('plain text response');
    } finally {
      server.stop(true);
    }
  });

  it('allows execution to continue when HTTP request fails (network error)', async () => {
    const executor = new HookExecutor();
    // Port 1 is effectively unreachable.
    executor.registerHttpHook('PreToolUse', {
      type: 'http',
      url: 'http://127.0.0.1:1/hook',
      timeout: 1, // 1 second timeout so the test completes quickly
    });

    // The hook error must be caught internally and not propagate.
    const result = await executor.execute('PreToolUse', makePreToolInput());
    // No output means the merge of zero results → { continue: true }.
    expect(result.continue).toBeTruthy();
  });

  it('sends enriched camelCase JSON body to the server', async () => {
    let receivedBody: unknown = null;

    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        receivedBody = await req.json();
        return new Response('{}');
      },
    });

    try {
      const executor = new HookExecutor();
      executor.registerHttpHook('PreToolUse', {
        type: 'http',
        url: `http://localhost:${server.port}/hook`,
      });

      await executor.execute('PreToolUse', makePreToolInput());
      expect((receivedBody as any).hook_event_name).toBe('PreToolUse');
      expect((receivedBody as any).hookEvent).toBe('PreToolUse'); // camelCase alias
      expect((receivedBody as any).tool_name).toBe('Bash');
      expect((receivedBody as any).toolName).toBe('Bash');
    } finally {
      server.stop(true);
    }
  });

  it('forwards custom headers to the server', async () => {
    let receivedAuth: string | null = null;

    const server = Bun.serve({
      port: 0,
      fetch(req) {
        receivedAuth = req.headers.get('Authorization');
        return new Response('{}');
      },
    });

    try {
      const executor = new HookExecutor();
      executor.registerHttpHook('PreToolUse', {
        type: 'http',
        url: `http://localhost:${server.port}/hook`,
        headers: { Authorization: 'Bearer secret-token' },
      });

      await executor.execute('PreToolUse', makePreToolInput());
      expect(receivedAuth as unknown as string).toBe('Bearer secret-token');
    } finally {
      server.stop(true);
    }
  });
});

// ===========================================================================
// Agent hook tests
// ===========================================================================

describe('AgentHookDefinition', () => {
  it('surfaces agentName in hookSpecificOutput', async () => {
    const executor = new HookExecutor();
    const hook: AgentHookDefinition = {
      type: 'agent',
      agentName: 'security-checker',
    };
    executor.registerAgentHook('PreToolUse', hook);

    const result = await executor.execute('PreToolUse', makePreToolInput());
    expect(result.continue).toBeTruthy();
    expect(result.hookSpecificOutput?.agentName).toBe('security-checker');
  });

  it('renders a prompt template and includes it in hookSpecificOutput', async () => {
    const executor = new HookExecutor();
    executor.registerAgentHook('PreToolUse', {
      type: 'agent',
      agentName: 'audit-agent',
      prompt: 'Review {{toolName}} call in session {{sessionId}}.',
    });

    const result = await executor.execute('PreToolUse', makePreToolInput());
    expect(result.hookSpecificOutput?.agentName).toBe('audit-agent');
    expect(result.hookSpecificOutput?.prompt).toBe(
      'Review Bash call in session sess-42.',
    );
  });

  it('omits prompt key when no prompt template is provided', async () => {
    const executor = new HookExecutor();
    executor.registerAgentHook('PreToolUse', {
      type: 'agent',
      agentName: 'watcher',
    });

    const result = await executor.execute('PreToolUse', makePreToolInput());
    expect(result.hookSpecificOutput?.agentName).toBe('watcher');
    expect(result.hookSpecificOutput).not.toHaveProperty('prompt');
  });

  it('respects matcher: skips hook when tool_name does not match', async () => {
    const executor = new HookExecutor();
    executor.registerAgentHook('PreToolUse', {
      type: 'agent',
      agentName: 'write-auditor',
      matcher: 'Write',
    });

    // Bash does not match 'Write' — hookSpecificOutput must be absent.
    const result = await executor.execute('PreToolUse', makePreToolInput());
    expect(result.hookSpecificOutput).toBeUndefined();
  });

  it('is registered via loadAnyFromConfig', async () => {
    const executor = new HookExecutor();
    executor.loadAnyFromConfig({
      PreToolUse: [
        {
          type: 'agent',
          agentName: 'config-agent',
          prompt: 'Event: {{event}}',
        } satisfies AgentHookDefinition,
      ],
    });

    const result = await executor.execute('PreToolUse', makePreToolInput());
    expect(result.hookSpecificOutput?.agentName).toBe('config-agent');
    expect(result.hookSpecificOutput?.prompt).toBe('Event: PreToolUse');
  });
});

// ===========================================================================
// getHookSurface — new types included in count
// ===========================================================================

test('getHookSurface counts prompt, http, and agent hooks', () => {
  const executor = new HookExecutor();

  executor.registerPromptHook('PreToolUse', { type: 'prompt', template: 'A' });
  executor.registerHttpHook('PreToolUse', {
    type: 'http',
    url: 'http://example.com',
  });
  executor.registerAgentHook('PreToolUse', {
    type: 'agent',
    agentName: 'bot',
  });
  executor.registerShellHook('PreToolUse', {
    command: "echo '{}'",
  });

  const surface = executor.getHookSurface();
  expect(surface).toHaveLength(1);
  expect(surface[0].event).toBe('PreToolUse');
  expect(surface[0].count).toBe(4);
  expect(surface[0].sources).toContain('prompt');
  expect(surface[0].sources).toContain('http');
  expect(surface[0].sources).toContain('agent');
  expect(surface[0].sources).toContain('shell');
});
