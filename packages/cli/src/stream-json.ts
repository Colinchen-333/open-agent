import { randomUUID } from 'crypto';
import type { SDKMessage } from '@open-agent/core';

/**
 * Emit an NDJSON init line at the start of a stream-json session.
 * Claude Code emits this as the first line before any prompt output.
 */
export function emitStreamJsonInit(info: {
  tools: string[];
  capabilitySnapshot?: unknown;
  model: string;
  cwd: string;
  permissionMode: string;
  sessionId: string;
}): void {
  const init = {
    type: 'system',
    subtype: 'init',
    tools: info.tools,
    ...(info.capabilitySnapshot ? { capability_snapshot: info.capabilitySnapshot } : {}),
    model: info.model,
    cwd: info.cwd,
    permissionMode: info.permissionMode,
    session_id: info.sessionId,
    uuid: randomUUID(),
  };
  process.stdout.write(JSON.stringify(init) + '\n');
}

/**
 * Emit a single SDKMessage as a newline-delimited JSON (NDJSON) line on
 * stdout, normalising the shape to match Claude Code's stream-json format.
 *
 * Key transformations:
 * - `stream_event` wrapper is unwrapped: the inner event is emitted directly
 * - All other message types are passed through as-is
 */
export function emitStreamJson(message: SDKMessage): void {
  // Unwrap stream_event so consumers see flat Anthropic events
  if (message.type === 'stream_event' && (message as any).event) {
    process.stdout.write(JSON.stringify((message as any).event) + '\n');
    return;
  }
  process.stdout.write(JSON.stringify(message) + '\n');
}

/**
 * Write exactly one JSON line + `\n` for a single SDKMessage to the given
 * writable stream (defaults to `process.stdout`).
 *
 * Alignment with Claude Code SDK protocol:
 * - One JSON object per line, no pretty-printing, no ANSI escape codes.
 * - Each write is a single `stream.write()` call — no buffering across calls.
 * - The `type` discriminant must be present; if absent a TypeError is thrown
 *   so callers get an explicit signal rather than a silent malformed line.
 *
 * @param msg - Any member of the SDKMessage union.
 * @param out - Optional writable stream; defaults to `process.stdout`.
 */
export function writeStreamJsonLine(
  msg: SDKMessage,
  out: NodeJS.WritableStream = process.stdout,
): void {
  if (typeof (msg as any)?.type !== 'string') {
    throw new TypeError(
      `writeStreamJsonLine: msg must have a string "type" field (received ${JSON.stringify(msg)})`,
    );
  }
  out.write(JSON.stringify(msg) + '\n');
}
