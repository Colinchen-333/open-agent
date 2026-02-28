import { describe, it, expect } from 'bun:test';
import { OllamaProvider } from '../ollama.js';
import type { Message, StreamEvent } from '../types.js';

async function collect(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const evt of gen) {
    events.push(evt);
  }
  return events;
}

function streamFromText(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

describe('OllamaProvider streaming behavior', () => {
  const baseMessages: Message[] = [{ role: 'user', content: 'hello' }];

  it('parses the trailing NDJSON line when final newline is missing', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      const chunk = JSON.stringify({
        model: 'llama3',
        created_at: new Date().toISOString(),
        message: { role: 'assistant', content: 'Hi' },
        done: true,
        done_reason: 'stop',
        prompt_eval_count: 3,
        eval_count: 2,
      });
      return new Response(streamFromText(chunk), {
        status: 200,
        headers: { 'Content-Type': 'application/x-ndjson' },
      });
    }) as unknown as typeof fetch;

    try {
      const provider = new OllamaProvider({ baseURL: 'http://localhost:11434' });
      const events = await collect(provider.chat(baseMessages, { model: 'llama3' }));

      const textDelta = events.find((e) => e.type === 'text_delta') as any;
      const end = events.find((e) => e.type === 'message_end') as any;
      expect(textDelta?.text).toBe('Hi');
      expect(end).toBeDefined();
      expect(end.usage.input_tokens).toBe(3);
      expect(end.usage.output_tokens).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('passes AbortSignal into fetch options', async () => {
    const originalFetch = globalThis.fetch;
    const ac = new AbortController();
    let capturedSignal: AbortSignal | undefined;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedSignal = init?.signal as AbortSignal | undefined;
      return new Response(streamFromText('{"done":true}\n'), {
        status: 200,
        headers: { 'Content-Type': 'application/x-ndjson' },
      });
    }) as unknown as typeof fetch;

    try {
      const provider = new OllamaProvider({ baseURL: 'http://localhost:11434' });
      await collect(provider.chat(baseMessages, { model: 'llama3', signal: ac.signal }));
      expect(capturedSignal).toBe(ac.signal);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
