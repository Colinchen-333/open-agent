/**
 * Emit a single JSON object as a newline-delimited JSON (NDJSON) line on
 * stdout.  Consumers can read the stream line-by-line and parse each line
 * independently (e.g. `for await (const line of process.stdin) JSON.parse(line)`).
 */
export function emitStreamJson(message: unknown): void {
  process.stdout.write(JSON.stringify(message) + '\n');
}
