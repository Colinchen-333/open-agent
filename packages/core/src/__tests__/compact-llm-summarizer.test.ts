import { describe, expect, test } from 'bun:test';
import { createLLMSummarizer } from '../compact/llm-summarizer';

describe('createLLMSummarizer', () => {
  test('calls provider and returns summary text', async () => {
    const mockProvider = {
      name: 'mock',
      async *chat() {
        yield { type: 'text_delta', text: 'Summary: user asked about tests.' };
      },
    };
    const summarizer = createLLMSummarizer(mockProvider as any, 'test-model');
    const result = await summarizer.summarize([
      { role: 'user', content: 'How do I run tests?' },
      { role: 'assistant', content: 'Use bun test.' },
    ]);
    expect(result).toContain('Summary');
    expect(result).toContain('tests');
  });

  test('handles provider error gracefully', async () => {
    const failProvider = {
      name: 'fail',
      async *chat() { throw new Error('API down'); },
    };
    const summarizer = createLLMSummarizer(failProvider as any, 'test');
    const result = await summarizer.summarize([{ role: 'user', content: 'hi' }]);
    expect(result).toContain('summarizer error');
    expect(result).toContain('API down');
  });

  test('respects maxTokens option', async () => {
    let capturedOptions: any = null;
    const capturingProvider = {
      name: 'capture',
      async *chat(_messages: any, opts: any) {
        capturedOptions = opts;
        yield { type: 'text_delta', text: 'ok' };
      },
    };
    const summarizer = createLLMSummarizer(capturingProvider as any, 'test');
    await summarizer.summarize([{ role: 'user', content: 'x' }], { maxTokens: 500 });
    expect(capturedOptions.maxTokens).toBe(500);
  });

  test('formats tool_use and tool_result in transcript', async () => {
    let capturedPrompt = '';
    const provider = {
      name: 'prompt-capture',
      async *chat(messages: any[], _opts: any) {
        capturedPrompt = messages[0].content;
        yield { type: 'text_delta', text: 'summary' };
      },
    };
    const summarizer = createLLMSummarizer(provider as any, 'test');
    await summarizer.summarize([
      { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file.txt' }] },
    ]);
    expect(capturedPrompt).toContain('tool_use: Bash');
    expect(capturedPrompt).toContain('tool_result');
  });
});
