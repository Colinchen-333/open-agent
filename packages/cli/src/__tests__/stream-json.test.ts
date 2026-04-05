import { describe, expect, test } from 'bun:test';
import { writeStreamJsonLine } from '../stream-json';
import { Writable } from 'node:stream';

function captureStream(): { sink: Writable; get(): string } {
  let buf = '';
  const sink = new Writable({
    write(chunk, _enc, cb) { buf += chunk.toString(); cb(); },
  });
  return { sink, get: () => buf };
}

describe('writeStreamJsonLine', () => {
  test('writes a user message as one JSON line with trailing newline', () => {
    const { sink, get } = captureStream();
    writeStreamJsonLine({ type: 'user', message: { role: 'user', content: 'hi' } } as any, sink);
    const output = get();
    expect(output).toMatch(/\n$/);
    expect(output.split('\n').filter(Boolean)).toHaveLength(1);
    const parsed = JSON.parse(output.trim());
    expect(parsed.type).toBe('user');
  });

  test('writes an assistant message without pretty-printing', () => {
    const { sink, get } = captureStream();
    writeStreamJsonLine({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } } as any, sink);
    const output = get().trim();
    expect(output).not.toContain('\n  '); // no indentation
    expect(JSON.parse(output).type).toBe('assistant');
  });

  test('writes a result message', () => {
    const { sink, get } = captureStream();
    writeStreamJsonLine({ type: 'result', subtype: 'success', duration_ms: 123, total_cost_usd: 0 } as any, sink);
    const output = JSON.parse(get().trim());
    expect(output.subtype).toBe('success');
  });

  test('multiple writes produce multiple lines', () => {
    const { sink, get } = captureStream();
    writeStreamJsonLine({ type: 'user', message: { role: 'user', content: 'a' } } as any, sink);
    writeStreamJsonLine({ type: 'assistant', message: { role: 'assistant', content: [] } } as any, sink);
    const lines = get().split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).type).toBe('user');
    expect(JSON.parse(lines[1]!).type).toBe('assistant');
  });

  test('throws TypeError on invalid message (no type)', () => {
    const { sink } = captureStream();
    expect(() => writeStreamJsonLine({ foo: 'bar' } as any, sink)).toThrow(TypeError);
  });

  test('defaults to process.stdout when no stream provided', () => {
    // Just verify no throw — hard to intercept process.stdout reliably
    expect(() => writeStreamJsonLine({ type: 'user', message: { role: 'user', content: '' } } as any)).not.toThrow();
  });
});
