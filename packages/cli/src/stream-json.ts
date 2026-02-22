import type { SDKMessage } from '@open-agent/core';

/**
 * Emit an NDJSON init line at the start of a stream-json session.
 * Claude Code emits this as the first line before any prompt output.
 */
export function emitStreamJsonInit(info: {
  tools: string[];
  model: string;
  cwd: string;
  permissionMode: string;
  sessionId: string;
}): void {
  const init = {
    type: 'system',
    subtype: 'init',
    tools: info.tools,
    model: info.model,
    cwd: info.cwd,
    permissionMode: info.permissionMode,
    sessionId: info.sessionId,
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
