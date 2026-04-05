import { describe, expect, test } from 'bun:test';
import { snip } from '../compact/snip';

describe('snip', () => {
  test('drops tool_result bodies older than keepLastN turns, keeps tool_use', () => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'turn 1' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'OLD BIG RESULT' }] },
      { role: 'user', content: [{ type: 'text', text: 'turn 2' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'Read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'KEEP ME' }] },
    ];
    const out = snip(messages, { keepLastN: 1 });
    // t1's tool_use block must remain intact
    expect(out[1].content[0]).toEqual({ type: 'tool_use', id: 't1', name: 'Read', input: {} });
    // t1's tool_result content is replaced with a placeholder containing 'snipped'
    const t1Result = out[2].content[0] as any;
    expect(t1Result.content).toContain('snipped');
    // t2 stays intact because it is within the last keepLastN turns
    expect((out[5].content[0] as any).content).toBe('KEEP ME');
  });

  test('keeps all results when keepLastN >= number of turns', () => {
    const messages = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'R', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'RESULT' }] },
    ];
    const out = snip(messages, { keepLastN: 5 });
    expect((out[1].content[0] as any).content).toBe('RESULT');
  });

  test('snips all results when keepLastN is 0', () => {
    const messages = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'R', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'BIG' }] },
    ];
    const out = snip(messages, { keepLastN: 0 });
    expect((out[1].content[0] as any).content).toContain('snipped');
  });

  test('non-tool_result blocks in old turns are not modified', () => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'hi', _closed: false }] },
      { role: 'user', content: [{ type: 'text', text: 'turn 2' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'R', input: {} }] },
    ];
    const out = snip(messages, { keepLastN: 1 });
    // text blocks should be unchanged
    expect((out[0].content[0] as any).text).toBe('hello');
    expect((out[1].content[0] as any).text).toBe('hi');
  });

  test('returns a new array without mutating the original', () => {
    const messages = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'R', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'original' }] },
      { role: 'user', content: [{ type: 'text', text: 'next' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'R', input: {} }] },
    ];
    const out = snip(messages, { keepLastN: 1 });
    expect(out).not.toBe(messages);
    // Original must not be mutated
    expect((messages[1].content[0] as any).content).toBe('original');
    expect((out[1].content[0] as any).content).toContain('snipped');
  });
});
