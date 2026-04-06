import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { OpenAIProvider } from '../openai.js';
import { supportsThinking, getContextWindowForModel } from '../model-capability.js';
import type { Message, StreamEvent, ToolSpec } from '../types.js';

function makeProviderWithChunks(chunks: any[]): OpenAIProvider {
  const provider = new OpenAIProvider({ apiKey: 'test-key' });
  (provider as any).client = {
    chat: {
      completions: {
        create: async () => (async function* () {
          for (const chunk of chunks) {
            yield chunk;
          }
        })(),
      },
    },
  };
  return provider;
}

async function collect(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const evt of gen) {
    events.push(evt);
  }
  return events;
}

describe('OpenAIProvider usage normalization', () => {
  const baseMessages: Message[] = [{ role: 'user', content: 'hello' }];

  it('normalizes usage on message_end to input/output token keys', async () => {
    const provider = makeProviderWithChunks([
      {
        choices: [{ delta: { content: 'Hi' }, finish_reason: null }],
        usage: null,
      },
      {
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 4,
          prompt_tokens_details: { cached_tokens: 2 },
        },
      },
    ]);

    const events = await collect(provider.chat(baseMessages, { model: 'gpt-4o' }));
    const end = events.find((e) => e.type === 'message_end') as any;
    expect(end).toBeDefined();
    expect(end.usage.input_tokens).toBe(10);
    expect(end.usage.output_tokens).toBe(4);
    expect(end.usage.cache_read_input_tokens).toBe(2);
  });

  it('emits usage from usage-only chunks as message_delta', async () => {
    const provider = makeProviderWithChunks([
      {
        choices: [{ delta: { content: 'Hi' }, finish_reason: 'stop' }],
        usage: null,
      },
      {
        choices: [],
        usage: {
          prompt_tokens: 8,
          completion_tokens: 3,
        },
      },
    ]);

    const events = await collect(provider.chat(baseMessages, { model: 'gpt-4o' }));
    const usageDelta = events.find((e) => e.type === 'message_delta') as any;
    expect(usageDelta).toBeDefined();
    expect(usageDelta.usage.input_tokens).toBe(8);
    expect(usageDelta.usage.output_tokens).toBe(3);
  });
});

describe('OpenAIProvider tool id stability', () => {
  const baseMessages: Message[] = [{ role: 'user', content: 'call tool' }];

  it('keeps a stable tool_use id when provider id arrives late', async () => {
    const provider = makeProviderWithChunks([
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: { name: 'demo_tool', arguments: '{"x":' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
        usage: null,
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'real-provider-id',
                  function: { arguments: '1}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: null,
      },
    ]);

    const events = await collect(provider.chat(baseMessages, { model: 'gpt-4o' }));
    const start = events.find((e) => e.type === 'tool_use_start') as any;
    const deltas = events.filter((e) => e.type === 'tool_use_delta') as any[];
    const end = events.find((e) => e.type === 'message_end') as any;

    expect(start).toBeDefined();
    expect(deltas.length).toBeGreaterThan(0);
    expect(deltas.every((d) => d.id === start.id)).toBe(true);
    expect(end.message.tool_calls[0].id).toBe(start.id);
  });
});

describe('OpenAIProvider request compatibility', () => {
  it('serializes image-only user content as a valid multimodal array', async () => {
    let capturedParams: any;
    const provider = new OpenAIProvider({ apiKey: 'test-key' });
    (provider as any).client = {
      chat: {
        completions: {
          create: async (params: any) => {
            capturedParams = params;
            return (async function* () {
              yield {
                choices: [{ delta: {}, finish_reason: 'stop' }],
                usage: null,
              };
            })();
          },
        },
      },
    };

    const events = await collect(provider.chat(
      [
        {
          role: 'user',
          content: [{ type: 'image', media_type: 'image/png', data: 'AAA=' }] as any,
        },
      ],
      { model: 'gpt-4o' },
    ));

    expect(events.some((e) => e.type === 'message_end')).toBe(true);
    expect(Array.isArray(capturedParams.messages)).toBe(true);
    expect(capturedParams.messages[0].role).toBe('user');
    expect(capturedParams.messages[0].content).toEqual([
      {
        type: 'image_url',
        image_url: { url: 'data:image/png;base64,AAA=' },
      },
    ]);
  });

  it('passes AbortSignal to OpenAI create request options', async () => {
    const ac = new AbortController();
    let capturedReqOptions: any;
    const provider = new OpenAIProvider({ apiKey: 'test-key' });
    (provider as any).client = {
      chat: {
        completions: {
          create: async (_params: any, reqOptions: any) => {
            capturedReqOptions = reqOptions;
            return (async function* () {
              yield {
                choices: [{ delta: {}, finish_reason: 'stop' }],
                usage: null,
              };
            })();
          },
        },
      },
    };

    await collect(provider.chat([{ role: 'user', content: 'hello' }], {
      model: 'gpt-4o',
      signal: ac.signal,
    }));

    expect(capturedReqOptions?.signal).toBe(ac.signal);
  });

  it('retries once without stream_options on 400 compatibility errors', async () => {
    const calls: any[] = [];
    const provider = new OpenAIProvider({ apiKey: 'test-key' });
    (provider as any).client = {
      chat: {
        completions: {
          create: async (params: any) => {
            calls.push(params);
            if (calls.length === 1) {
              const err = new Error('Unknown parameter: stream_options') as Error & { status?: number };
              err.status = 400;
              throw err;
            }
            return (async function* () {
              yield {
                choices: [{ delta: {}, finish_reason: 'stop' }],
                usage: null,
              };
            })();
          },
        },
      },
    };

    const events = await collect(provider.chat([{ role: 'user', content: 'hello' }], { model: 'gpt-4o' }));

    expect(calls.length).toBe(2);
    expect(calls[0].stream_options).toEqual({ include_usage: true });
    expect(calls[1].stream_options).toBeUndefined();
    expect(events.some((e) => e.type === 'message_end')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Model capability queries (Part B — R3.4)
// ---------------------------------------------------------------------------

describe('model-capability: supportsThinking for GLM-4.7', () => {
  it('returns false for glm-4.7', () => {
    expect(supportsThinking('glm-4.7')).toBe(false);
  });

  it('returns false for unknown models (conservative default)', () => {
    expect(supportsThinking('some-unknown-model-xyz')).toBe(false);
  });
});

describe('model-capability: getContextWindowForModel for GLM-4.7', () => {
  it('returns 128_000 for glm-4.7', () => {
    expect(getContextWindowForModel('glm-4.7')).toBe(128_000);
  });
});

describe('OpenAIProvider: thinking-unsupported warning', () => {
  function makeNoopProvider(): OpenAIProvider {
    const provider = new OpenAIProvider({ apiKey: 'test-key' });
    (provider as any).client = {
      chat: {
        completions: {
          create: async () =>
            (async function* () {
              yield { choices: [{ delta: {}, finish_reason: 'stop' }], usage: null };
            })(),
        },
      },
    };
    return provider;
  }

  it('emits a console.warn when thinking is requested for a model that does not support it', async () => {
    const provider = makeNoopProvider();
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});

    try {
      // Clear the module-level warn-set so the warn fires even if a prior test
      // already triggered it for glm-4.7.
      const mod = await import('../openai.js');
      (mod as any)._thinkingWarnedModels?.clear?.();
    } catch { /* access may be restricted — best effort */ }

    const events: StreamEvent[] = [];
    for await (const evt of provider.chat(
      [{ role: 'user', content: 'hello' }],
      { model: 'glm-4.7', thinking: { type: 'enabled', budgetTokens: 2000 } },
    )) {
      events.push(evt);
    }

    expect(events.some((e) => e.type === 'message_end')).toBe(true);
    expect(warnSpy).toHaveBeenCalled();
    const warnMsg: string = warnSpy.mock.calls[0]?.[0] ?? '';
    expect(warnMsg).toContain('glm-4.7');
    expect(warnMsg).toContain('thinking');

    warnSpy.mockRestore();
  });

  it('does not warn when thinking is disabled', async () => {
    const provider = makeNoopProvider();
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});

    const events: StreamEvent[] = [];
    for await (const evt of provider.chat(
      [{ role: 'user', content: 'hello' }],
      { model: 'glm-4.7', thinking: { type: 'disabled' } },
    )) {
      events.push(evt);
    }

    expect(events.some((e) => e.type === 'message_end')).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Helper: captures the params passed to client.chat.completions.create
// ---------------------------------------------------------------------------

function makeCapturingProvider(): { provider: OpenAIProvider; calls: any[] } {
  const calls: any[] = [];
  const provider = new OpenAIProvider({ apiKey: 'test-key' });
  (provider as any).client = {
    chat: {
      completions: {
        create: async (params: any) => {
          calls.push(params);
          return (async function* () {
            yield { choices: [{ delta: {}, finish_reason: 'stop' }], usage: null };
          })();
        },
      },
    },
  };
  return { provider, calls };
}

// ---------------------------------------------------------------------------
// Part 2 — Structured output (JSON schema)
// ---------------------------------------------------------------------------

describe('OpenAIProvider: structured output (responseFormat)', () => {
  it('forwards responseFormat as response_format json_schema to the API', async () => {
    const { provider, calls } = makeCapturingProvider();

    await collect(provider.chat(
      [{ role: 'user', content: 'Give me JSON' }],
      {
        model: 'gpt-4o',
        responseFormat: {
          type: 'json_schema',
          schema: {
            type: 'object',
            properties: { name: { type: 'string' } },
            required: ['name'],
          },
        },
      },
    ));

    expect(calls.length).toBeGreaterThan(0);
    const sentParams = calls[0];
    expect(sentParams.response_format).toBeDefined();
    expect(sentParams.response_format.type).toBe('json_schema');
    expect(sentParams.response_format.json_schema.name).toBe('structured_output');
    expect(sentParams.response_format.json_schema.strict).toBe(true);
    expect(sentParams.response_format.json_schema.schema.properties.name).toEqual({ type: 'string' });
  });

  it('omits response_format when responseFormat is not provided', async () => {
    const { provider, calls } = makeCapturingProvider();

    await collect(provider.chat(
      [{ role: 'user', content: 'hello' }],
      { model: 'gpt-4o' },
    ));

    expect(calls[0].response_format).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Part 3 — Tool choice control
// ---------------------------------------------------------------------------

describe('OpenAIProvider: toolChoice parameter', () => {
  const dummyTool: ToolSpec = {
    name: 'my_func',
    description: 'A test function',
    input_schema: { type: 'object', properties: {} },
  };

  it('defaults tool_choice to "auto" when tools are present and toolChoice is unset', async () => {
    const { provider, calls } = makeCapturingProvider();

    await collect(provider.chat(
      [{ role: 'user', content: 'hello' }],
      { model: 'gpt-4o', tools: [dummyTool] },
    ));

    expect(calls[0].tool_choice).toBe('auto');
  });

  it('passes toolChoice "none" to the API verbatim', async () => {
    const { provider, calls } = makeCapturingProvider();

    await collect(provider.chat(
      [{ role: 'user', content: 'hello' }],
      { model: 'gpt-4o', tools: [dummyTool], toolChoice: 'none' },
    ));

    expect(calls[0].tool_choice).toBe('none');
  });

  it('passes toolChoice "required" to the API verbatim', async () => {
    const { provider, calls } = makeCapturingProvider();

    await collect(provider.chat(
      [{ role: 'user', content: 'hello' }],
      { model: 'gpt-4o', tools: [dummyTool], toolChoice: 'required' },
    ));

    expect(calls[0].tool_choice).toBe('required');
  });

  it('passes a named function toolChoice object to the API', async () => {
    const { provider, calls } = makeCapturingProvider();

    await collect(provider.chat(
      [{ role: 'user', content: 'hello' }],
      {
        model: 'gpt-4o',
        tools: [dummyTool],
        toolChoice: { type: 'function', function: { name: 'my_func' } },
      },
    ));

    expect(calls[0].tool_choice).toEqual({ type: 'function', function: { name: 'my_func' } });
  });

  it('omits tool_choice entirely when no tools and no toolChoice', async () => {
    const { provider, calls } = makeCapturingProvider();

    await collect(provider.chat(
      [{ role: 'user', content: 'hello' }],
      { model: 'gpt-4o' },
    ));

    expect(calls[0].tool_choice).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Part 4 — Context window truncation
// ---------------------------------------------------------------------------

describe('OpenAIProvider: context window truncation', () => {
  it('trims oldest non-system messages when estimated tokens exceed budget', async () => {
    const { provider, calls } = makeCapturingProvider();

    // glm-4.7 has contextWindow=128_000, maxOutput=16_000 → budget ≈ 112_000 tokens
    // Each old message is 'A'.repeat(4) = 1 token each — negligible.
    // But we can set maxTokens high to shrink the input budget and force truncation.
    // contextWindow=128_000, maxTokens=127_990 → maxInputTokens=10
    // A message with 60 chars ≈ 15 tokens exceeds 10 token budget.
    // So with 4 such non-system messages only the last one should survive.

    const longContent = 'A'.repeat(60); // ~15 tokens
    const messages: Message[] = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: longContent },
      { role: 'user', content: longContent },
      { role: 'user', content: longContent },
      { role: 'user', content: longContent },
    ];

    await collect(provider.chat(messages, {
      model: 'glm-4.7',
      maxTokens: 127_990, // leaves only ~10 tokens for input
    }));

    expect(calls.length).toBeGreaterThan(0);
    const sentMessages = calls[0].messages;

    // System message must always be preserved
    const systemMsgs = sentMessages.filter((m: any) => m.role === 'system');
    expect(systemMsgs.length).toBe(1);

    // Total message count must be fewer than the 5 original messages
    expect(sentMessages.length).toBeLessThan(5);
  });

  it('preserves all messages when they fit within the context window', async () => {
    const { provider, calls } = makeCapturingProvider();

    // Short messages that trivially fit
    const messages: Message[] = [
      { role: 'user', content: 'hello' },
      { role: 'user', content: 'world' },
    ];

    await collect(provider.chat(messages, { model: 'gpt-4o' }));

    const sentMessages = calls[0].messages;
    expect(sentMessages.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Part 5 — Thinking / reasoning_effort
// ---------------------------------------------------------------------------

describe('OpenAIProvider: reasoning_effort for thinking-capable models', () => {
  it('attaches reasoning_effort when model supports thinking and thinking is enabled', async () => {
    const { provider, calls } = makeCapturingProvider();

    await collect(provider.chat(
      [{ role: 'user', content: 'think hard' }],
      {
        model: 'gpt-5', // registered in model-capability as supportsThinking:true
        thinking: { type: 'enabled', budgetTokens: 5000 },
        effort: 'high',
      },
    ));

    expect(calls[0].reasoning_effort).toBe('high');
  });

  it('defaults reasoning_effort to "medium" when effort is not specified', async () => {
    const { provider, calls } = makeCapturingProvider();

    await collect(provider.chat(
      [{ role: 'user', content: 'think' }],
      {
        model: 'gpt-5',
        thinking: { type: 'enabled', budgetTokens: 2000 },
      },
    ));

    expect(calls[0].reasoning_effort).toBe('medium');
  });

  it('does NOT attach reasoning_effort for non-thinking models', async () => {
    const { provider, calls } = makeCapturingProvider();

    await collect(provider.chat(
      [{ role: 'user', content: 'hello' }],
      {
        model: 'gpt-4o', // does not support thinking
        thinking: { type: 'enabled', budgetTokens: 1000 },
      },
    ));

    expect(calls[0].reasoning_effort).toBeUndefined();
  });

  it('does NOT attach reasoning_effort when thinking is disabled', async () => {
    const { provider, calls } = makeCapturingProvider();

    await collect(provider.chat(
      [{ role: 'user', content: 'hello' }],
      {
        model: 'gpt-5',
        thinking: { type: 'disabled' },
        effort: 'high',
      },
    ));

    expect(calls[0].reasoning_effort).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Part 7 — Provider capabilities
// ---------------------------------------------------------------------------

describe('OpenAIProvider: getCapabilities()', () => {
  it('returns thinking=native for gpt-5 (thinking-capable)', async () => {
    const provider = new OpenAIProvider({ apiKey: 'test-key' });
    const caps = await provider.getCapabilities('gpt-5');
    expect(caps.thinking).toBe('native');
    expect(caps.supportedEffortLevels).toEqual(['low', 'medium', 'high']);
  });

  it('returns thinking=unsupported for gpt-4o', async () => {
    const provider = new OpenAIProvider({ apiKey: 'test-key' });
    const caps = await provider.getCapabilities('gpt-4o');
    expect(caps.thinking).toBe('unsupported');
    expect(caps.supportedEffortLevels).toEqual([]);
  });

  it('returns thinking=unsupported for glm-4.7', async () => {
    const provider = new OpenAIProvider({ apiKey: 'test-key' });
    const caps = await provider.getCapabilities('glm-4.7');
    expect(caps.thinking).toBe('unsupported');
  });

  it('returns structuredOutput=native for all models', async () => {
    const provider = new OpenAIProvider({ apiKey: 'test-key' });
    const caps = await provider.getCapabilities('gpt-4o');
    expect(caps.structuredOutput).toBe('native');
  });

  it('returns toolUse=native and serverTools=unsupported', async () => {
    const provider = new OpenAIProvider({ apiKey: 'test-key' });
    const caps = await provider.getCapabilities('gpt-4o');
    expect(caps.toolUse).toBe('native');
    expect(caps.serverTools).toBe('unsupported');
  });

  it('returns provider name as "openai"', async () => {
    const provider = new OpenAIProvider({ apiKey: 'test-key' });
    const caps = await provider.getCapabilities();
    expect(caps.provider).toBe('openai');
  });
});
