/**
 * NDJSON stdout guard.
 *
 * When OpenAgent runs in `--output-format stream-json` mode the SDK
 * consumer expects every line on stdout to be valid JSON.  Stray writes
 * from third-party dependencies (debug logs, deprecation warnings, etc.)
 * would corrupt the NDJSON stream and crash the consumer's parser.
 *
 * `installStreamJsonStdoutGuard()` monkey-patches `process.stdout.write`
 * to buffer text until a full line (`\n`) is available, then validates
 * each line with `JSON.parse`.  Valid JSON lines are forwarded to the
 * real stdout; invalid lines are diverted to stderr with a
 * `[stdout-guard]` prefix so they are still visible for debugging but
 * cannot poison the consumer.
 */

export { ndjsonSafeStringify } from './ndjson';

/** Prefix prepended to non-JSON lines diverted to stderr. */
export const STDOUT_GUARD_MARKER = '[stdout-guard]';

/**
 * Returns `true` when `line` is a valid NDJSON line.
 *
 * Empty lines (blank separators) are considered valid — the NDJSON spec
 * explicitly allows them.
 */
function isJsonLine(line: string): boolean {
  if (line === '') return true;
  try {
    JSON.parse(line);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

/** The real, unwrapped `process.stdout.write` — set on first install. */
let originalWrite: typeof process.stdout.write | null = null;

/** Partial line buffer (text received but no trailing `\n` yet). */
let buffer = '';

/** Guard against double-install. */
let installed = false;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Install the stdout JSON guard.
 *
 * Idempotent — calling it more than once is a safe no-op.
 */
export function installStreamJsonStdoutGuard(): void {
  if (installed) return;

  originalWrite = process.stdout.write.bind(
    process.stdout,
  ) as typeof process.stdout.write;
  installed = true;

  process.stdout.write = function guardedWrite(
    chunk: Uint8Array | string,
    encodingOrCallback?: BufferEncoding | ((err?: Error | null) => void),
    callback?: (err?: Error | null) => void,
  ): boolean {
    // Normalise the overloaded signature so we always have `cb`.
    let cb: ((err?: Error | null) => void) | undefined;
    if (typeof encodingOrCallback === 'function') {
      cb = encodingOrCallback;
    } else {
      cb = callback;
    }

    const text = typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
    buffer += text;

    // Process every complete line in the buffer.
    let idx: number;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);

      if (isJsonLine(line)) {
        // Forward the valid JSON line (with its newline) to real stdout.
        originalWrite!(line + '\n');
      } else {
        // Divert to stderr so it never reaches the NDJSON consumer.
        process.stderr.write(`${STDOUT_GUARD_MARKER} ${line}\n`);
      }
    }

    // Invoke the caller-supplied callback, if any.
    if (cb) cb(null);
    return true;
  } as typeof process.stdout.write;
}

/**
 * Restore the original `process.stdout.write` and clear internal state.
 * Intended **only** for test isolation — production code should not call this.
 */
export function _resetStreamJsonStdoutGuardForTesting(): void {
  if (originalWrite) {
    // Flush any remaining partial buffer before restoring.
    if (buffer.length > 0) {
      if (isJsonLine(buffer)) {
        originalWrite(buffer + '\n');
      } else {
        process.stderr.write(`${STDOUT_GUARD_MARKER} ${buffer}\n`);
      }
    }
    process.stdout.write = originalWrite;
    originalWrite = null;
  }
  buffer = '';
  installed = false;
}
