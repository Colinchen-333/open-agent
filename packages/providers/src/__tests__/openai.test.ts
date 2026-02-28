import { describe, it, expect } from 'bun:test';
import { OpenAIProvider } from '../openai.js';
import type { Message, StreamEvent } from '../types.js';

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
