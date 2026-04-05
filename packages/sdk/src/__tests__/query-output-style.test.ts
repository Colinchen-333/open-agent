/**
 * Integration tests for R5.1: outputStyleName wiring through query() into
 * the system prompt via activeOutputStyle.
 *
 * These tests verify that:
 * 1. query() with outputStyleName='verbose' injects the verbose style
 *    instructions into the system prompt passed to the provider.
 * 2. query() with outputStyleName='default' (or absent) does NOT inject
 *    any style section.
 * 3. query() with an unknown style name silently falls back to 'default'
 *    (no style section injected).
 */
import { describe, expect, it } from 'bun:test';
import type { ChatOptions, LLMProvider, Message, StreamEvent } from '@open-agent/providers';
import type { ModelInfo } from '@open-agent/core';
import { query } from '../query.js';
import { makeLockedTempHome as makeTempHome } from './temp-home.js';

/** Captures the system prompt passed by the query loop to the provider. */
function makePromptCaptureProvider(): { provider: LLMProvider; getPrompt(): string } {
  let capturedPrompt = '';
  return {
    provider: {
      name: 'mock-output-style-capture-provider',
      async *chat(_messages: Message[], options: ChatOptions): AsyncGenerator<StreamEvent> {
        capturedPrompt = typeof options.systemPrompt === 'string' ? options.systemPrompt : '';
        yield { type: 'text_delta', text: 'captured' };
        yield { type: 'message_end', message: {}, usage: { input_tokens: 1, output_tokens: 1 } };
      },
      async listModels(): Promise<ModelInfo[]> {
        return [{
          value: 'mock-model',
          displayName: 'Mock Model',
          description: 'Output style capture test model',
          supportsThinking: false,
          supportsStructuredOutput: true,
          supportsImages: false,
          supportsServerTools: false,
          supportsEffort: false,
        }];
      },
    },
    getPrompt() {
      return capturedPrompt;
    },
  };
}

async function drainQuery(q: AsyncGenerator<unknown>): Promise<void> {
  for await (const _msg of q) {
    // drain all messages
  }
}

describe('query() outputStyleName wiring', () => {
  it('injects verbose style instructions into the system prompt', async () => {
    const temp = makeTempHome('open-agent-sdk-output-style-verbose-');
    const capture = makePromptCaptureProvider();
    try {
      const q = query('hello', {
        cwd: temp.cwd,
        model: 'mock-model',
        provider: capture.provider,
        outputStyleName: 'verbose',
      });
      await drainQuery(q);

      const prompt = capture.getPrompt();
      // The verbose built-in style has non-empty instructions that include "step-by-step".
      expect(prompt).toContain('Output style: verbose');
      expect(prompt).toContain('step-by-step');
    } finally {
      temp.cleanup();
    }
  });

  it('injects terse style instructions into the system prompt', async () => {
    const temp = makeTempHome('open-agent-sdk-output-style-terse-');
    const capture = makePromptCaptureProvider();
    try {
      const q = query('hello', {
        cwd: temp.cwd,
        model: 'mock-model',
        provider: capture.provider,
        outputStyleName: 'terse',
      });
      await drainQuery(q);

      const prompt = capture.getPrompt();
      // The terse built-in style contains "concise" instructions.
      expect(prompt).toContain('Output style: terse');
      expect(prompt).toContain('concise');
    } finally {
      temp.cleanup();
    }
  });

  it('does NOT inject any output style section when outputStyleName is "default"', async () => {
    const temp = makeTempHome('open-agent-sdk-output-style-default-');
    const capture = makePromptCaptureProvider();
    try {
      const q = query('hello', {
        cwd: temp.cwd,
        model: 'mock-model',
        provider: capture.provider,
        outputStyleName: 'default',
      });
      await drainQuery(q);

      const prompt = capture.getPrompt();
      // The 'default' built-in style has empty instructions — no section should appear.
      expect(prompt).not.toContain('## Output style:');
    } finally {
      temp.cleanup();
    }
  });

  it('does NOT inject any output style section when outputStyleName is omitted', async () => {
    const temp = makeTempHome('open-agent-sdk-output-style-absent-');
    const capture = makePromptCaptureProvider();
    try {
      const q = query('hello', {
        cwd: temp.cwd,
        model: 'mock-model',
        provider: capture.provider,
        // outputStyleName intentionally omitted
      });
      await drainQuery(q);

      const prompt = capture.getPrompt();
      expect(prompt).not.toContain('## Output style:');
    } finally {
      temp.cleanup();
    }
  });

  it('falls back silently to no style section when an unknown style name is given', async () => {
    const temp = makeTempHome('open-agent-sdk-output-style-unknown-');
    const capture = makePromptCaptureProvider();
    try {
      const q = query('hello', {
        cwd: temp.cwd,
        model: 'mock-model',
        provider: capture.provider,
        outputStyleName: 'nonexistent-style-xyz',
      });
      await drainQuery(q);

      const prompt = capture.getPrompt();
      // findOutputStyle falls back to 'default' which has empty instructions;
      // so no Output style section should appear in the prompt.
      expect(prompt).not.toContain('## Output style:');
    } finally {
      temp.cleanup();
    }
  });
});
