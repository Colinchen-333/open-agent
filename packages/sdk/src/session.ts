import { randomUUID } from 'crypto';
import type { SDKMessage, SDKUserMessage, SDKResultMessage } from '@open-agent/core';
import type { SessionOptions, Session } from './types.js';
import { query } from './query.js';

// --------------------------------------------------------------------------
// V2 one-shot prompt
// --------------------------------------------------------------------------

/**
 * Send a single message, wait for the full result, and return the final
 * `SDKResultMessage`.  Intended for simple request-response use-cases where
 * stateful session management is unnecessary.
 *
 * @example
 * ```ts
 * const result = await unstable_v2_prompt('What is 2 + 2?', { model: 'claude-sonnet-4-6' });
 * console.log(result?.result);
 * ```
 */
export async function unstable_v2_prompt(
  message: string,
  options: SessionOptions,
): Promise<SDKResultMessage | undefined> {
  const q = query({
    prompt: message,
    options: {
      model: options.model,
      permissionMode: options.permissionMode,
      allowedTools: options.allowedTools,
      disallowedTools: options.disallowedTools,
      hooks: options.hooks,
      env: options.env,
    },
  });

  let result: SDKResultMessage | undefined;
  for await (const msg of q) {
    if (msg.type === 'result') {
      result = msg;
    }
  }
  return result;
}

// --------------------------------------------------------------------------
// V2 create session
// --------------------------------------------------------------------------

/**
 * Create a long-lived, stateful agent session.  Messages are enqueued via
 * `session.send()` and consumed through `session.stream()`.
 *
 * The session implements the TC39 explicit-resource-management protocol
 * (`Symbol.asyncDispose`) so it can be used with `await using`:
 *
 * @example
 * ```ts
 * await using session = unstable_v2_createSession({ model: 'claude-sonnet-4-6' });
 * await session.send('Hello!');
 * for await (const msg of session.stream()) {
 *   if (msg.type === 'result') break;
 * }
 * ```
 */
export function unstable_v2_createSession(options: SessionOptions): Session {
  const sessionId = randomUUID();
  let closed = false;

  // A simple queue + promise-based mechanism for bridging the synchronous
  // `send()` call into an async iterable that the ConversationLoop can
  // consume.
  const messageQueue: SDKUserMessage[] = [];
  let resolveNext: ((msg: SDKUserMessage) => void) | null = null;

  async function* userMessages(): AsyncIterable<SDKUserMessage> {
    while (!closed) {
      if (messageQueue.length > 0) {
        yield messageQueue.shift()!;
      } else {
        // Park until the next send() call resolves the promise.
        yield await new Promise<SDKUserMessage>((resolve) => {
          resolveNext = resolve;
        });
      }
    }
  }

  const q = query({
    prompt: userMessages(),
    options: {
      model: options.model,
      sessionId,
      permissionMode: options.permissionMode,
      allowedTools: options.allowedTools,
      disallowedTools: options.disallowedTools,
      hooks: options.hooks,
      env: options.env,
    },
  });

  return {
    get sessionId(): string {
      return sessionId;
    },

    async send(message: string | SDKUserMessage): Promise<void> {
      const msg: SDKUserMessage =
        typeof message === 'string'
          ? {
              type: 'user',
              message: { role: 'user', content: message },
              parent_tool_use_id: null,
              uuid: randomUUID(),
              session_id: sessionId,
            }
          : message;

      if (resolveNext) {
        // There is already a parked consumer — unblock it immediately.
        const resolve = resolveNext;
        resolveNext = null;
        resolve(msg);
      } else {
        messageQueue.push(msg);
      }
    },

    async *stream(): AsyncGenerator<SDKMessage, void> {
      yield* q;
    },

    close(): void {
      closed = true;
      q.close();
    },

    async [Symbol.asyncDispose](): Promise<void> {
      this.close();
    },
  };
}

// --------------------------------------------------------------------------
// V2 resume session
// --------------------------------------------------------------------------

/**
 * Re-attach to a previously created session by its ID.  Full transcript
 * replay is not yet implemented; this currently creates a fresh session
 * with the same ID so callers can at least continue sending messages.
 *
 * @param sessionId - The session ID returned by a prior `unstable_v2_createSession`.
 * @param options   - Session options (must match the original session's model).
 */
export function unstable_v2_resumeSession(
  sessionId: string,
  options: SessionOptions,
): Session {
  // TODO: Restore conversation history from a persisted transcript before
  //       handing off to the ConversationLoop so the model retains context.
  const session = unstable_v2_createSession(options);

  // Override the generated sessionId with the one being resumed so callers
  // receive consistent session_id values in streamed SDKMessages.
  Object.defineProperty(session, 'sessionId', {
    value: sessionId,
    writable: false,
    configurable: true,
  });

  return session;
}
