import { describe, expect, test } from 'bun:test';
import {
  recordSidechainTranscript,
  partitionTranscript,
  isSidechainEntry,
  extractAgentMessages,
  type SidechainEntry,
} from '../sidechain';

// Mock writer that collects appended records
function createMockWriter() {
  const records: unknown[] = [];
  return {
    records,
    writer: {
      append: async (record: unknown) => { records.push(record); },
      close: async () => {},
    } as any,
  };
}

describe('recordSidechainTranscript', () => {
  test('records messages with isSidechain flag and agentId', async () => {
    const { records, writer } = createMockWriter();
    await recordSidechainTranscript(
      writer,
      [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'world' }],
      'agent-123',
    );
    expect(records).toHaveLength(2);
    for (const r of records) {
      const entry = r as SidechainEntry;
      expect(entry.isSidechain).toBe(true);
      expect(entry.agentId).toBe('agent-123');
      expect(entry.timestamp).toBeDefined();
    }
  });

  test('preserves message content', async () => {
    const { records, writer } = createMockWriter();
    const msg = { role: 'assistant', content: [{ type: 'text', text: 'hi' }] };
    await recordSidechainTranscript(writer, [msg], 'a1');
    expect((records[0] as SidechainEntry).message).toEqual(msg);
  });

  test('includes optional metadata', async () => {
    const { records, writer } = createMockWriter();
    await recordSidechainTranscript(writer, [{ role: 'user', content: 'x' }], 'a1', {
      parentUuid: 'parent-uuid',
      promptId: 'prompt-1',
      agentType: 'code-writer',
    });
    const entry = records[0] as SidechainEntry;
    expect(entry.parentUuid).toBe('parent-uuid');
    expect(entry.promptId).toBe('prompt-1');
    expect(entry.agentType).toBe('code-writer');
  });
});

describe('isSidechainEntry', () => {
  test('returns true for valid sidechain entry', () => {
    expect(isSidechainEntry({ isSidechain: true, agentId: 'x', message: {}, timestamp: '' })).toBe(true);
  });

  test('returns false for main thread entry', () => {
    expect(isSidechainEntry({ role: 'user', content: 'hi' })).toBe(false);
  });

  test('returns false for isSidechain: false', () => {
    expect(isSidechainEntry({ isSidechain: false, agentId: 'x' })).toBe(false);
  });

  test('returns false for missing agentId', () => {
    expect(isSidechainEntry({ isSidechain: true })).toBe(false);
  });

  test('returns false for non-string agentId', () => {
    expect(isSidechainEntry({ isSidechain: true, agentId: 123 })).toBe(false);
  });
});

describe('partitionTranscript', () => {
  test('separates main thread from sidechain entries', () => {
    const entries = [
      { role: 'user', content: 'hi' },
      { isSidechain: true, agentId: 'a1', message: { role: 'user', content: 'sub' }, timestamp: '' },
      { role: 'assistant', content: 'ok' },
      { isSidechain: true, agentId: 'a1', message: { role: 'assistant', content: 'done' }, timestamp: '' },
      { isSidechain: true, agentId: 'a2', message: { role: 'user', content: 'other' }, timestamp: '' },
    ];
    const { mainThread, sidechains } = partitionTranscript(entries);
    expect(mainThread).toHaveLength(2);
    expect(sidechains.size).toBe(2);
    expect(sidechains.get('a1')).toHaveLength(2);
    expect(sidechains.get('a2')).toHaveLength(1);
  });

  test('returns empty sidechains map when no sidechain entries', () => {
    const { mainThread, sidechains } = partitionTranscript([
      { role: 'user', content: 'hi' },
    ]);
    expect(mainThread).toHaveLength(1);
    expect(sidechains.size).toBe(0);
  });
});

describe('extractAgentMessages', () => {
  test('extracts messages for specific agent', () => {
    const entries = [
      { isSidechain: true, agentId: 'a1', message: { role: 'user', content: 'q1' }, timestamp: '' },
      { isSidechain: true, agentId: 'a2', message: { role: 'user', content: 'q2' }, timestamp: '' },
      { isSidechain: true, agentId: 'a1', message: { role: 'assistant', content: 'r1' }, timestamp: '' },
    ];
    const msgs = extractAgentMessages(entries, 'a1');
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toEqual({ role: 'user', content: 'q1' });
    expect(msgs[1]).toEqual({ role: 'assistant', content: 'r1' });
  });

  test('returns empty array for unknown agent', () => {
    expect(extractAgentMessages([{ isSidechain: true, agentId: 'a1', message: {}, timestamp: '' }], 'unknown')).toEqual([]);
  });

  test('ignores non-sidechain entries', () => {
    const entries = [
      { role: 'user', content: 'main' },
      { isSidechain: true, agentId: 'a1', message: { role: 'user', content: 'sub' }, timestamp: '' },
    ];
    expect(extractAgentMessages(entries, 'a1')).toHaveLength(1);
  });
});
