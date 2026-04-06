import { describe, expect, test } from 'bun:test';
import { createSamplingHandler, type SamplingHandler } from '../sampling';
import type { McpSamplingRequest } from '../types';

describe('createSamplingHandler', () => {
  function makeMockHandler(): { handler: SamplingHandler; calls: any[] } {
    const calls: any[] = [];
    const handler = createSamplingHandler({
      llmCall: async (messages, options) => {
        calls.push({ messages, options });
        return { text: 'LLM response', model: 'test-model', stopReason: 'endTurn' };
      },
    });
    return { handler, calls };
  }

  test('delegates to llmCall with correct messages', async () => {
    const { handler, calls } = makeMockHandler();
    const request: McpSamplingRequest = {
      messages: [{ role: 'user', content: { type: 'text', text: 'Hello' } }],
      maxTokens: 100,
    };
    await handler.createMessage(request);
    expect(calls).toHaveLength(1);
    expect(calls[0].messages[0].content).toBe('Hello');
  });

  test('returns formatted response', async () => {
    const { handler } = makeMockHandler();
    const result = await handler.createMessage({
      messages: [{ role: 'user', content: { type: 'text', text: 'Hi' } }],
      maxTokens: 50,
    });
    expect(result.role).toBe('assistant');
    expect(result.content.type).toBe('text');
    expect(result.content.text).toBe('LLM response');
    expect(result.model).toBe('test-model');
  });

  test('passes system prompt and options', async () => {
    const { handler, calls } = makeMockHandler();
    await handler.createMessage({
      messages: [{ role: 'user', content: { type: 'text', text: 'x' } }],
      systemPrompt: 'Be helpful',
      maxTokens: 200,
      temperature: 0.5,
      stopSequences: ['END'],
    });
    expect(calls[0].options.systemPrompt).toBe('Be helpful');
    expect(calls[0].options.maxTokens).toBe(200);
    expect(calls[0].options.temperature).toBe(0.5);
    expect(calls[0].options.stopSequences).toEqual(['END']);
  });

  test('handles multi-turn messages', async () => {
    const { handler, calls } = makeMockHandler();
    await handler.createMessage({
      messages: [
        { role: 'user', content: { type: 'text', text: 'First' } },
        { role: 'assistant', content: { type: 'text', text: 'Reply' } },
        { role: 'user', content: { type: 'text', text: 'Second' } },
      ],
      maxTokens: 100,
    });
    expect(calls[0].messages).toHaveLength(3);
    expect(calls[0].messages[2].content).toBe('Second');
  });

  test('defaults stopReason to endTurn', async () => {
    const handler = createSamplingHandler({
      llmCall: async () => ({ text: 'ok', model: 'm' }),
    });
    const result = await handler.createMessage({
      messages: [{ role: 'user', content: { type: 'text', text: 'x' } }],
      maxTokens: 10,
    });
    expect(result.stopReason).toBe('endTurn');
  });

  test('preserves stopReason from llmCall', async () => {
    const handler = createSamplingHandler({
      llmCall: async () => ({ text: 'done', model: 'test', stopReason: 'maxTokens' }),
    });
    const result = await handler.createMessage({
      messages: [{ role: 'user', content: { type: 'text', text: 'x' } }],
      maxTokens: 10,
    });
    expect(result.stopReason).toBe('maxTokens');
  });

  test('maps message roles correctly', async () => {
    const { handler, calls } = makeMockHandler();
    await handler.createMessage({
      messages: [
        { role: 'user', content: { type: 'text', text: 'A' } },
        { role: 'assistant', content: { type: 'text', text: 'B' } },
      ],
      maxTokens: 50,
    });
    expect(calls[0].messages[0].role).toBe('user');
    expect(calls[0].messages[1].role).toBe('assistant');
  });
});
