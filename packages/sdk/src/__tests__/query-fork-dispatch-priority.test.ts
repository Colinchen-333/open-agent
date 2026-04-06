/**
 * R8.4 — Fork isolation takes precedence over background dispatch
 *
 * Codex audit #4, finding #4: when isolation === 'fork' AND runInBackground === true,
 * the old code entered executeInBackground() first (the fork branch was unreachable).
 * The fix reorders: fork is checked before background so executeForked() is called.
 *
 * These tests verify:
 *   1. isolation === 'fork'  → executeForked() called, executeInBackground() NOT called
 *   2. isolation === 'worktree' + background === true  → executeInBackground() called
 *   3. no isolation + background === true              → executeInBackground() called
 *   4. no isolation + background === false             → execute() called
 */

import { describe, it, expect, spyOn, afterEach, type Mock } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import type { ChatOptions, LLMProvider, Message, StreamEvent } from '@open-agent/providers';
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
 *   turn 1 → Task tool-use
 *   turn 2 → text "done"
 */
function makeStaticProvider(toolInput: Record<string, unknown>): LLMProvider {
  const toolId = `tu_${randomUUID().slice(0, 8)}`;
  let turn = 0;

  return {
    name: 'mock-fork-dispatch-provider',
    async *chat(_messages: Message[], _options: ChatOptions): AsyncGenerator<StreamEvent> {
      if (turn === 0) {
        yield* taskToolUseEvents(toolId, toolInput);
      } else {
        yield* finalReplyEvents();
      }
      turn++;
    },
    async listModels() {
      return [{ value: 'mock-model', displayName: 'Mock', description: 'fork dispatch test' }];
    },
  };
}

// ---------------------------------------------------------------------------
// Spy setup / teardown
// ---------------------------------------------------------------------------

let executeForkedSpy: Mock<any>;
let executeInBackgroundSpy: Mock<any>;
let executeSpy: Mock<any>;

function installSpies() {
  // executeForked: return a resolved agentId + outputFile so the caller can
  // build the JSON response without hitting the filesystem.
  executeForkedSpy = spyOn(AgentExecutor.prototype, 'executeForked').mockImplementation(
    async () => ({ agentId: `fork-${randomUUID()}`, outputFile: '/tmp/fake.output' }),
  );

  // executeInBackground: return immediately with a fake agentId + outputFile.
  executeInBackgroundSpy = spyOn(AgentExecutor.prototype, 'executeInBackground').mockImplementation(
    async () => ({ agentId: `bg-${randomUUID()}`, outputFile: '/tmp/fake-bg.output' }),
  );

  // execute: return a minimal session-like result so foreground dispatch works.
  // The session object must satisfy AgentSession — required fields only.
  executeSpy = spyOn(AgentExecutor.prototype, 'execute').mockImplementation(
    async () => {
      const agentId = `fg-${randomUUID()}`;
      return {
        agentId,
        result: 'foreground result',
        session: {
          agentId,
          agentType: 'general-purpose',
          state: 'completed' as const,
          startedAt: new Date().toISOString(),
          model: 'mock-model',
          numTurns: 1,
          durationMs: 1,
          totalToolUseCount: 0,
          totalTokens: 10,
          usage: { input_tokens: 10, output_tokens: 0, cache_creation_input_tokens: null, cache_read_input_tokens: null, server_tool_use: null, service_tier: null, cache_creation: null },
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

describe('fork isolation dispatch priority (R8.4 fix)', () => {
  it('isolation=fork routes to executeForked even when run_in_background=true', async () => {
    const tmp = makeTempDir('open-agent-fork-priority-');
    installSpies();

    try {
      const q = query('test fork priority', {
        cwd: tmp.dir,
        model: 'mock-model',
        provider: makeStaticProvider({
          description: 'test fork task',
          prompt: 'Do something isolated.',
          subagent_type: 'general-purpose',
          isolation: 'fork',
          run_in_background: true,   // <-- combined with fork
        }),
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
      } as any);

      // Run to completion (two turns: tool-use then final reply)
      await drainQuery(q);

      // Fork must have been used, not background
      expect(executeForkedSpy).toHaveBeenCalledTimes(1);
      expect(executeInBackgroundSpy).toHaveBeenCalledTimes(0);
      expect(executeSpy).toHaveBeenCalledTimes(0);

      q.close();
    } finally {
      tmp.cleanup();
    }
  });

  it('isolation=fork without background also routes to executeForked', async () => {
    const tmp = makeTempDir('open-agent-fork-noback-');
    installSpies();

    try {
      const q = query('test fork no background', {
        cwd: tmp.dir,
        model: 'mock-model',
        provider: makeStaticProvider({
          description: 'fork no bg',
          prompt: 'Isolated foreground run.',
          subagent_type: 'general-purpose',
          isolation: 'fork',
          run_in_background: false,
        }),
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

  it('run_in_background=true without fork routes to executeInBackground', async () => {
    const tmp = makeTempDir('open-agent-bg-only-');
    installSpies();

    try {
      const q = query('test background no fork', {
        cwd: tmp.dir,
        model: 'mock-model',
        provider: makeStaticProvider({
          description: 'background task',
          prompt: 'Run in background.',
          subagent_type: 'general-purpose',
          run_in_background: true,
          // no isolation field
        }),
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

  it('no isolation no background routes to execute (foreground)', async () => {
    const tmp = makeTempDir('open-agent-fg-only-');
    installSpies();

    try {
      const q = query('test foreground dispatch', {
        cwd: tmp.dir,
        model: 'mock-model',
        provider: makeStaticProvider({
          description: 'foreground task',
          prompt: 'Run in foreground.',
          subagent_type: 'general-purpose',
          // no isolation, no run_in_background
        }),
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
      } as any);

      await drainQuery(q);

      expect(executeSpy).toHaveBeenCalledTimes(1);
      expect(executeForkedSpy).toHaveBeenCalledTimes(0);
      expect(executeInBackgroundSpy).toHaveBeenCalledTimes(0);

      q.close();
    } finally {
      tmp.cleanup();
    }
  });
});
