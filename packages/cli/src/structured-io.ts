/**
 * Bidirectional NDJSON I/O for SDK client communication.
 * Reads NDJSON lines from stdin and yields parsed messages.
 */

export interface NdjsonMessage {
  type: string;
  [key: string]: unknown;
}

/**
 * Read NDJSON lines from an async iterable (typically process.stdin).
 * Buffers partial lines, validates JSON, yields parsed messages.
 * Invalid lines are silently skipped (logged to stderr if debug).
 */
export async function* readNdjsonStream(
  input: AsyncIterable<string | Buffer>,
  opts?: { debug?: boolean },
): AsyncGenerator<NdjsonMessage> {
  let buffer = '';

  for await (const chunk of input) {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');

    let newlineIdx: number;
    while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);

      if (line.length === 0) continue; // skip blank lines

      try {
        const parsed = JSON.parse(line);
        if (typeof parsed === 'object' && parsed !== null && typeof parsed.type === 'string') {
          yield parsed as NdjsonMessage;
        } else if (opts?.debug) {
          process.stderr.write(`[structured-io] skipped non-object or missing type: ${line.slice(0, 100)}\n`);
        }
      } catch {
        if (opts?.debug) {
          process.stderr.write(`[structured-io] invalid JSON: ${line.slice(0, 100)}\n`);
        }
      }
    }
  }

  // Flush remaining buffer
  if (buffer.trim().length > 0) {
    try {
      const parsed = JSON.parse(buffer.trim());
      if (typeof parsed === 'object' && parsed !== null && typeof parsed.type === 'string') {
        yield parsed as NdjsonMessage;
      }
    } catch {
      if (opts?.debug) {
        process.stderr.write(`[structured-io] trailing invalid JSON: ${buffer.trim().slice(0, 100)}\n`);
      }
    }
  }
}

/**
 * Convenience: create a StructuredIO reader from process.stdin.
 * Automatically sets encoding to utf-8.
 */
export function createStdinReader(opts?: { debug?: boolean }): AsyncGenerator<NdjsonMessage> {
  // Bun's process.stdin is an AsyncIterable
  if (!process.stdin.readable) {
    throw new Error('stdin is not readable (likely already closed or not piped)');
  }
  return readNdjsonStream(process.stdin as any, opts);
}

/**
 * Filter messages by type from an NDJSON stream.
 */
export async function* filterMessagesByType<T extends NdjsonMessage>(
  stream: AsyncIterable<NdjsonMessage>,
  type: string,
): AsyncGenerator<T> {
  for await (const msg of stream) {
    if (msg.type === type) yield msg as T;
  }
}
