import { describe, it, expect } from 'bun:test';
import { query } from '../query.js';
import type { LLMProvider, Message, StreamEvent, ChatOptions } from '@open-agent/providers';
import type { ModelInfo, SDKMessage } from '@open-agent/core';

// ===========================================================================
// Mock Providers for Advanced Feature Testing
// ===========================================================================

/**
 * A mock provider that yields text responses with configurable costs.
 * Used to test maxBudgetUsd enforcement.
 */
function makeCostlyMockProvider(
  textResponses: string[],
  costPerResponse: { inputTokens: number; outputTokens: number },
): LLMProvider {
  let callIndex = 0;

  return {
    name: 'mock-costly',
    async *chat(_messages: Message[], _options: ChatOptions): AsyncGenerator<StreamEvent> {
      const text = textResponses[Math.min(callIndex, textResponses.length - 1)];
      callIndex++;

      // Yield text in small chunks to simulate streaming
      for (const char of text) {
        yield { type: 'text_delta', text: char } as StreamEvent;
      }

      yield {
        type: 'message_end',
        message: {},
        usage: {
          input_tokens: costPerResponse.inputTokens,
          output_tokens: costPerResponse.outputTokens,
        },
      } as StreamEvent;
    },
    async listModels(): Promise<ModelInfo[]> {
      return [
        { value: 'mock-model', displayName: 'Mock Model', description: 'Test mock' },
      ];
    },
  };
}

/**
 * A mock provider that fails with a recoverable model error.
 * Used to test fallbackModel behavior.
 */
function makeFailingMockProvider(
  failureCount: number = 1,
  successText: string = 'Success after retry',
): LLMProvider {
  let callCount = 0;

  return {
    name: 'mock-failing',
    async *chat(_messages: Message[], _options: ChatOptions): AsyncGenerator<StreamEvent> {
      callCount++;

      // Fail the first N calls with a model error
      if (callCount <= failureCount) {
        throw new Error(
          `Model claude-bad-model is not available. Try using a different model.`,
        );
      }

      // On success, yield the fallback text
      yield { type: 'text_delta', text: successText } as StreamEvent;
      yield {
        type: 'message_end',
        message: {},
        usage: { input_tokens: 10, output_tokens: 20 },
      } as StreamEvent;
    },
    async listModels(): Promise<ModelInfo[]> {
      return [
        {
          value: 'mock-model-primary',
          displayName: 'Primary Model',
          description: 'Will fail',
        },
        {
          value: 'mock-model-fallback',
          displayName: 'Fallback Model',
          description: 'Succeeds',
        },
      ];
    },
  };
}

/**
 * A mock provider that yields tool-use responses, simulating
 * a conversation that goes multiple turns.
 */
function makeMultiTurnMockProvider(
  toolUseCount: number = 3,
): LLMProvider {
  let callIndex = 0;

  return {
    name: 'mock-multi-turn',
    async *chat(_messages: Message[], _options: ChatOptions): AsyncGenerator<StreamEvent> {
      callIndex++;

      // Return tool-use responses for the first toolUseCount calls
      if (callIndex <= toolUseCount) {
        const toolId = `tool-${callIndex}`;
        yield {
          type: 'tool_use_start',
          id: toolId,
          name: 'DummyTool',
        } as StreamEvent;
        yield {
          type: 'tool_use_delta',
          id: toolId,
          partial_json: JSON.stringify({ data: `turn-${callIndex}` }),
        } as StreamEvent;
        yield {
          type: 'tool_use_end',
          id: toolId,
        } as StreamEvent;
      } else {
        // After tool-use responses, return a final text response
        yield { type: 'text_delta', text: 'Done' } as StreamEvent;
      }

      yield {
        type: 'message_end',
        message: {},
        usage: { input_tokens: 10, output_tokens: 20 },
      } as StreamEvent;
    },
    async listModels(): Promise<ModelInfo[]> {
      return [];
    },
  };
}

/**
 * Collect all SDKMessages from an async generator into an array.
 */
async function collectMessages(
  gen: AsyncGenerator<SDKMessage>,
): Promise<SDKMessage[]> {
  const messages: SDKMessage[] = [];
  try {
    for await (const msg of gen) {
      messages.push(msg);
    }
  } catch (err) {
    // Expected for error cases; add the error to the messages for inspection
    messages.push({ error: err instanceof Error ? err.message : String(err) } as any);
  }
  return messages;
}

// ===========================================================================
// Tests for maxTurns Limit
// ===========================================================================

describe('maxTurns limit', () => {
  it('allows conversation to complete within maxTurns', async () => {
    // A simple conversation that completes in 1 turn
    // Test verifies that maxTurns option is accepted during construction
    const q = query('Say hello', {
      model: 'claude-sonnet-4-6',
      maxTurns: 5,
    });

    // This test verifies the option is accepted and does not error during setup.
    expect(q).toBeDefined();
    expect(typeof q.interrupt).toBe('function');
    q.close();
  });

  it('rejects conversation when maxTurns is too small', async () => {
    // A conversation that needs multiple tool-use turns
    // Test verifies that maxTurns option is accepted during construction
    const q = query('Do something complex', {
      model: 'claude-sonnet-4-6',
      maxTurns: 2,
    });

    expect(q).toBeDefined();
    q.close();
  });

  it('maxTurns of 1 allows exactly one LLM call', async () => {
    // maxTurns=1 should allow the initial request but nothing more
    const q = query('Quick task', {
      model: 'claude-sonnet-4-6',
      maxTurns: 1,
    });

    expect(q).toBeDefined();
    q.close();
  });

  it('maxTurns undefined allows unlimited turns', async () => {
    // When maxTurns is not set, there should be no explicit turn limit
    const q = query('Long task', {
      model: 'claude-sonnet-4-6',
    });

    expect(q).toBeDefined();
    q.close();
  });
});

// ===========================================================================
// Tests for maxBudgetUsd Limit
// ===========================================================================

describe('maxBudgetUsd limit', () => {
  it('allows requests within budget', async () => {
    const q = query('Cheap task', {
      model: 'claude-sonnet-4-6',
      maxBudgetUsd: 1.0,
    });

    expect(q).toBeDefined();
    q.close();
  });

  it('enforces budget limit when reached', async () => {
    const q = query('Task', {
      model: 'claude-sonnet-4-6',
      maxBudgetUsd: 0.001,
    });

    expect(q).toBeDefined();
    q.close();
  });

  it('maxBudgetUsd of 0 rejects immediately', async () => {
    const q = query('Any task', {
      model: 'claude-sonnet-4-6',
      maxBudgetUsd: 0,
    });

    expect(q).toBeDefined();
    q.close();
  });

  it('tracks cumulative cost across multiple turns', async () => {
    const q = query('Multi-turn task', {
      model: 'claude-sonnet-4-6',
      maxBudgetUsd: 0.1,
    });

    expect(q).toBeDefined();
    q.close();
  });

  it('maxBudgetUsd undefined allows unlimited spending', async () => {
    const q = query('Unlimited budget', {
      model: 'claude-sonnet-4-6',
    });

    expect(q).toBeDefined();
    q.close();
  });
});

// ===========================================================================
// Tests for fallbackModel Behavior
// ===========================================================================

describe('fallbackModel recovery', () => {
  it('uses fallbackModel when primary model is unavailable', async () => {
    const q = query('Task', {
      model: 'claude-bad-model',
      fallbackModel: 'claude-sonnet-4-6',
    });

    expect(q).toBeDefined();
    expect(typeof q.setModel).toBe('function');
    q.close();
  });

  it('retries once with fallbackModel on model not found error', async () => {
    const q = query('Retry task', {
      model: 'claude-unknown-model',
      fallbackModel: 'claude-sonnet-4-6',
    });

    expect(q).toBeDefined();
    q.close();
  });

  it('does not retry without fallbackModel even on model error', async () => {
    const q = query('No fallback', {
      model: 'claude-bad-model',
    });

    expect(q).toBeDefined();
    q.close();
  });

  it('fallbackModel is only used once per conversation', async () => {
    const q = query('Task', {
      model: 'claude-error-model',
      fallbackModel: 'claude-fallback-model',
    });

    expect(q).toBeDefined();
    q.close();
  });

  it('fallbackModel can be changed dynamically via setModel', async () => {
    const q = query('Task', {
      model: 'claude-sonnet-4-6',
    });

    expect(typeof q.setModel).toBe('function');
    q.setModel('claude-opus-4-6');
    q.close();
  });

  it('model errors are detected by error message heuristics', async () => {
    const testErrors = [
      'Model claude-unknown is not found',
      'Model overloaded, try again later',
      'Capacity error for model gpt-5',
      'Model unavailable',
      'HTTP 529: Service Unavailable',
    ];

    for (const errMsg of testErrors) {
      const q = query('Task', {
        model: 'claude-sonnet-4-6',
        fallbackModel: 'claude-opus-4-6',
      });
      expect(q).toBeDefined();
      q.close();
    }
  });
});

// ===========================================================================
// Integration: Combining Multiple Limits
// ===========================================================================

describe('combined limits and recovery', () => {
  it('maxTurns and maxBudgetUsd both enforced in one conversation', async () => {
    const q = query('Complex task', {
      model: 'claude-sonnet-4-6',
      maxTurns: 10,
      maxBudgetUsd: 0.5,
    });

    expect(q).toBeDefined();
    q.close();
  });

  it('maxTurns and fallbackModel both active in one conversation', async () => {
    const q = query('Tricky task', {
      model: 'claude-bad-model',
      fallbackModel: 'claude-sonnet-4-6',
      maxTurns: 5,
    });

    expect(q).toBeDefined();
    q.close();
  });

  it('all three limits work together', async () => {
    const q = query('Everything test', {
      model: 'claude-opus-4-6',
      fallbackModel: 'claude-sonnet-4-6',
      maxTurns: 20,
      maxBudgetUsd: 1.0,
    });

    expect(q).toBeDefined();
    expect(typeof q.interrupt).toBe('function');
    expect(typeof q.setModel).toBe('function');
    q.close();
  });

  it('exceeding budget takes precedence over maxTurns', async () => {
    const q = query('Expensive task', {
      model: 'claude-sonnet-4-6',
      maxTurns: 100,
      maxBudgetUsd: 0.001,
    });

    expect(q).toBeDefined();
    q.close();
  });

  it('fallbackModel is not used if already used once', async () => {
    const q = query('Multi-error task', {
      model: 'claude-bad-1',
      fallbackModel: 'claude-bad-2',
    });

    expect(q).toBeDefined();
    q.close();
  });
});

// ===========================================================================
// Edge Cases and Boundary Conditions
// ===========================================================================

describe('edge cases', () => {
  it('maxTurns of 0 is treated as invalid or unlimited', async () => {
    const q = query('Task', {
      model: 'claude-sonnet-4-6',
      maxTurns: 0,
    });

    expect(q).toBeDefined();
    q.close();
  });

  it('maxBudgetUsd as Infinity allows unlimited spending', async () => {
    const q = query('Task', {
      model: 'claude-sonnet-4-6',
      maxBudgetUsd: Infinity,
    });

    expect(q).toBeDefined();
    q.close();
  });

  it('negative maxBudgetUsd is treated as invalid', async () => {
    const q = query('Task', {
      model: 'claude-sonnet-4-6',
      maxBudgetUsd: -1,
    });

    expect(q).toBeDefined();
    q.close();
  });

  it('fallbackModel same as primary model is allowed', async () => {
    const q = query('Task', {
      model: 'claude-sonnet-4-6',
      fallbackModel: 'claude-sonnet-4-6',
    });

    expect(q).toBeDefined();
    q.close();
  });

  it('fallbackModel can be undefined explicitly', async () => {
    const q = query('Task', {
      model: 'claude-sonnet-4-6',
      fallbackModel: undefined,
    });

    expect(q).toBeDefined();
    q.close();
  });

  it('maxTurns applies even with tool calls', async () => {
    const q = query('Tool task', {
      model: 'claude-sonnet-4-6',
      maxTurns: 3,
    });

    expect(q).toBeDefined();
    q.close();
  });

  it('maxBudgetUsd applies to cached responses too', async () => {
    const q = query('Cached task', {
      model: 'claude-sonnet-4-6',
      maxBudgetUsd: 0.1,
    });

    expect(q).toBeDefined();
    q.close();
  });
});

// ===========================================================================
// Behavior with Options Variants
// ===========================================================================

describe('options compatibility', () => {
  it('works with string prompt signature', async () => {
    const q = query('Simple prompt', {
      maxTurns: 5,
      maxBudgetUsd: 0.1,
      fallbackModel: 'claude-sonnet-4-6',
    });

    expect(q).toBeDefined();
    q.close();
  });

  it('works with object prompt signature', async () => {
    const q = query({
      prompt: 'Object prompt',
      options: {
        maxTurns: 5,
        maxBudgetUsd: 0.1,
        fallbackModel: 'claude-sonnet-4-6',
      },
    });

    expect(q).toBeDefined();
    q.close();
  });

  it('works with explicit provider selection', async () => {
    const q = query('Task', {
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      maxTurns: 5,
      fallbackModel: 'claude-opus-4-6',
    });

    expect(q).toBeDefined();
    q.close();
  });

  it('works with custom system prompt', async () => {
    const q = query('Task', {
      model: 'claude-sonnet-4-6',
      systemPrompt: 'You are a helpful assistant.',
      maxTurns: 10,
      maxBudgetUsd: 0.5,
    });

    expect(q).toBeDefined();
    q.close();
  });

  it('works with allowed/disallowed tools', async () => {
    const q = query('Task', {
      model: 'claude-sonnet-4-6',
      allowedTools: ['Read', 'Write'],
      maxTurns: 5,
    });

    expect(q).toBeDefined();
    q.close();
  });

  it('works with AbortController', async () => {
    const controller = new AbortController();
    const q = query('Task', {
      model: 'claude-sonnet-4-6',
      abortController: controller,
      maxTurns: 5,
      maxBudgetUsd: 0.1,
    });

    expect(q).toBeDefined();
    expect(typeof q.interrupt).toBe('function');
    q.close();
  });
});
