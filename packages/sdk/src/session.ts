import { randomUUID } from 'crypto';
import type { SDKMessage, SDKUserMessage, SDKResultMessage } from '@open-agent/core';
import { SessionManager } from '@open-agent/core';
import type { SessionOptions, Session, QueryOptions } from './types.js';
import { query } from './query.js';

// --------------------------------------------------------------------------
// V2 stable API — createSession / resumeSession
// --------------------------------------------------------------------------

/**
 * Create a multi-turn stateful agent session.
 *
 * The returned `SDKSession` lets you:
 * - Call `send(message)` to get an async generator of `SDKMessage` for each turn.
 * - Call `close()` to terminate the session.
 *
 * @example
 * ```ts
 * const session = createSession({ model: 'claude-sonnet-4-6' });
 * for await (const msg of session.send('Hello!')) {
 *   if (msg.type === 'result') console.log(msg.result);
 * }
 * session.close();
 * ```
 */
export function createSession(options?: QueryOptions): SDKSession {
  return _buildSession(randomUUID(), options);
}

/**
 * Resume a previously created session by its ID, restoring conversation history.
 *
 * @param sessionId - The `sessionId` returned by a prior `createSession` call.
 * @param options   - Session options (should use the same model/cwd as the original).
 *
 * @example
 * ```ts
 * const session = resumeSession('abc-123', { cwd: '/my/project' });
 * for await (const msg of session.send('Continue from where we left off')) { ... }
 * ```
 */
export function resumeSession(sessionId: string, options?: QueryOptions): SDKSession {
  const cwd = options?.cwd ?? process.cwd();
  const sessionMgr = new SessionManager();
  const initialMessages = sessionMgr.loadTranscript(cwd, sessionId);

  return _buildSession(sessionId, options, initialMessages);
}

/**
 * The session handle returned by `createSession` / `resumeSession`.
 * Each call to `send()` runs one conversation turn and yields SDK messages.
 */
export interface SDKSession {
  /** Stable identifier for this session. */
  readonly sessionId: string;
  /**
   * Send a user message and iterate over the SDK messages for that turn.
   * The generator completes (returns) when the agent produces a `result` message.
   */
  send(message: string): AsyncGenerator<SDKMessage, void>;
  /** Terminate the session and release resources. */
  close(): void;
}

// --------------------------------------------------------------------------
// Internal builder
// --------------------------------------------------------------------------

function _buildSession(
  sessionId: string,
  options?: QueryOptions,
  initialMessages?: import('@open-agent/providers').Message[],
): SDKSession {
  let closed = false;
  // Conversation history accumulates across turns so the model retains context.
  const history: import('@open-agent/providers').Message[] = initialMessages ? [...initialMessages] : [];

  return {
    get sessionId(): string {
      return sessionId;
    },

    async *send(message: string): AsyncGenerator<SDKMessage, void> {
      if (closed) {
        throw new Error(`Session ${sessionId} is closed.`);
      }

      // Each send() uses a fresh query() call with accumulated history
      // so the ConversationLoop sees the full prior context.
      const q = query(message, {
        ...options,
        sessionId,
        initialMessages: history as any,
      } as QueryOptions & { initialMessages: any });

      for await (const msg of q) {
        // Capture user/assistant turns into history for the next send().
        if (msg.type === 'user' || msg.type === 'assistant') {
          const msgRecord = (msg as any).message;
          if (msgRecord) {
            history.push(msgRecord as import('@open-agent/providers').Message);
          }
        }
        yield msg;
        // Stop iterating this turn once we get the result.
        if (msg.type === 'result') break;
      }

      q.close();
    },

    close(): void {
      closed = true;
    },
  };
}

// --------------------------------------------------------------------------
// V2 unstable API — preserved for backwards compatibility
// --------------------------------------------------------------------------

/**
 * Send a single message, wait for the full result, and return the final
 * `SDKResultMessage`.  Intended for simple request-response use-cases.
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

/**
 * Create a long-lived, stateful agent session using the legacy queue-based API.
 * Prefer `createSession()` for new code.
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

  const messageQueue: SDKUserMessage[] = [];
  let resolveNext: ((msg: SDKUserMessage) => void) | null = null;

  async function* userMessages(): AsyncIterable<SDKUserMessage> {
    while (!closed) {
      if (messageQueue.length > 0) {
        yield messageQueue.shift()!;
      } else {
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

/**
 * Re-attach to a previously created unstable_v2 session by its ID.
 * Prefer `resumeSession()` for new code.
 */
export function unstable_v2_resumeSession(
  sessionId: string,
  options: SessionOptions,
): Session {
  // Restore conversation transcript from disk before creating session
  const cwd = options?.cwd ?? process.cwd();
  const sessionMgr = new SessionManager();
  const initialMessages = sessionMgr.loadTranscript(cwd, sessionId);

  const session = unstable_v2_createSession({
    ...options,
    resume: sessionId,
    initialMessages,
  } as any);

  Object.defineProperty(session, 'sessionId', {
    value: sessionId,
    writable: false,
    configurable: true,
  });

  return session;
}
