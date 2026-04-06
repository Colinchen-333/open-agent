/**
 * R11 — AgentDefinition fallback for isolation and allowBackgroundExecution
 *
 * Codex audit #7, findings:
 *   Fix 1: when the model does NOT supply an isolation field in the Task tool
 *           input, the dispatch should fall back to agentDef.isolation.
 *   Fix 2: when the model does NOT supply run_in_background in the Task tool
 *           input, the dispatch should fall back to agentDef.allowBackgroundExecution.
 *   Fix 3: explicit run_in_background: false in the tool input must override
 *           agentDef.allowBackgroundExecution: true.
 *
 * These tests verify:
 *   1. agentDef.isolation = 'fork', no isolation in tool input → executeForked()
 *   2. agentDef.allowBackgroundExecution = true, no run_in_background in tool input → executeInBackground()
 *   3. run_in_background = false in tool input overrides agentDef.allowBackgroundExecution: true → execute()
 */

import { describe, it, expect, spyOn, afterEach, type Mock } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import type { ChatOptions, LLMProvider, Message, StreamEvent } from '@open-agent/providers';
import type { AgentDefinition } from '@open-agent/core';
import { AgentExecutor } from '@open-agent/agents';
import { query } from '../query.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(prefix: string): { dir: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(dir, '.open-agent'), { recursive: true });
  return {
    dir,
    cleanup() { rmSync(dir, { recursive: true, force: true }); },
  };
}

/** Drain an AsyncGenerator to completion; returns all yielded values. */
async function drainQuery(q: AsyncGenerator<unknown>): Promise<unknown[]> {
  const messages: unknown[] = [];
  for await (const msg of q) {
    messages.push(msg);
  }
  return messages;
}

/** Build stream events that emit a single Task tool-use call then stop. */
function taskToolUseEvents(
  toolId: string,
  input: Record<string, unknown>,
): StreamEvent[] {
  return [
    { type: 'tool_use_start', id: toolId, name: 'Task' },
    { type: 'tool_use_delta', id: toolId, partial_json: JSON.stringify(input) },
    { type: 'tool_use_end', id: toolId },
    { type: 'message_end', message: {}, usage: { input_tokens: 10, output_tokens: 5 } },
  ];
}

/** After the tool result is returned to the provider, yield a final text reply. */
function finalReplyEvents(): StreamEvent[] {
  return [
    { type: 'text_delta', text: 'done' },
    { type: 'message_end', message: {}, usage: { input_tokens: 5, output_tokens: 2 } },
  ];
}

/**
 * A static two-turn provider:
 *   turn 1 → Task tool-use with provided input
 *   turn 2 → text "done"
 */
function makeStaticProvider(toolInput: Record<string, unknown>): LLMProvider {
  const toolId = `tu_${randomUUID().slice(0, 8)}`;
  let turn = 0;

  return {
    name: 'mock-agentdef-fallback-provider',
    async *chat(_messages: Message[], _options: ChatOptions): AsyncGenerator<StreamEvent> {
      if (turn === 0) {
        yield* taskToolUseEvents(toolId, toolInput);
      } else {
        yield* finalReplyEvents();
      }
      turn++;
    },
    async listModels() {
      return [{ value: 'mock-model', displayName: 'Mock', description: 'agentdef fallback test' }];
    },
  };
}

/** Minimal AgentDefinition with just the fields needed for these tests. */
function makeAgentDef(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    name: 'fork-agent',
    description: 'Test agent with isolation/background defaults',
    prompt: 'You are a test agent.',
    tools: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Spy setup / teardown
// ---------------------------------------------------------------------------

let executeForkedSpy: Mock<any>;
let executeInBackgroundSpy: Mock<any>;
let executeSpy: Mock<any>;

function installSpies() {
  executeForkedSpy = spyOn(AgentExecutor.prototype, 'executeForked').mockImplementation(
    async () => ({ agentId: `fork-${randomUUID()}`, outputFile: '/tmp/fake.output' }),
  );

  executeInBackgroundSpy = spyOn(AgentExecutor.prototype, 'executeInBackground').mockImplementation(
    async () => ({ agentId: `bg-${randomUUID()}`, outputFile: '/tmp/fake-bg.output' }),
  );

  executeSpy = spyOn(AgentExecutor.prototype, 'execute').mockImplementation(
    async () => {
      const agentId = `fg-${randomUUID()}`;
      return {
        agentId,
        result: 'foreground result',
        session: {
          agentId,
          agentType: 'fork-agent',
          state: 'completed' as const,
          startedAt: new Date().toISOString(),
          model: 'mock-model',
          numTurns: 1,
          durationMs: 1,
          totalToolUseCount: 0,
          totalTokens: 10,
          usage: {
            input_tokens: 10,
            output_tokens: 0,
            cache_creation_input_tokens: null,
            cache_read_input_tokens: null,
            server_tool_use: null,
            service_tier: null,
            cache_creation: null,
          },
        },
      };
    },
  );
}

function restoreSpies() {
  executeForkedSpy?.mockRestore();
  executeInBackgroundSpy?.mockRestore();
  executeSpy?.mockRestore();
}

afterEach(() => {
  restoreSpies();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentDefinition fallback for isolation and allowBackgroundExecution (R11)', () => {
  it('Fix 1: agentDef.isolation=fork with no isolation in tool input routes to executeForked', async () => {
    const tmp = makeTempDir('open-agent-r11-agentdef-isolation-');
    installSpies();

    try {
      const q = query('test agentdef isolation fallback', {
        cwd: tmp.dir,
        model: 'mock-model',
        provider: makeStaticProvider({
          description: 'fork via agent def',
          prompt: 'Run with agent-def isolation.',
          subagent_type: 'fork-agent',
          // No isolation field — should fall back to agentDef.isolation = 'fork'
        }),
        agents: {
          'fork-agent': makeAgentDef({ isolation: 'fork' }),
        },
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
      } as any);

      await drainQuery(q);

      expect(executeForkedSpy).toHaveBeenCalledTimes(1);
      expect(executeInBackgroundSpy).toHaveBeenCalledTimes(0);
      expect(executeSpy).toHaveBeenCalledTimes(0);

      q.close();
    } finally {
      tmp.cleanup();
    }
  });

  it('Fix 2: agentDef.allowBackgroundExecution=true with no run_in_background routes to executeInBackground', async () => {
    const tmp = makeTempDir('open-agent-r11-agentdef-bg-');
    installSpies();

    try {
      const q = query('test agentdef allowBackgroundExecution fallback', {
        cwd: tmp.dir,
        model: 'mock-model',
        provider: makeStaticProvider({
          description: 'background via agent def',
          prompt: 'Run with agent-def background default.',
          subagent_type: 'fork-agent',
          // No run_in_background field — should fall back to agentDef.allowBackgroundExecution
        }),
        agents: {
          'fork-agent': makeAgentDef({ allowBackgroundExecution: true }),
        },
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
      } as any);

      await drainQuery(q);

      expect(executeInBackgroundSpy).toHaveBeenCalledTimes(1);
      expect(executeForkedSpy).toHaveBeenCalledTimes(0);
      expect(executeSpy).toHaveBeenCalledTimes(0);

      q.close();
    } finally {
      tmp.cleanup();
    }
  });

  it('Fix 3: explicit run_in_background=false overrides agentDef.allowBackgroundExecution=true', async () => {
    const tmp = makeTempDir('open-agent-r11-explicit-override-');
    installSpies();

    try {
      const q = query('test explicit override of agentdef background', {
        cwd: tmp.dir,
        model: 'mock-model',
        provider: makeStaticProvider({
          description: 'explicit foreground override',
          prompt: 'Caller forces foreground despite agent def.',
          subagent_type: 'fork-agent',
          run_in_background: false, // explicit false must override agentDef.allowBackgroundExecution: true
        }),
        agents: {
          'fork-agent': makeAgentDef({ allowBackgroundExecution: true }),
        },
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
      } as any);

      await drainQuery(q);

      // Foreground execute() must have been called, NOT background
      expect(executeSpy).toHaveBeenCalledTimes(1);
      expect(executeInBackgroundSpy).toHaveBeenCalledTimes(0);
      expect(executeForkedSpy).toHaveBeenCalledTimes(0);

      q.close();
    } finally {
      tmp.cleanup();
    }
  });
});
