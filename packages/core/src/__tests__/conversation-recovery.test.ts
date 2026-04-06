import { describe, expect, test } from 'bun:test';
import { recoverFromJsonl, findNewestLeaf, extractChain, filterMainThread, assessHealth } from '../conversation-recovery';

describe('recoverFromJsonl', () => {
  test('parses valid JSONL', () => {
    const content = '{"role":"user","content":"hi"}\n{"role":"assistant","content":"hey"}\n';
    const result = recoverFromJsonl(content);
    expect(result.messages).toHaveLength(2);
    expect(result.wasCorrupted).toBe(false);
  });

  test('skips corrupted lines and continues', () => {
    const content = '{"role":"user"}\n{broken json\n{"role":"assistant"}\n';
    const result = recoverFromJsonl(content);
    expect(result.messages).toHaveLength(2);
    expect(result.corruptedLines).toBe(1);
    expect(result.wasCorrupted).toBe(true);
    expect(result.corruptedLineNumbers).toEqual([2]);
  });

  test('handles empty content', () => {
    const result = recoverFromJsonl('');
    expect(result.messages).toHaveLength(0);
  });

  test('handles all corrupted', () => {
    const result = recoverFromJsonl('bad1\nbad2\n');
    expect(result.messages).toHaveLength(0);
    expect(result.corruptedLines).toBe(2);
  });
});

describe('findNewestLeaf', () => {
  test('finds leaf by parentUuid', () => {
    const msgs = [
      { uuid: 'a', timestamp: '2026-01-01' },
      { uuid: 'b', parentUuid: 'a', timestamp: '2026-01-02' },
    ];
    const leaf = findNewestLeaf(msgs) as any;
    expect(leaf.uuid).toBe('b');
  });

  test('returns last message when no UUID structure', () => {
    const msgs = [{ content: 'first' }, { content: 'last' }];
    expect(findNewestLeaf(msgs)).toEqual({ content: 'last' });
  });

  test('returns null for empty', () => {
    expect(findNewestLeaf([])).toBeNull();
  });
});

describe('extractChain', () => {
  test('follows parentUuid chain', () => {
    const msgs = [
      { uuid: 'a', content: '1' },
      { uuid: 'b', parentUuid: 'a', content: '2' },
      { uuid: 'c', parentUuid: 'b', content: '3' },
    ];
    const chain = extractChain(msgs, 'c');
    expect(chain).toHaveLength(3);
    expect((chain[0] as any).uuid).toBe('a');
  });

  test('handles missing parent gracefully', () => {
    const msgs = [{ uuid: 'x', parentUuid: 'missing' }];
    const chain = extractChain(msgs, 'x');
    expect(chain).toHaveLength(1);
  });
});

describe('filterMainThread', () => {
  test('excludes sidechain entries', () => {
    const msgs = [
      { role: 'user', content: 'hi' },
      { isSidechain: true, agentId: 'a1', message: {} },
      { role: 'assistant', content: 'ok' },
    ];
    const main = filterMainThread(msgs);
    expect(main).toHaveLength(2);
  });
});

describe('assessHealth', () => {
  test('counts main and sidechain messages', () => {
    const msgs = [
      { role: 'user' },
      { isSidechain: true, agentId: 'a1' },
      { isSidechain: true, agentId: 'a2' },
    ];
    const health = assessHealth(msgs);
    expect(health.mainThreadMessages).toBe(1);
    expect(health.sidechainMessages).toBe(2);
    expect(health.uniqueAgents).toBe(2);
  });

  test('detects orphaned tool_use', () => {
    const msgs = [
      { content: [{ type: 'tool_use', id: 'tu1' }] },
      // No matching tool_result
    ];
    const health = assessHealth(msgs);
    expect(health.hasOrphanedToolUse).toBe(true);
  });

  test('no orphans when all resolved', () => {
    const msgs = [
      { content: [{ type: 'tool_use', id: 'tu1' }] },
      { content: [{ type: 'tool_result', tool_use_id: 'tu1' }] },
    ];
    const health = assessHealth(msgs);
    expect(health.hasOrphanedToolUse).toBe(false);
  });
});
