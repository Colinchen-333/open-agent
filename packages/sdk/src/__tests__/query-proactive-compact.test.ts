import { describe, expect, it } from 'bun:test';
import type { ChatOptions, LLMProvider, Message, StreamEvent } from '@open-agent/providers';
import type { ModelInfo } from '@open-agent/core';
import { ConversationLoop } from '@open-agent/core';
import { query } from '../query.js';
import { makeLockedTempHome as makeTempHome } from './temp-home.js';

function makeImmediateProvider(): LLMProvider {
  return {
    name: 'mock-immediate-provider',
    async *chat(_messages: Message[], _options: ChatOptions): AsyncGenerator<StreamEvent> {
      yield { type: 'text_delta', text: 'done' };
      yield { type: 'message_end', message: {}, usage: { input_tokens: 1, output_tokens: 1 } };
    },
    async listModels(): Promise<ModelInfo[]> {
      return [
        {
          value: 'mock-model',
          displayName: 'Mock Model',
          description: 'Immediate test model',
          supportsThinking: false,
          supportsStructuredOutput: false,
          supportsImages: false,
          supportsServerTools: false,
        },
      ];
    },
    async getCapabilities(model?: string) {
      return {
        provider: 'mock-immediate-provider',
        ...(model ? { model } : {}),
        thinking: 'unsupported' as const,
        structuredOutput: 'unsupported' as const,
        toolUse: 'native' as const,
        serverTools: 'unsupported' as const,
        supportsAdaptiveThinking: false,
        supportedEffortLevels: [] as const,
      };
    },
  };
}

describe('query() proactive compact wiring', () => {
  it('activates proactive autocompact policy on the ConversationLoop by default', async () => {
    const { cwd, cleanup } = makeTempHome('open-agent-compact-test-');
    try {
      const provider = makeImmediateProvider();
      const q = query('hello', {
        provider,
        model: 'mock-model',
        cwd,
        maxTurns: 1,
      });

      // Drain the first message to ensure the loop has been constructed
      // and the policy wired before we inspect it.
      await q.next();

      // Access the internal loop via the __internal_getLoop accessor that
      // was added specifically for this assertion.
      const getLoop = (q as any).__internal_getLoop as (() => ConversationLoop) | undefined;
      expect(typeof getLoop).toBe('function');

      const loop = getLoop!();
      // autoCompactPolicy is private; access via any cast for white-box testing.
      expect((loop as any).autoCompactPolicy).toBe('proactive');

      await q.return(undefined as any);
    } finally {
      cleanup();
    }
  });

  it('__internal_getLoop returns the same ConversationLoop instance', async () => {
    const { cwd, cleanup } = makeTempHome('open-agent-compact-loop-test-');
    try {
      const provider = makeImmediateProvider();
      const q = query('hello', {
        provider,
        model: 'mock-model',
        cwd,
        maxTurns: 1,
      });

      await q.next();

      const getLoop = (q as any).__internal_getLoop as (() => ConversationLoop) | undefined;
      expect(typeof getLoop).toBe('function');

      const loop1 = getLoop!();
      const loop2 = getLoop!();
      // Must be the exact same instance — not re-created on each call.
      expect(loop1).toBe(loop2);

      await q.return(undefined as any);
    } finally {
      cleanup();
    }
  });
});
