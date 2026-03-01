import { randomUUID } from 'crypto';
import type { SDKMessage, SDKUserMessage, SDKResultMessage } from '@open-agent/core';
import { SessionManager } from '@open-agent/core';
import type { Message } from '@open-agent/providers';
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
  const initialMessages = __internal_loadInitialMessages(sessionMgr, cwd, sessionId);

  return _buildSession(sessionId, options, initialMessages);
}

/**
 * Fork an existing session — creates a new session with a new ID that starts
 * with the same conversation history as the original.
 *
 * This is useful when you want to branch a conversation: e.g. try two
 * different approaches while preserving the shared context.
 *
 * @param sessionId - The session to fork from.
 * @param options   - Options for the forked session (should use same model/cwd).
 *
 * @example
 * ```ts
 * const original = createSession({ model: 'claude-sonnet-4-6', persistSession: true });
 * for await (const msg of original.send('Analyze auth module')) { ... }
 *
 * // Fork to try two approaches
 * const fork1 = forkSession(original.sessionId, { cwd: '/my/project' });
 * const fork2 = forkSession(original.sessionId, { cwd: '/my/project' });
 *
 * for await (const msg of fork1.send('Refactor using JWT')) { ... }
 * for await (const msg of fork2.send('Refactor using OAuth')) { ... }
 * ```
 */
export function forkSession(sessionId: string, options?: QueryOptions): SDKSession {
  const cwd = options?.cwd ?? process.cwd();
  const sessionMgr = new SessionManager();
  const initialMessages = __internal_loadInitialMessages(sessionMgr, cwd, sessionId);

  // Create a new session with a fresh ID but the same history
  const forkedId = randomUUID();
  return _buildSession(forkedId, options, initialMessages);
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
  /** Supports `await using session = …` (TC39 explicit resource management). */
  [Symbol.asyncDispose](): Promise<void>;
}

// --------------------------------------------------------------------------
// Internal builder
// --------------------------------------------------------------------------

const MAX_SESSION_HISTORY = 500;

export function __internal_buildSessionTurnQueryOptions(
  options: QueryOptions | undefined,
  sessionId: string,
  abortController: AbortController,
  history: Message[],
): QueryOptions & { initialMessages: Message[] } {
  return {
    ...options,
    sessionId,
    abortController,
    initialMessages: history,
    // Stable session API persists transcript itself; disable query-level
    // persistence to avoid duplicate transcript entries.
    persistSession: false,
  };
}

export function __internal_loadInitialMessages(
  sessionManager: Pick<SessionManager, 'loadTranscript' | 'loadTranscriptAnyCwd'>,
  cwd: string,
  sessionId: string,
): Message[] {
  try {
    if (typeof sessionManager.loadTranscriptAnyCwd === 'function') {
      return sessionManager.loadTranscriptAnyCwd(sessionId, cwd);
    }
    return sessionManager.loadTranscript(cwd, sessionId);
  } catch {
    // Corrupted or missing transcript — start fresh rather than crashing.
    return [];
  }
}

export function __internal_appendSdkMessageToHistory(
  history: Message[],
  msg: SDKMessage,
): void {
  if (msg.type === 'user' || msg.type === 'assistant') {
    const rawMessage = (msg as { message?: unknown }).message;
    if (typeof rawMessage === 'string') {
      history.push({
        role: msg.type,
        content: rawMessage,
      });
    } else if (rawMessage && typeof rawMessage === 'object' && 'role' in rawMessage) {
      history.push(rawMessage as Message);
    }
  } else if (msg.type === 'tool_result') {
    const toolUseId = (msg as any).tool_use_id;
    const result = (msg as any)._fullResult ?? (msg as any).result ?? '';
    const isError = (msg as any).is_error === true;
    const toolResultBlock = {
      type: 'tool_result' as const,
      tool_use_id: toolUseId,
      content: typeof result === 'string' ? result : JSON.stringify(result),
      ...(isError ? { is_error: true } : {}),
    };
    const lastMsg = history[history.length - 1];
    if (
      lastMsg?.role === 'user' &&
      Array.isArray(lastMsg.content) &&
      lastMsg.content.length > 0 &&
      (lastMsg.content[0] as any)?.type === 'tool_result'
    ) {
      (lastMsg.content as any[]).push(toolResultBlock);
    } else {
      history.push({ role: 'user', content: [toolResultBlock] as any });
    }
  }
  if (history.length > MAX_SESSION_HISTORY) {
    history.splice(0, history.length - MAX_SESSION_HISTORY);
  }
}

function _buildSession(
  sessionId: string,
  options?: QueryOptions,
  initialMessages?: Message[],
): SDKSession {
  let closed = false;
  const abortController = options?.abortController ?? new AbortController();
  // Conversation history accumulates across turns so the model retains context.
  const history: Message[] = initialMessages ? [...initialMessages] : [];

  // Session manager for persisting transcripts when requested.
  const shouldPersist = options?.persistSession ?? false;
  const sessionMgr = shouldPersist ? new SessionManager() : null;
  const cwd = options?.cwd ?? process.cwd();
  if (sessionMgr) {
    try {
      sessionMgr.ensureSession(cwd, sessionId, options?.model ?? 'unknown');
    } catch {
      // Non-critical: keep session usable even if metadata initialization fails.
    }
  }

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
      const q = query(
        message,
        __internal_buildSessionTurnQueryOptions(options, sessionId, abortController, history),
      );

      try {
        for await (const msg of q) {
          // Capture user/assistant turns into history for the next send().
          if (msg.type === 'user' || msg.type === 'assistant' || msg.type === 'tool_result') {
            __internal_appendSdkMessageToHistory(history, msg);
            // Persist to disk if requested.
            if (sessionMgr) {
              try {
                sessionMgr.appendToTranscript(cwd, sessionId, msg);
              } catch {
                // Non-critical: don't crash if disk write fails.
              }
            }
          }

          yield msg;
          // Stop iterating this turn once we get the result.
          if (msg.type === 'result') {
            if (sessionMgr) {
              try {
                sessionMgr.appendToTranscript(cwd, sessionId, msg);
                sessionMgr.touchSession(cwd, sessionId);
              } catch { /* non-critical */ }
            }
            break;
          }
        }
      } finally {
        q.close();
      }
    },

    close(): void {
      closed = true;
      if (!abortController.signal.aborted) {
        abortController.abort();
      }
    },

    async [Symbol.asyncDispose](): Promise<void> {
      this.close();
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
      cwd: options.cwd,
      permissionMode: options.permissionMode,
      allowedTools: options.allowedTools,
      disallowedTools: options.disallowedTools,
      hooks: options.hooks,
      env: options.env,
    },
  });

  let result: SDKResultMessage | undefined;
  try {
    for await (const msg of q) {
      if (msg.type === 'result') {
        result = msg;
      }
    }
  } finally {
    q.close();
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
export function unstable_v2_createSession(
  options: SessionOptions,
  _initialMessages?: Message[],
  _sessionId?: string,
): Session {
  const sessionId = _sessionId ?? randomUUID();
  let closed = false;

  const messageQueue: SDKUserMessage[] = [];
  let resolveNext: ((msg: SDKUserMessage) => void) | null = null;
  // Track the pending promise's reject so we can settle it on close().
  let rejectNext: ((err: Error) => void) | null = null;

  async function* userMessages(): AsyncIterable<SDKUserMessage> {
    while (!closed) {
      if (messageQueue.length > 0) {
        yield messageQueue.shift()!;
      } else {
        try {
          yield await new Promise<SDKUserMessage>((resolve, reject) => {
            resolveNext = resolve;
            rejectNext = reject;
          });
        } catch {
          // Promise was rejected by close() — stop iterating.
          return;
        }
      }
    }
  }

  const q = query({
    prompt: userMessages(),
    options: {
      model: options.model,
      cwd: options.cwd,
      sessionId,
      permissionMode: options.permissionMode,
      allowedTools: options.allowedTools,
      disallowedTools: options.disallowedTools,
      hooks: options.hooks,
      env: options.env,
      // Pass initial messages so resumed sessions have prior conversation context.
      ...(_initialMessages && _initialMessages.length > 0
        ? { initialMessages: _initialMessages }
        : {}),
    } as QueryOptions & { initialMessages?: Message[] },
  });

  return {
    get sessionId(): string {
      return sessionId;
    },

    async send(message: string | SDKUserMessage): Promise<void> {
      if (closed) {
        throw new Error(`Session ${sessionId} is closed.`);
      }
      const msg: SDKUserMessage =
        typeof message === 'string'
          ? {
              type: 'user',
              message: { role: 'user', content: message },
              parent_tool_use_id: null,
              uuid: randomUUID(),
              session_id: sessionId,
            }
          : {
              ...message,
              type: 'user',
              parent_tool_use_id: message.parent_tool_use_id ?? null,
              session_id: sessionId,
              uuid: message.uuid ?? randomUUID(),
            };

      if (resolveNext) {
        const resolve = resolveNext;
        resolveNext = null;
        rejectNext = null;
        resolve(msg);
      } else {
        messageQueue.push(msg);
      }
    },

    async *stream(): AsyncGenerator<SDKMessage, void> {
      yield* q;
    },

    close(): void {
      if (closed) return;
      closed = true;
      // Settle any pending promise so the userMessages() generator exits cleanly
      // instead of leaking a dangling promise.
      if (rejectNext) {
        const reject = rejectNext;
        resolveNext = null;
        rejectNext = null;
        reject(new Error('Session closed'));
      }
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
  // Restore conversation transcript from disk before creating session.
  const cwd = options?.cwd ?? process.cwd();
  const sessionMgr = new SessionManager();
  const initialMessages = __internal_loadInitialMessages(sessionMgr, cwd, sessionId);

  // Pass the loaded transcript into the session so the underlying query()
  // feeds prior conversation history to the model on the first turn.
  return unstable_v2_createSession({ ...options }, initialMessages, sessionId);
}
