import { describe, expect, test } from 'bun:test';
import { llmAutocompact, shouldTriggerProactiveAutocompact } from '../compact/llm-autocompact';
import { NOOP_SUMMARIZER } from '../compact/summarizer';
import type { MessageSummarizer } from '../compact/summarizer';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMessages(count: number): { role: string; content: string }[] {
  return Array.from({ length: count }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `message ${i}`,
  }));
}

// ---------------------------------------------------------------------------
// llmAutocompact — with NOOP summarizer
// ---------------------------------------------------------------------------

describe('llmAutocompact', () => {
  test('returns expected structure when compaction fires', async () => {
    const messages = makeMessages(10);
    const result = await llmAutocompact(messages, NOOP_SUMMARIZER);
    expect(result.didCompact).toBe(true);
    expect(typeof result.summaryText).toBe('string');
    expect(result.summaryText.length).toBeGreaterThan(0);
    expect(result.messagesReplaced).toBeGreaterThan(0);
    expect(Array.isArray(result.messages)).toBe(true);
  });

  test('skips compaction when total messages <= protectedTailSize + 2 (default 6)', async () => {
    // Default protectedTailSize is 4; skip threshold is <= 4 + 2 = 6
    const messages = makeMessages(6);
    const result = await llmAutocompact(messages, NOOP_SUMMARIZER);
    expect(result.didCompact).toBe(false);
    expect(result.summaryText).toBe('');
    expect(result.messagesReplaced).toBe(0);
    expect(result.messages).toEqual([...messages]);
  });

  test('skips compaction when exactly at the edge (messages.length === protectedTailSize + 2)', async () => {
    const messages = makeMessages(6); // 4 + 2 = 6
    const result = await llmAutocompact(messages, NOOP_SUMMARIZER, { protectedTailSize: 4 });
    expect(result.didCompact).toBe(false);
  });

  test('fires compaction when one message above the skip threshold', async () => {
    // protectedTailSize=4, skip threshold = 6, 7 messages should fire
    const messages = makeMessages(7);
    const result = await llmAutocompact(messages, NOOP_SUMMARIZER, { protectedTailSize: 4 });
    expect(result.didCompact).toBe(true);
    expect(result.messagesReplaced).toBe(3); // 7 - 4 = 3
  });

  test('respects custom protectedTailSize', async () => {
    const messages = makeMessages(12);
    const protectedTailSize = 6;
    const result = await llmAutocompact(messages, NOOP_SUMMARIZER, { protectedTailSize });
    expect(result.didCompact).toBe(true);
    // Expect exactly tailSize messages preserved + 1 summary message
    expect(result.messages.length).toBe(protectedTailSize + 1);
    expect(result.messagesReplaced).toBe(12 - protectedTailSize);
  });

  test('summary message is placed first and contains count + summary text', async () => {
    const messages = makeMessages(10);
    const result = await llmAutocompact(messages, NOOP_SUMMARIZER, { protectedTailSize: 4 });
    const first = result.messages[0] as { role: string; content: string };
    expect(first.role).toBe('system');
    expect(first.content).toContain('[Conversation summary');
    // Should include the count of replaced messages
    expect(first.content).toContain(String(result.messagesReplaced));
    // Should include the actual summary text
    expect(first.content).toContain(result.summaryText);
  });

  test('protected tail messages are preserved verbatim at the end', async () => {
    const messages = makeMessages(10);
    const protectedTailSize = 4;
    const result = await llmAutocompact(messages, NOOP_SUMMARIZER, { protectedTailSize });
    const expectedTail = messages.slice(messages.length - protectedTailSize);
    const actualTail = result.messages.slice(1); // skip summary message at index 0
    expect(actualTail).toEqual(expectedTail);
  });

  test('does not mutate the original messages array', async () => {
    const messages = makeMessages(10);
    const original = [...messages];
    await llmAutocompact(messages, NOOP_SUMMARIZER);
    expect(messages).toEqual(original);
  });

  test('NOOP summarizer includes message count in placeholder text', async () => {
    const messages = makeMessages(10);
    const result = await llmAutocompact(messages, NOOP_SUMMARIZER, { protectedTailSize: 4 });
    // NOOP_SUMMARIZER embeds the count of messages it received
    expect(result.summaryText).toContain(`${result.messagesReplaced} messages`);
  });
});

// ---------------------------------------------------------------------------
// llmAutocompact — mock summarizer receives correct slice
// ---------------------------------------------------------------------------

describe('llmAutocompact with mock summarizer', () => {
  test('mock summarizer receives exactly the to-summarize slice', async () => {
    const messages = makeMessages(10);
    const protectedTailSize = 3;
    const expectedSliceLength = messages.length - protectedTailSize; // 7

    let capturedMessages: ReadonlyArray<unknown> | undefined;
    const mockSummarizer: MessageSummarizer = {
      async summarize(msgs) {
        capturedMessages = msgs;
        return `digest of ${msgs.length} messages`;
      },
    };

    await llmAutocompact(messages, mockSummarizer, { protectedTailSize });

    expect(capturedMessages).toBeDefined();
    expect((capturedMessages as unknown[]).length).toBe(expectedSliceLength);
    // The captured slice should match messages[0..expectedSliceLength)
    expect(Array.from(capturedMessages as Iterable<unknown>)).toEqual(messages.slice(0, expectedSliceLength));
  });

  test('mock summarizer receives style and maxTokens options', async () => {
    const messages = makeMessages(10);
    let capturedOptions: unknown = null;
    const mockSummarizer: MessageSummarizer = {
      async summarize(_msgs, opts) {
        capturedOptions = opts;
        return 'summary';
      },
    };

    await llmAutocompact(messages, mockSummarizer, {
      style: 'detailed',
      maxSummaryTokens: 500,
      protectedTailSize: 4,
    });

    expect((capturedOptions as any).style).toBe('detailed');
    expect((capturedOptions as any).maxTokens).toBe(500);
  });

  test('summary text from mock summarizer appears in result and in summary message content', async () => {
    const messages = makeMessages(10);
    const mockSummarizer: MessageSummarizer = {
      async summarize() {
        return 'MOCK_SUMMARY_TEXT';
      },
    };

    const result = await llmAutocompact(messages, mockSummarizer);
    expect(result.summaryText).toBe('MOCK_SUMMARY_TEXT');
    const summaryMsg = result.messages[0] as { role: string; content: string };
    expect(summaryMsg.content).toContain('MOCK_SUMMARY_TEXT');
  });
});

// ---------------------------------------------------------------------------
// shouldTriggerProactiveAutocompact
// ---------------------------------------------------------------------------

describe('shouldTriggerProactiveAutocompact', () => {
  test('returns false when below all thresholds', () => {
    const messages = makeMessages(20);
    expect(shouldTriggerProactiveAutocompact(messages)).toBe(false);
  });

  test('returns true when message count reaches the default threshold (80)', () => {
    const messages = makeMessages(80);
    expect(shouldTriggerProactiveAutocompact(messages)).toBe(true);
  });

  test('returns true when message count exceeds the default threshold', () => {
    const messages = makeMessages(100);
    expect(shouldTriggerProactiveAutocompact(messages)).toBe(true);
  });

  test('returns false when message count is one below a custom threshold', () => {
    const messages = makeMessages(49);
    expect(shouldTriggerProactiveAutocompact(messages, { messageCountThreshold: 50 })).toBe(false);
  });

  test('returns true when message count meets a custom threshold', () => {
    const messages = makeMessages(50);
    expect(shouldTriggerProactiveAutocompact(messages, { messageCountThreshold: 50 })).toBe(true);
  });

  test('returns true when estimatedTokens reaches the tokenThreshold', () => {
    const messages = makeMessages(5);
    expect(
      shouldTriggerProactiveAutocompact(messages, {
        estimatedTokens: 50000,
        tokenThreshold: 50000,
      }),
    ).toBe(true);
  });

  test('returns false when estimatedTokens is below the tokenThreshold', () => {
    const messages = makeMessages(5);
    expect(
      shouldTriggerProactiveAutocompact(messages, {
        estimatedTokens: 49999,
        tokenThreshold: 50000,
      }),
    ).toBe(false);
  });

  test('returns false when tokenThreshold is provided but estimatedTokens is absent', () => {
    const messages = makeMessages(5);
    expect(
      shouldTriggerProactiveAutocompact(messages, { tokenThreshold: 50000 }),
    ).toBe(false);
  });

  test('token threshold trigger is independent of message count', () => {
    // Even with very few messages, if tokens are high it should trigger
    const messages = makeMessages(3);
    expect(
      shouldTriggerProactiveAutocompact(messages, {
        estimatedTokens: 200000,
        tokenThreshold: 100000,
      }),
    ).toBe(true);
  });
});
