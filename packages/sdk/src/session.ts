import { randomUUID } from 'crypto';
import type { SDKMessage, SDKUserMessage, SDKResultMessage } from '@open-agent/core';
import { SessionManager } from '@open-agent/core';
import type { Message } from '@open-agent/providers';
import type { SessionOptions, Session, Query, QueryOptions } from './types.js';
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
type SessionControlMethods = Pick<
  Query,
  | 'interrupt'
  | 'setPermissionMode'
  | 'setModel'
  | 'setMaxThinkingTokens'
  | 'supportedCommands'
  | 'supportedModels'
  | 'supportedAgents'
  | 'supportedSkills'
  | 'readRuntimeControlPlane'
  | 'listRuntimeDiagnostics'
  | 'readOrchestrationControlPlane'
  | 'mcpServerStatus'
  | 'accountInfo'
  | 'initializationResult'
  | 'sessionInfo'
  | 'listTeams'
  | 'getTeam'
  | 'createTeam'
  | 'deleteTeam'
  | 'getActiveTeam'
  | 'setActiveTeam'
  | 'sendTeamMessage'
  | 'readTeamInbox'
  | 'acknowledgeTeamInbox'
  | 'listPendingTeamApprovals'
  | 'respondToTeamApproval'
  | 'getTeamInboxCount'
  | 'readTimelineInbox'
  | 'subscribeOrchestrationEvents'
  | 'subscribeTimeline'
  | 'executeFollowUp'
  | 'listWorkers'
  | 'getWorker'
  | 'getWorkerFollowUps'
  | 'launchWorker'
  | 'launchVerifier'
  | 'resumeWorker'
  | 'stopWorker'
  | 'listTasks'
  | 'getTask'
  | 'createTask'
  | 'updateTask'
  | 'claimNextTask'
  | 'heartbeatTask'
  | 'releaseTask'
  | 'startTaskDispatcher'
  | 'resumeTaskDispatcher'
  | 'getTaskDispatcher'
  | 'listTaskDispatchers'
  | 'inspectTaskDispatcherHealth'
  | 'getTaskDispatcherDiagnosis'
  | 'listTaskDispatcherDiagnoses'
  | 'requeueTaskDispatcherAssignment'
  | 'stopTaskDispatcher'
  | 'listBackgroundTasks'
  | 'getBackgroundTask'
  | 'stopTask'
  | 'streamInput'
  | 'reconnectMcpServer'
  | 'toggleMcpServer'
  | 'setMcpServers'
  | 'rewindFiles'
>;

export interface SDKSession extends SessionControlMethods {
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
  let activeTurn = false;
  const messageQueue: SDKUserMessage[] = [];
  let resolveNext: ((msg: SDKUserMessage) => void) | null = null;
  let rejectNext: ((err: Error) => void) | null = null;

  // Session manager for persisting transcripts when requested.
  const shouldPersist = options?.persistSession ?? false;
  const sessionMgr = shouldPersist ? new SessionManager() : null;
  const cwd = options?.cwd ?? process.cwd();
  if (sessionMgr) {
    try {
      sessionMgr.ensureSession(cwd, sessionId, options?.model ?? 'unknown', {
        ...(options?.permissionMode ? { permissionMode: options.permissionMode } : {}),
        ...(options?.outputStyle ? { outputStyle: options.outputStyle } : {}),
        ...(options?.language ? { language: options.language } : {}),
        ...(options?.sessionTitle ? { title: options.sessionTitle, summary: options.sessionTitle } : {}),
      });
    } catch {
      // Non-critical: keep session usable even if metadata initialization fails.
    }
  }

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
          return;
        }
      }
    }
  }

  const q = query({
    prompt: userMessages(),
    options: {
      ...options,
      sessionId,
      abortController,
      ...(initialMessages && initialMessages.length > 0 ? { initialMessages } : {}),
      persistSession: false,
      ...(sessionMgr ? { sessionManager: sessionMgr } : {}),
    },
  });

  const enqueueMessage = (message: SDKUserMessage): void => {
    if (resolveNext) {
      const resolve = resolveNext;
      resolveNext = null;
      rejectNext = null;
      resolve(message);
    } else {
      messageQueue.push(message);
    }
  };

  const persistTurnMessage = (msg: SDKMessage): void => {
    if (!sessionMgr) return;
    if (msg.type === 'user' || msg.type === 'assistant' || msg.type === 'tool_result') {
      try {
        sessionMgr.appendToTranscript(cwd, sessionId, msg);
      } catch {
        // Non-critical
      }
      return;
    }
    if (msg.type === 'result') {
      try {
        sessionMgr.appendToTranscript(cwd, sessionId, msg);
        sessionMgr.touchSession(cwd, sessionId);
      } catch {
        // Non-critical
      }
    }
  };

  return {
    get sessionId(): string {
      return sessionId;
    },

    async *send(message: string): AsyncGenerator<SDKMessage, void> {
      if (closed) {
        throw new Error(`Session ${sessionId} is closed.`);
      }
      if (activeTurn) {
        throw new Error(`Session ${sessionId} already has an active turn.`);
      }

       if (sessionMgr) {
        try {
          const current = sessionMgr.getSession(cwd, sessionId);
          if (!current?.createdFromPrompt) {
            sessionMgr.updateSession(
              cwd,
              sessionId,
              buildPromptSessionMetadata(message, options?.sessionTitle),
              { touch: false },
            );
          }
        } catch {
          // Non-critical
        }
      }
      const sdkMessage: SDKUserMessage = {
        type: 'user',
        message: { role: 'user', content: message },
        parent_tool_use_id: null,
        uuid: randomUUID(),
        session_id: sessionId,
      };
      enqueueMessage(sdkMessage);
      activeTurn = true;
      try {
        while (true) {
          const next = await q.next();
          if (next.done) {
            return;
          }
          const msg = next.value;
          persistTurnMessage(msg);
          yield msg;
          if (msg.type === 'result') {
            break;
          }
        }
      } finally {
        activeTurn = false;
      }
    },

    interrupt: (...args) => q.interrupt(...args),
    setPermissionMode: (...args) => q.setPermissionMode(...args),
    setModel: (...args) => q.setModel(...args),
    setMaxThinkingTokens: (...args) => q.setMaxThinkingTokens(...args),
    supportedCommands: (...args) => q.supportedCommands(...args),
    supportedModels: (...args) => q.supportedModels(...args),
    supportedAgents: (...args) => q.supportedAgents(...args),
    supportedSkills: (...args) => q.supportedSkills(...args),
    readRuntimeControlPlane: (...args) => q.readRuntimeControlPlane(...args),
    listRuntimeDiagnostics: (...args) => q.listRuntimeDiagnostics(...args),
    readOrchestrationControlPlane: (...args) => q.readOrchestrationControlPlane(...args),
    mcpServerStatus: (...args) => q.mcpServerStatus(...args),
    accountInfo: (...args) => q.accountInfo(...args),
    initializationResult: (...args) => q.initializationResult(...args),
    sessionInfo: (...args) => q.sessionInfo(...args),
    listTeams: (...args) => q.listTeams(...args),
    getTeam: (...args) => q.getTeam(...args),
    createTeam: (...args) => q.createTeam(...args),
    deleteTeam: (...args) => q.deleteTeam(...args),
    getActiveTeam: (...args) => q.getActiveTeam(...args),
    setActiveTeam: (...args) => q.setActiveTeam(...args),
    sendTeamMessage: (...args) => q.sendTeamMessage(...args),
    readTeamInbox: (...args) => q.readTeamInbox(...args),
    acknowledgeTeamInbox: (...args) => q.acknowledgeTeamInbox(...args),
    listPendingTeamApprovals: (...args) => q.listPendingTeamApprovals(...args),
    respondToTeamApproval: (...args) => q.respondToTeamApproval(...args),
    getTeamInboxCount: (...args) => q.getTeamInboxCount(...args),
    readTimelineInbox: (...args) => q.readTimelineInbox(...args),
    subscribeOrchestrationEvents: (...args) => q.subscribeOrchestrationEvents(...args),
    subscribeTimeline: (...args) => q.subscribeTimeline(...args),
    executeFollowUp: (...args) => q.executeFollowUp(...args),
    listWorkers: (...args) => q.listWorkers(...args),
    getWorker: (...args) => q.getWorker(...args),
    getWorkerFollowUps: (...args) => q.getWorkerFollowUps(...args),
    launchWorker: (...args) => q.launchWorker(...args),
    launchVerifier: (...args) => q.launchVerifier(...args),
    resumeWorker: (...args) => q.resumeWorker(...args),
    stopWorker: (...args) => q.stopWorker(...args),
    listTasks: (...args) => q.listTasks(...args),
    getTask: (...args) => q.getTask(...args),
    createTask: (...args) => q.createTask(...args),
    updateTask: (...args) => q.updateTask(...args),
    claimNextTask: (...args) => q.claimNextTask(...args),
    heartbeatTask: (...args) => q.heartbeatTask(...args),
    releaseTask: (...args) => q.releaseTask(...args),
    dispatchNextTask: (...args) => q.dispatchNextTask(...args),
    startTaskDispatcher: (...args) => q.startTaskDispatcher(...args),
    resumeTaskDispatcher: (...args) => q.resumeTaskDispatcher(...args),
    getTaskDispatcher: (...args) => q.getTaskDispatcher(...args),
    listTaskDispatchers: (...args) => q.listTaskDispatchers(...args),
    inspectTaskDispatcherHealth: (...args) => q.inspectTaskDispatcherHealth(...args),
    getTaskDispatcherDiagnosis: (...args) => q.getTaskDispatcherDiagnosis(...args),
    listTaskDispatcherDiagnoses: (...args) => q.listTaskDispatcherDiagnoses(...args),
    requeueTaskDispatcherAssignment: (...args) => q.requeueTaskDispatcherAssignment(...args),
    stopTaskDispatcher: (...args) => q.stopTaskDispatcher(...args),
    listBackgroundTasks: (...args) => q.listBackgroundTasks(...args),
    getBackgroundTask: (...args) => q.getBackgroundTask(...args),
    stopTask: (...args) => q.stopTask(...args),
    streamInput: (...args) => q.streamInput(...args),
    reconnectMcpServer: (...args) => q.reconnectMcpServer(...args),
    toggleMcpServer: (...args) => q.toggleMcpServer(...args),
    setMcpServers: (...args) => q.setMcpServers(...args),
    rewindFiles: (...args) => q.rewindFiles(...args),

    close(): void {
      if (closed) return;
      closed = true;
      if (rejectNext) {
        const reject = rejectNext;
        resolveNext = null;
        rejectNext = null;
        reject(new Error('Session closed'));
      }
      if (!abortController.signal.aborted) {
        abortController.abort();
      }
      q.close();
    },

    async [Symbol.asyncDispose](): Promise<void> {
      this.close();
    },
  };
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function truncateText(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function buildPromptSessionMetadata(
  prompt: string,
  explicitTitle?: string,
): { title?: string; summary?: string; createdFromPrompt?: string } {
  const normalized = normalizeOptionalString(prompt);
  const normalizedTitle = normalizeOptionalString(explicitTitle);
  if (!normalized && !normalizedTitle) return {};

  return {
    ...(normalizedTitle
      ? { title: normalizedTitle }
      : normalized
        ? { title: truncateText(normalized.split('\n')[0].replace(/\s+/g, ' '), 80) }
        : {}),
    ...(normalized
      ? {
          summary: truncateText(normalized.replace(/\s+/g, ' '), 200),
          createdFromPrompt: truncateText(normalized, 4000),
        }
      : normalizedTitle
        ? { summary: normalizedTitle }
        : {}),
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

    interrupt: (...args) => q.interrupt(...args),
    setPermissionMode: (...args) => q.setPermissionMode(...args),
    setModel: (...args) => q.setModel(...args),
    setMaxThinkingTokens: (...args) => q.setMaxThinkingTokens(...args),
    supportedCommands: (...args) => q.supportedCommands(...args),
    supportedModels: (...args) => q.supportedModels(...args),
    supportedAgents: (...args) => q.supportedAgents(...args),
    supportedSkills: (...args) => q.supportedSkills(...args),
    readRuntimeControlPlane: (...args) => q.readRuntimeControlPlane(...args),
    listRuntimeDiagnostics: (...args) => q.listRuntimeDiagnostics(...args),
    readOrchestrationControlPlane: (...args) => q.readOrchestrationControlPlane(...args),
    mcpServerStatus: (...args) => q.mcpServerStatus(...args),
    accountInfo: (...args) => q.accountInfo(...args),
    initializationResult: (...args) => q.initializationResult(...args),
    sessionInfo: (...args) => q.sessionInfo(...args),
    listTeams: (...args) => q.listTeams(...args),
    getTeam: (...args) => q.getTeam(...args),
    createTeam: (...args) => q.createTeam(...args),
    deleteTeam: (...args) => q.deleteTeam(...args),
    getActiveTeam: (...args) => q.getActiveTeam(...args),
    setActiveTeam: (...args) => q.setActiveTeam(...args),
    sendTeamMessage: (...args) => q.sendTeamMessage(...args),
    readTeamInbox: (...args) => q.readTeamInbox(...args),
    acknowledgeTeamInbox: (...args) => q.acknowledgeTeamInbox(...args),
    listPendingTeamApprovals: (...args) => q.listPendingTeamApprovals(...args),
    respondToTeamApproval: (...args) => q.respondToTeamApproval(...args),
    getTeamInboxCount: (...args) => q.getTeamInboxCount(...args),
    readTimelineInbox: (...args) => q.readTimelineInbox(...args),
    subscribeOrchestrationEvents: (...args) => q.subscribeOrchestrationEvents(...args),
    subscribeTimeline: (...args) => q.subscribeTimeline(...args),
    executeFollowUp: (...args) => q.executeFollowUp(...args),
    listWorkers: (...args) => q.listWorkers(...args),
    getWorker: (...args) => q.getWorker(...args),
    getWorkerFollowUps: (...args) => q.getWorkerFollowUps(...args),
    launchWorker: (...args) => q.launchWorker(...args),
    launchVerifier: (...args) => q.launchVerifier(...args),
    resumeWorker: (...args) => q.resumeWorker(...args),
    stopWorker: (...args) => q.stopWorker(...args),
    listTasks: (...args) => q.listTasks(...args),
    getTask: (...args) => q.getTask(...args),
    createTask: (...args) => q.createTask(...args),
    updateTask: (...args) => q.updateTask(...args),
    claimNextTask: (...args) => q.claimNextTask(...args),
    heartbeatTask: (...args) => q.heartbeatTask(...args),
    releaseTask: (...args) => q.releaseTask(...args),
    dispatchNextTask: (...args) => q.dispatchNextTask(...args),
    startTaskDispatcher: (...args) => q.startTaskDispatcher(...args),
    resumeTaskDispatcher: (...args) => q.resumeTaskDispatcher(...args),
    getTaskDispatcher: (...args) => q.getTaskDispatcher(...args),
    listTaskDispatchers: (...args) => q.listTaskDispatchers(...args),
    inspectTaskDispatcherHealth: (...args) => q.inspectTaskDispatcherHealth(...args),
    getTaskDispatcherDiagnosis: (...args) => q.getTaskDispatcherDiagnosis(...args),
    listTaskDispatcherDiagnoses: (...args) => q.listTaskDispatcherDiagnoses(...args),
    requeueTaskDispatcherAssignment: (...args) => q.requeueTaskDispatcherAssignment(...args),
    stopTaskDispatcher: (...args) => q.stopTaskDispatcher(...args),
    listBackgroundTasks: (...args) => q.listBackgroundTasks(...args),
    getBackgroundTask: (...args) => q.getBackgroundTask(...args),
    stopTask: (...args) => q.stopTask(...args),
    streamInput: (...args) => q.streamInput(...args),
    reconnectMcpServer: (...args) => q.reconnectMcpServer(...args),
    toggleMcpServer: (...args) => q.toggleMcpServer(...args),
    setMcpServers: (...args) => q.setMcpServers(...args),
    rewindFiles: (...args) => q.rewindFiles(...args),

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
