import { describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ChatOptions, LLMProvider, Message, StreamEvent } from '@open-agent/providers';
import type { ModelInfo } from '@open-agent/core';
import { query } from '../query.js';
import { createSession } from '../session.js';

function makeTempHome(prefix: string): { cwd: string; cleanup(): void } {
  const cwd = mkdtempSync(join(tmpdir(), prefix));
  const home = join(cwd, 'home');
  mkdirSync(home, { recursive: true });
  const originalHome = process.env.HOME;
  process.env.HOME = home;

  return {
    cwd,
    cleanup() {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      rmSync(cwd, { recursive: true, force: true });
    },
  };
}

function makeCapabilityProvider(): LLMProvider {
  return {
    name: 'mock-audit-provider',
    async *chat(): AsyncGenerator<StreamEvent> {
      yield { type: 'text_delta', text: 'ok' };
      yield { type: 'message_end', message: {}, usage: { input_tokens: 1, output_tokens: 1 } };
    },
    async listModels(): Promise<ModelInfo[]> {
      return [{
        value: 'mock-model',
        displayName: 'Mock Model',
        description: 'Capability model',
        supportsThinking: false,
        supportsStructuredOutput: true,
        supportsImages: false,
        supportsServerTools: false,
        supportsEffort: true,
        supportedEffortLevels: ['low', 'medium'],
      }];
    },
    async getCapabilities(model?: string) {
      return {
        provider: 'mock-audit-provider',
        ...(model ? { model } : {}),
        thinking: 'unsupported' as const,
        structuredOutput: 'native' as const,
        toolUse: 'native' as const,
        serverTools: 'unsupported' as const,
        supportsAdaptiveThinking: false,
        supportedEffortLevels: ['low', 'medium'] as const,
      };
    },
  };
}

function makeBlockingProvider(): LLMProvider {
  return {
    name: 'mock-blocking-provider',
    async *chat(_messages: Message[], options: ChatOptions): AsyncGenerator<StreamEvent> {
      await new Promise<void>((resolve) => {
        if (options.signal?.aborted) {
          resolve();
          return;
        }
        options.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      throw new Error('aborted for test');
    },
    async listModels(): Promise<ModelInfo[]> {
      return [{
        value: 'mock-model',
        displayName: 'Mock Model',
        description: 'Blocking model',
        supportsThinking: false,
        supportsStructuredOutput: true,
      }];
    },
    async getCapabilities(model?: string) {
      return {
        provider: 'mock-blocking-provider',
        ...(model ? { model } : {}),
        thinking: 'unsupported' as const,
        structuredOutput: 'native' as const,
        toolUse: 'native' as const,
        serverTools: 'unsupported' as const,
        supportsAdaptiveThinking: false,
        supportedEffortLevels: [],
      };
    },
  };
}

async function waitForSubagentCount(
  getCount: () => Promise<number>,
  expectedAtLeast: number,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if ((await getCount()) >= expectedAtLeast) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${expectedAtLeast} running subagent(s).`);
}

describe('SDK audit alignment surfaces', () => {
  it('exposes provider capabilities and convenience predicates through query/session', async () => {
    const temp = makeTempHome('open-agent-sdk-audit-capabilities-');
    try {
      const q = query('hello', {
        cwd: temp.cwd,
        provider: makeCapabilityProvider(),
        model: 'mock-model',
      });

      expect(await q.getProviderCapabilities()).toMatchObject({
        provider: 'mock-audit-provider',
        model: 'mock-model',
        thinkingMode: 'unsupported',
        structuredOutputMode: 'native',
        supportsThinking: false,
        supportsStructuredOutput: true,
        supportedEffortLevels: ['low', 'medium'],
      });
      expect(await q.supportsThinking()).toBe(false);
      expect(await q.supportsStructuredOutput()).toBe(true);
      q.close();

      const session = createSession({
        cwd: temp.cwd,
        provider: makeCapabilityProvider(),
        model: 'mock-model',
      });
      expect(await session.getSessionState()).toMatchObject({
        status: 'idle',
        canAcceptInput: true,
      });
      expect(await session.getProviderCapabilities()).toMatchObject({
        provider: 'mock-audit-provider',
        structuredOutputMode: 'native',
        supportsStructuredOutput: true,
      });
      expect(await session.supportsThinking()).toBe(false);
      expect(await session.supportsStructuredOutput()).toBe(true);
      session.close();
    } finally {
      temp.cleanup();
    }
  });

  it('hot-plugs runtime tools without restarting the query', async () => {
    const temp = makeTempHome('open-agent-sdk-audit-tools-');
    try {
      const q = query('hello', {
        cwd: temp.cwd,
        provider: makeCapabilityProvider(),
        model: 'mock-model',
      });

      expect((await q.listRegisteredTools()).some((entry) => entry.name === 'RuntimeEcho')).toBe(false);

      const mutation = await q.registerRuntimeTools([{
        name: 'RuntimeEcho',
        description: 'Runtime test tool',
        inputSchema: {
          type: 'object',
          properties: {
            text: { type: 'string' },
          },
          required: ['text'],
        },
        async execute(input: { text: string }) {
          return input.text;
        },
      }]);

      expect(mutation).toEqual({ added: ['RuntimeEcho'], replaced: [] });
      expect((await q.listRegisteredTools()).some((entry) => entry.name === 'RuntimeEcho')).toBe(true);
      expect(await q.unregisterRuntimeTools(['RuntimeEcho'])).toEqual({ removed: ['RuntimeEcho'] });
      expect((await q.listRegisteredTools()).some((entry) => entry.name === 'RuntimeEcho')).toBe(false);
      q.close();
    } finally {
      temp.cleanup();
    }
  });

  it('enumerates and cancels running subagents through SDK aliases', async () => {
    const temp = makeTempHome('open-agent-sdk-audit-subagents-');
    try {
      const q = query('launch subagent aliases', {
        cwd: temp.cwd,
        provider: makeBlockingProvider(),
        model: 'mock-model',
      });

      const worker = await q.launchWorker({
        prompt: 'Investigate the codebase.',
        name: 'audit-worker',
      });

      await waitForSubagentCount(async () => (await q.listRunningSubagents()).length, 1);
      const subagents = await q.listRunningSubagents();
      expect(subagents.some((entry) => entry.workerId === worker.workerId)).toBe(true);
      expect(await q.cancelSubagent(worker.workerId)).toEqual({ success: true });
      q.close();
    } finally {
      temp.cleanup();
    }
  });
});
