import { describe, expect, test } from 'bun:test';
import { readNdjsonStream, filterMessagesByType, type NdjsonMessage } from '../structured-io';

async function* fromLines(lines: string[]): AsyncGenerator<string> {
  for (const line of lines) yield line;
}

async function collect<T>(gen: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of gen) result.push(item);
  return result;
}

describe('readNdjsonStream', () => {
  test('parses complete JSON lines', async () => {
    const input = fromLines(['{"type":"user","content":"hi"}\n', '{"type":"assistant","content":"hey"}\n']);
    const msgs = await collect(readNdjsonStream(input));
    expect(msgs).toHaveLength(2);
    expect(msgs[0].type).toBe('user');
    expect(msgs[1].type).toBe('assistant');
  });

  test('handles partial lines across chunks', async () => {
    const input = fromLines(['{"type":', '"test"}\n']);
    const msgs = await collect(readNdjsonStream(input));
    expect(msgs).toHaveLength(1);
    expect(msgs[0].type).toBe('test');
  });

  test('skips blank lines', async () => {
    const input = fromLines(['{"type":"a"}\n', '\n', '\n', '{"type":"b"}\n']);
    const msgs = await collect(readNdjsonStream(input));
    expect(msgs).toHaveLength(2);
  });

  test('skips invalid JSON lines', async () => {
    const input = fromLines(['not json\n', '{"type":"valid"}\n', '{broken\n']);
    const msgs = await collect(readNdjsonStream(input));
    expect(msgs).toHaveLength(1);
    expect(msgs[0].type).toBe('valid');
  });

  test('skips objects without type field', async () => {
    const input = fromLines(['{"data":"no-type"}\n', '{"type":"ok"}\n']);
    const msgs = await collect(readNdjsonStream(input));
    expect(msgs).toHaveLength(1);
  });

  test('handles multiple lines in single chunk', async () => {
    const input = fromLines(['{"type":"a"}\n{"type":"b"}\n{"type":"c"}\n']);
    const msgs = await collect(readNdjsonStream(input));
    expect(msgs).toHaveLength(3);
  });

  test('flushes trailing buffer without newline', async () => {
    const input = fromLines(['{"type":"trailing"}']);
    const msgs = await collect(readNdjsonStream(input));
    expect(msgs).toHaveLength(1);
    expect(msgs[0].type).toBe('trailing');
  });

  test('handles Buffer input', async () => {
    async function* bufInput(): AsyncGenerator<Buffer> {
      yield Buffer.from('{"type":"buf"}\n');
    }
    const msgs = await collect(readNdjsonStream(bufInput()));
    expect(msgs).toHaveLength(1);
    expect(msgs[0].type).toBe('buf');
  });
});

describe('filterMessagesByType', () => {
  test('filters by type', async () => {
    const input = fromLines([
      '{"type":"user","text":"hi"}\n',
      '{"type":"system","data":"x"}\n',
      '{"type":"user","text":"bye"}\n',
    ]);
    const all = readNdjsonStream(input);
    const users = await collect(filterMessagesByType(all, 'user'));
    expect(users).toHaveLength(2);
    expect(users.every(m => m.type === 'user')).toBe(true);
  });
});
