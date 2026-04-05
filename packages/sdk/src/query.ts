import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import type {
  SDKMessage,
  SDKUserMessage,
  SlashCommand,
  AccountInfo,
  McpServerStatusConfig,
  AgentDefinition,
  HookEvent,
  SDKTaskNotificationMessage,
  SDKPromptSuggestionMessage,
} from '@open-agent/core';
import { ConversationLoop, SessionManager, buildSystemPrompt, FileCheckpoint, isGitRepository, buildTaskOrchestrationTemplates, loadPromptContext, buildCoordinatorContext, HOOK_EVENTS } from '@open-agent/core';
import {
  createStore,
  appendTimelineControlPlane,
  createDefaultAppState,
  setActiveTeamControlPlane,
  syncTeamInboxMemberControlPlane,
  syncMcpServerState,
  syncRuntimeControlPlane,
  syncSchedulerControlPlane,
  syncSessionControlPlane,
  syncToolRegistryState,
  upsertTaskControlPlane,
  upsertWorkerControlPlane,
  upsertDispatcherDiagnosisControlPlane,
  upsertDispatcherControlPlane,
} from '@open-agent/state';
import type { AppState } from '@open-agent/state';
import { AgentLoader, AgentExecutor, TeamManager, TaskManager } from '@open-agent/agents';
import type { AgentLoaderDiagnostic } from '@open-agent/agents';
import type { SubagentStreamEvent, AgentSession, TaskItem, TeamConfig, TeamInboxEntry, TeamMember, TeamMessage } from '@open-agent/agents';
import {
  createDefaultToolRegistry,
  createTaskTool,
  createTaskOutputTool,
  createTaskStopTool,
  createTaskCreateTool,
  createTaskUpdateTool,
  createTaskGetTool,
  createTaskListTool,
  createTeamCreateTool,
  createTeamDeleteTool,
  createSendMessageTool,
  createWorktree,
  cleanupWorktree,
  hasWorktreeChanges,
  getToolPromptDescriptions,
  listPersistedBackgroundTasks,
} from '@open-agent/tools';
import type { ToolDefinition, ToolCapabilityExportEntry } from '@open-agent/tools';
import { autoDetectProvider, createProvider, calculateCost } from '@open-agent/providers';
import type { Message, LLMProvider } from '@open-agent/providers';
import {
  PermissionEngine,
  SettingsLoader,
  BASH_SANDBOX_POLICY_FIELD,
  BASH_SANDBOX_BYPASS_APPROVED_FIELD,
  buildBashSandboxPolicy,
} from '@open-agent/permissions';
import type { SandboxConfig, SettingsFile, BashSandboxExecutionPolicy } from '@open-agent/permissions';
import { HookExecutor } from '@open-agent/hooks';
import { OpenAgentRuntime } from '@open-agent/runtime';
import type { RuntimeDiagnostic, RuntimeHookSummary, RuntimePluginSummary } from '@open-agent/runtime';
import { PluginLoader } from '@open-agent/plugins';
import type { CommandDefinition, HookConfig, LoadedPlugin, PluginManifest, SkillDefinition } from '@open-agent/plugins';
import type {
  QueryOptions,
  Query,
  RewindFilesResult,
  AgentInfo,
  BackgroundTaskInspection,
  ProviderCapabilityRecord,
  RuntimeControlPlaneSnapshot,
  RuntimeDiagnosticListOptions,
  RuntimeDiagnosticRecord,
  RuntimeToolMutationResult,
  RuntimeToolRemovalResult,
  OrchestrationControlPlaneSnapshot,
  OrchestrationControlPlaneOptions,
  SessionStateSnapshot,
  SubagentRecord,
  TaskListOptions,
  TaskCreateInput,
  TaskUpdateInput,
  TaskClaimOptions,
  TaskDispatchInput,
  TaskDispatchResult,
  TaskDispatcherListOptions,
  TaskDispatcherBlockReason,
  TaskDispatcherRecord,
  TaskDispatcherSchedulingState,
  TaskDispatcherHealthFinding,
  TaskDispatcherHealthSummary,
  TaskDispatcherHealthOptions,
  TaskDispatcherHealthReport,
  TaskDispatcherDiagnosisListOptions,
  TaskDispatcherRequeueInput,
  TaskDispatcherRequeueResult,
  TaskDispatcherStartInput,
  TaskDispatcherStopResult,
  TaskReleaseOptions,
  TaskRecord,
  WorkerListOptions,
  WorkerRecord,
  WorkerFollowUpSuggestion,
  WorkerLaunchInput,
  TeamRecord,
  TeamMessageRecord,
  TeamCreateInput,
  TeamMessageInput,
  TeamInboxOptions,
  TeamInboxAcknowledgeInput,
  TeamApprovalRecord,
  TeamApprovalListOptions,
  TeamApprovalResponseInput,
  TeamApprovalResponseResult,
  TimelineInboxOptions,
  SDKOrchestrationEvent,
  SubscribeOrchestrationEventsOptions,
  SDKTaskDispatcherEvent,
  SDKTimelineItem,
  SchedulerControlPlaneSnapshot,
  SchedulerQueueEntry,
  SubscribeTimelineOptions,
  FollowUpExecutable,
  FollowUpExecutionResult,
} from './types.js';
import { applyPermissionUpdates } from './permission-updates.js';
import { createPermissionPrompterBridge } from './permission-prompter.js';

// --------------------------------------------------------------------------
// query() – V1 streaming API
//
// Supports two call signatures:
//
//   1. query(prompt, options?)        — Claude Code style (primary)
//   2. query({ prompt, options })     — legacy object style (backwards-compat)
// --------------------------------------------------------------------------

/**
 * Run an agent conversation and return a `Query` handle that is both an
 * `AsyncGenerator<SDKMessage>` and exposes control methods.
 *
 * @example — simple string prompt (Claude Code style)
 * ```ts
 * const q = query('List files in the current directory');
 * for await (const msg of q) {
 *   if (msg.type === 'result') console.log(msg.result);
 * }
 * ```
 *
 * @example — with options
 * ```ts
 * const q = query('Refactor this file', { model: 'claude-opus-4-6', cwd: '/my/project' });
 * for await (const msg of q) { ... }
 * ```
 */
export function query(prompt: string, options?: QueryOptions): Query;
export function query(params: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: QueryOptions;
}): Query;
export function query(
  promptOrParams: string | { prompt: string | AsyncIterable<SDKUserMessage>; options?: QueryOptions },
  maybeOptions?: QueryOptions,
): Query {
  // Normalise the two call signatures into a single shape.
  let prompt: string | AsyncIterable<SDKUserMessage>;
  let options: QueryOptions;

  if (typeof promptOrParams === 'string') {
    prompt = promptOrParams;
    options = maybeOptions ?? {};
  } else {
    prompt = promptOrParams.prompt;
    options = promptOrParams.options ?? {};
  }

  const cwd = options.cwd ?? process.cwd();
  assertUnsupportedOptions(options);
  if (options.resume && options.continue) {
    throw new Error('options.resume and options.continue are mutually exclusive.');
  }
  if (options.sessionId !== undefined && !isValidUuid(options.sessionId)) {
    throw new Error('options.sessionId must be a valid UUID.');
  }
  if (options.resume !== undefined && !isValidUuid(options.resume)) {
    throw new Error('options.resume must be a valid UUID.');
  }
  if (options.maxTurns !== undefined && (!Number.isInteger(options.maxTurns) || options.maxTurns <= 0)) {
    throw new Error('options.maxTurns must be a positive integer.');
  }
  if (
    options.maxBudgetUsd !== undefined &&
    (!Number.isFinite(options.maxBudgetUsd) || options.maxBudgetUsd < 0)
  ) {
    throw new Error('options.maxBudgetUsd must be a finite number >= 0.');
  }
  if (options.resumeSessionAt !== undefined && options.resume === undefined) {
    throw new Error('options.resumeSessionAt requires options.resume.');
  }
  if (
    options.sessionId &&
    !options.forkSession &&
    (options.resume !== undefined || options.continue === true)
  ) {
    throw new Error('options.sessionId cannot be combined with options.resume/options.continue unless forkSession=true.');
  }
  const resumeManager = new SessionManager();
  const effectiveResumeSessionId =
    options.resume ??
    (options.continue ? resumeManager.getLatestSession(cwd)?.id : undefined);
  if (options.resume && !resumeManager.getSession(cwd, options.resume)) {
    throw new Error(`Session not found for resume: ${options.resume}`);
  }
  const sessionId = options.forkSession
    ? randomUUID()
    : (options.sessionId ?? effectiveResumeSessionId ?? randomUUID());
  const settingSources = options.settingSources ?? [];
  const loadedSettings: SettingsFile | null = settingSources.length > 0
    ? new SettingsLoader().load(cwd, settingSources)
    : null;
  const shouldPersist = options.persistSession !== false;
  const sharedSessionManager = options.sessionManager ?? null;
  const pluginRuntime = loadConfiguredPlugins(cwd, options.plugins);
  const agentRuntime = loadAvailableAgents(cwd, {
    ...pluginRuntime.agents,
    ...(options.agents ?? {}),
  });
  const runtimeDiagnostics = [...pluginRuntime.diagnostics, ...agentRuntime.diagnostics];
  const availableAgents = agentRuntime.availableAgents;
  const selectedAgent = resolveSelectedAgent(options.agent, availableAgents);
  const supportedAgentInfos = buildAgentInfoList(availableAgents);
  const selectedAgentModel = resolveAgentModel(selectedAgent?.model);
  const requestedModelHint = options.model ?? selectedAgentModel;
  const outputStyle = options.outputStyle ?? 'text';
  const responseLanguage = normalizeOptionalString(options.language);
  const isGitRepo = isGitRepository(cwd);
  const sessionExistedBeforeQuery = (shouldPersist || sharedSessionManager !== null)
    ? resumeManager.getSession(cwd, sessionId) !== null
    : false;

  // Queue for best-effort streamInput support in async-iterable prompt mode.
  const queuedInputs: SDKUserMessage[] = [];
  const STREAM_DONE = Symbol('stream-done');
  let queueNotifier: (() => void) | null = null;
  let sourceExhausted = false;  // The original AsyncIterable prompt has ended.
  let inputClosed = false;       // The query is truly closed — no more input accepted.
  let sourcePumpStarted = false;
  let sourcePumpError: Error | null = null;

  function notifyQueue(): void {
    if (queueNotifier) {
      const notify = queueNotifier;
      queueNotifier = null;
      notify();
    }
  }

  function pushQueuedInput(msg: SDKUserMessage): void {
    if (inputClosed) return;
    queuedInputs.push(msg);
    sessionLastActivityAt = new Date().toISOString();
    notifyQueue();
  }

  async function readQueuedInput(): Promise<SDKUserMessage | typeof STREAM_DONE> {
    while (!inputClosed && queuedInputs.length === 0 && !sourcePumpError) {
      await new Promise<void>((resolve) => {
        queueNotifier = resolve;
      });
    }
    if (queuedInputs.length > 0) {
      sessionLastActivityAt = new Date().toISOString();
      return queuedInputs.shift()!;
    }
    if (sourcePumpError) {
      const error = sourcePumpError;
      sourcePumpError = null;
      throw error;
    }
    return STREAM_DONE;
  }

  function startSourcePromptPumpIfNeeded(): void {
    if (typeof prompt === 'string' || sourcePumpStarted) return;
    sourcePumpStarted = true;
    const source = prompt;
    void (async () => {
      try {
        for await (const msg of source) {
          pushQueuedInput(msg);
        }
      } catch (error) {
        sourcePumpError = error instanceof Error ? error : new Error(String(error));
        touchSessionState({
          status: 'failed',
          activeTurn: false,
          lastError: sourcePumpError.message,
        });
      } finally {
        sourceExhausted = true;
        // When idleOnPromptExhaustion is enabled, keep accepting input via
        // streamInput() even after the original source is exhausted.
        if (!options.idleOnPromptExhaustion) {
          inputClosed = true;
        }
        notifyQueue();
      }
    })();
  }

  // ------------------------------------------------------------------
  // Env — apply caller-supplied environment overrides BEFORE provider
  // resolution so that OPENAI_API_KEY, ANTHROPIC_API_KEY etc. are
  // visible to autoDetectProvider() / createProvider().
  // ------------------------------------------------------------------
  const savedEnv: Record<string, string | undefined> = {};
  if (options.env) {
    for (const [key, value] of Object.entries(options.env)) {
      savedEnv[key] = process.env[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }

  // Apply debug env before provider creation too.
  // Append rather than replace so the user's existing DEBUG patterns are preserved.
  if (options.debug) {
    savedEnv['DEBUG'] ??= process.env['DEBUG'];
    const existing = process.env['DEBUG'];
    process.env['DEBUG'] = existing ? `${existing},open-agent:*` : 'open-agent:*';
  }

  // Helper to restore env vars if setup throws before the generator's finally block runs.
  let envRestored = false;
  function restoreEnv(): void {
    if (envRestored) return;
    envRestored = true;
    for (const [key, original] of Object.entries(savedEnv)) {
      if (original === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original;
      }
    }
  }

  // ------------------------------------------------------------------
  // Provider resolution
  // ------------------------------------------------------------------
  // If the caller explicitly specifies a provider, use it directly.
  // Otherwise fall back to model-name heuristics → environment auto-detect.
  let provider: LLMProvider;
  try {
    provider = typeof options.provider === 'object' && options.provider !== null
      ? options.provider
      : options.provider
        ? createProvider({ provider: options.provider, apiKey: options.apiKey, baseURL: options.baseUrl })
        : (() => {
            const providerName = guessProviderFromModel(requestedModelHint);
            return providerName
              ? createProvider({ provider: providerName, apiKey: options.apiKey, baseURL: options.baseUrl })
              : autoDetectProvider();
          })();
  } catch (err) {
    restoreEnv();
    throw err;
  }

  const apiKeySource: string = options.apiKey
    ? 'direct'
    : (options.env && Object.keys(options.env).some(k => k.includes('API_KEY')))
      ? 'env_override'
      : (process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY)
        ? 'env'
        : 'auto';

  // ------------------------------------------------------------------
  // Tool registry — use public unregister() API, never touch internals.
  // ------------------------------------------------------------------
  const toolRegistry = createDefaultToolRegistry(cwd);
  let baseTools = new Map(toolRegistry.list().map((tool) => [tool.name, tool]));
  const runtime = new OpenAgentRuntime({
    cwd,
    toolRegistry,
    availableAgents,
    skillDirectories: options.skillDirectories,
    includePluginSkills: options.includePluginSkills,
    plugins: pluginRuntime.plugins,
    hooks: pluginRuntime.hooks,
    diagnostics: runtimeDiagnostics,
    mcp: {
      shouldRegisterTool: (toolName) => isToolAllowedByPolicy(toolName),
      restoreTool: (toolName) => baseTools.get(toolName),
    },
  });
  const runtimeReadyPromise = runtime.initialize().then(() => {
    registerConfiguredPluginSkills(
      runtime,
      pluginRuntime.loadedPlugins,
      options.includePluginSkills,
    );
  });
  void runtimeReadyPromise.catch(() => {});
  runtime.registerSkillTool();
  runtime.registerMcpResourceTools();

  // Allow caller to inject additional tools (e.g. Task, Team, Skill)
  // before any filtering is applied.
  let setupToolsReady: Promise<void> | undefined;
  if (options.setupTools) {
    const result = options.setupTools(toolRegistry);
    if (result && typeof (result as Promise<void>).then === 'function') {
      setupToolsReady = result as Promise<void>;
      void setupToolsReady.catch(() => {});
    }
  }

  runtime.registerToolSearchTool();

  const pendingSubagentMessages: SDKMessage[] = [];
  const orchestrationSubscribers = new Set<{
    push: (event: SDKOrchestrationEvent) => void;
    close: () => void;
  }>();
  let currentTurnObservation: PromptSuggestionObservation = createPromptSuggestionObservation();
  const enqueueSubagentMessages = (
    parentToolUseId: string,
    event: SubagentStreamEvent,
  ): void => {
    pendingSubagentMessages.push(
      ...convertSubagentEventToSdkMessages(parentToolUseId, sessionId, event),
    );
    currentTurnObservation.sawTask = true;
    currentTurnObservation.sawSubagent = true;
    if (options.onSubagentEvent) {
      options.onSubagentEvent(parentToolUseId, event);
    }
    const orchestrationEvent = convertSubagentEventToOrchestrationEvent(parentToolUseId, sessionId, event);
    if (orchestrationEvent) {
      appendOrchestrationTimelineStoreItem(orchestrationEvent);
      handleTaskDispatcherOrchestrationEvent(orchestrationEvent);
      for (const subscriber of orchestrationSubscribers) {
        subscriber.push(orchestrationEvent);
      }
    }
  };

  async function* flushPendingSubagentMessages(): AsyncGenerator<SDKMessage, void> {
    while (pendingSubagentMessages.length > 0) {
      yield pendingSubagentMessages.shift()!;
    }
  }

  const defaultTeamName = 'default';
  const sdkTeamManager = new TeamManager();
  let activeTeamName: string | null = null;
  const resolveTaskTeamName = (teamName?: string) => teamName ?? activeTeamName ?? defaultTeamName;
  const resolveWorkerTeamName = (teamName?: string) => normalizeOptionalString(teamName) ?? activeTeamName ?? undefined;
  const getTaskManager = (teamName?: string) => new TaskManager(resolveTaskTeamName(teamName), {
    rootDir: join(cwd, '.open-agent', 'tasks'),
  });
  const resolveTeamName = (teamName?: string) => normalizeOptionalString(teamName) ?? activeTeamName ?? defaultTeamName;
  const toTeamMemberRecord = (member: TeamMember): TeamRecord['members'][number] => ({
    name: member.name,
    agentId: member.agentId,
    agentType: member.agentType,
    ...(member.model ? { model: member.model } : {}),
    status: member.status,
  });
  const toTeamRecord = (config: TeamConfig): TeamRecord => ({
    name: config.name,
    ...(config.description ? { description: config.description } : {}),
    members: config.members.map((member) => toTeamMemberRecord(member)),
    createdAt: config.createdAt,
    configPath: join(sdkTeamManager.getTeamDir(config.name), 'config.json'),
    scratchpadPath: sdkTeamManager.getScratchpadDir(config.name),
    inboxesPath: join(sdkTeamManager.getTeamDir(config.name), 'inboxes'),
    taskQueuePath: join(cwd, '.open-agent', 'tasks', config.name),
    isActive: activeTeamName === config.name,
  });
  const toTeamMessageRecord = (teamName: string, message: TeamMessage, entry?: TeamInboxEntry): TeamMessageRecord => ({
    ...(entry?.id ? { messageId: entry.id } : {}),
    teamName,
    type: message.type,
    from: message.from,
    ...(message.to ? { to: message.to } : {}),
    content: message.content,
    ...(message.summary ? { summary: message.summary } : {}),
    timestamp: message.timestamp,
    ...(entry?.readAt ? { readAt: entry.readAt } : {}),
    ...(message.requestId ? { requestId: message.requestId } : {}),
    ...(typeof message.approve === 'boolean' ? { approve: message.approve } : {}),
    ...(message.idleReason ? { idleReason: message.idleReason } : {}),
    ...(message.routing ? { routing: JSON.parse(JSON.stringify(message.routing)) } : {}),
  });
  const resolveTeamMessageSyncTargets = (teamName: string, message: TeamMessage): string[] => {
    if (message.type === 'broadcast') {
      const members = sdkTeamManager.getMembers(teamName);
      return members.length > 0 ? members.map((member) => member.name) : ['broadcast'];
    }
    if (message.type === 'idle_notification') {
      const members = sdkTeamManager.getMembers(teamName);
      const lead = members.find((member) => member.name === 'lead') ?? members[0];
      return [lead?.name ?? 'lead'];
    }
    return [message.to ?? 'unknown'];
  };
  const syncTeamInboxMemberSnapshot = (teamName: string, memberName: string): TeamMessageRecord[] => {
    const entries = sdkTeamManager.readInboxEntries(teamName, memberName, { consume: false });
    const records = entries.map((entry) => toTeamMessageRecord(teamName, entry.message, entry));
    appStore.setState((prev) => syncTeamInboxMemberControlPlane(prev, {
      teamName,
      memberName,
      updatedAt: new Date().toISOString(),
      messages: records.map((record) => ({
        messageId: record.messageId ?? buildTimelineTeamMessageFingerprint(record),
        type: record.type,
        from: record.from,
        ...(record.to ? { to: record.to } : {}),
        content: record.content,
        ...(record.summary ? { summary: record.summary } : {}),
        timestamp: record.timestamp,
        ...(record.requestId ? { requestId: record.requestId } : {}),
        ...(typeof record.approve === 'boolean' ? { approve: record.approve } : {}),
        ...(record.readAt ? { readAt: record.readAt } : {}),
      })),
    }));
    appendTimelineStoreItems(records.map((entry) => toTimelineTeamMessage(entry)));
    return records;
  };
  const findMatchingSyncedTeamMessage = (
    records: TeamMessageRecord[],
    message: TeamMessage,
  ): TeamMessageRecord | null => {
    for (let index = records.length - 1; index >= 0; index -= 1) {
      const record = records[index]!;
      if (record.type !== message.type) continue;
      if (record.from !== message.from) continue;
      if ((record.to ?? '') !== (message.to ?? '')) continue;
      if (record.timestamp !== message.timestamp) continue;
      if (record.content !== message.content) continue;
      if ((record.summary ?? '') !== (message.summary ?? '')) continue;
      if ((record.requestId ?? '') !== (message.requestId ?? '')) continue;
      return record;
    }
    return null;
  };
  const readTeamInboxFromStore = (
    teamName: string,
    memberName: string,
    options: {
      unreadOnly?: boolean;
      after?: string;
      limit?: number;
    } = {},
  ): TeamMessageRecord[] => {
    const snapshot = appStore.getState().inboxes[teamName]?.[memberName];
    if (!snapshot) {
      return [];
    }
    return snapshot.messages
      .filter((message) => !options.unreadOnly || !message.readAt)
      .filter((message) => !options.after || message.messageId > options.after)
      .slice(0, options.limit ?? Number.POSITIVE_INFINITY)
      .map((message) => ({
        messageId: message.messageId,
        teamName,
        type: message.type as TeamMessageRecord['type'],
        from: message.from,
        ...(message.to ? { to: message.to } : {}),
        content: message.content,
        ...(message.summary ? { summary: message.summary } : {}),
        timestamp: message.timestamp,
        ...(message.readAt ? { readAt: message.readAt } : {}),
        ...(message.requestId ? { requestId: message.requestId } : {}),
        ...(typeof message.approve === 'boolean' ? { approve: message.approve } : {}),
      }));
  };
  const isTeamApprovalRequestType = (type: TeamMessage['type']): type is TeamApprovalRecord['requestType'] =>
    type === 'shutdown_request' || type === 'plan_approval_request';
  const toTeamApprovalRecord = (
    teamName: string,
    memberName: string,
    entry: TeamInboxEntry,
  ): TeamApprovalRecord | null => {
    if (!isTeamApprovalRequestType(entry.message.type) || !entry.message.requestId) {
      return null;
    }
    return {
      ...(entry.id ? { messageId: entry.id } : {}),
      teamName,
      memberName,
      requestType: entry.message.type,
      requestId: entry.message.requestId,
      from: entry.message.from,
      ...(entry.message.to ? { to: entry.message.to } : {}),
      content: entry.message.content,
      ...(entry.message.summary ? { summary: entry.message.summary } : {}),
      timestamp: entry.message.timestamp,
      ...(entry.readAt ? { readAt: entry.readAt } : {}),
    };
  };
  const getTeamApprovalResponseType = (
    requestType: TeamApprovalRecord['requestType'],
  ): TeamMessageRecord['type'] => (
    requestType === 'shutdown_request' ? 'shutdown_response' : 'plan_approval_response'
  );
  const toTimelineTeamMessage = (message: TeamMessageRecord): SDKTimelineItem => ({
    kind: 'team_message',
    ...(message.messageId ? { timelineId: message.messageId, cursor: message.messageId } : {}),
    sessionId,
    timestamp: message.timestamp,
    teamName: message.teamName,
    ...(message.readAt ? { readAt: message.readAt } : {}),
    teamMessage: JSON.parse(JSON.stringify(message)),
  });
  const toTimelineOrchestrationItem = (event: SDKOrchestrationEvent): SDKTimelineItem => {
    const timestamp = extractTimelineTimestamp(event);
    return {
      kind: event.kind,
      sessionId: event.sessionId,
      timestamp,
      ...(event.teamName ? { teamName: event.teamName } : {}),
      ...(event.workerId ? { workerId: event.workerId } : {}),
      ...(event.dispatcherId ? { timelineId: `dispatcher:${event.dispatcherId}:${timestamp}`, cursor: `dispatcher:${event.dispatcherId}:${timestamp}` } : {}),
      ...(event.kind === 'worker_lifecycle' && event.workerId
        ? {
            timelineId: `worker:${event.workerId}:${event.lifecycle ?? 'event'}:${timestamp}`,
            cursor: `worker:${event.workerId}:${event.lifecycle ?? 'event'}:${timestamp}`,
          }
        : {}),
      ...(event.parentToolCallId ? { parentToolCallId: event.parentToolCallId } : {}),
      orchestrationEvent: cloneOrchestrationEvent(event),
    };
  };
  const toTimelineTaskNotification = (message: SDKTaskNotificationMessage): SDKTimelineItem => ({
    kind: 'task_notification',
    ...(buildTaskNotificationFingerprint(message) ? { timelineId: buildTaskNotificationFingerprint(message)!, cursor: buildTaskNotificationFingerprint(message)! } : {}),
    sessionId: message.session_id,
    timestamp: message.completed_at ?? new Date().toISOString(),
    ...(message.team_name ? { teamName: message.team_name } : {}),
    workerId: message.task_id,
    ...(message.tool_use_id ? { parentToolCallId: message.tool_use_id } : {}),
    taskNotification: buildTimelineTaskNotificationRecord(message, responseLanguage),
  });
  const toTaskRecord = (task: TaskItem, teamName: string): TaskRecord => ({
    id: task.id,
    subject: task.subject,
    description: task.description,
    status: task.status,
    ...(task.owner ? { owner: task.owner } : {}),
    ...(typeof task.priority === 'number' ? { priority: task.priority } : {}),
    ...(task.activeForm ? { activeForm: task.activeForm } : {}),
    blocks: [...(task.blocks ?? [])],
    blockedBy: [...(task.blockedBy ?? [])],
    ...(task.lease
      ? {
          lease: {
            owner: task.lease.owner,
            claimedAt: task.lease.claimedAt,
            expiresAt: task.lease.expiresAt,
            attempts: task.lease.attempts,
          },
        }
      : {}),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    ...(task.metadata ? { metadata: JSON.parse(JSON.stringify(task.metadata)) } : {}),
    teamName,
  });
  const buildTaskDispatchPrompt = (task: TaskItem): string => {
    const subject = normalizeOptionalString(task.subject);
    const activeForm = normalizeOptionalString(task.activeForm);
    const description = normalizeOptionalString(task.description);
    const lines = [
      subject ? `Task: ${subject}` : undefined,
      activeForm ? `Active form: ${activeForm}` : undefined,
      description && description !== subject ? description : undefined,
    ].filter((line): line is string => Boolean(line));
    return lines.join('\n\n') || 'Work on the claimed task.';
  };
  const DEFAULT_TASK_DISPATCHER_POLL_INTERVAL_MS = 250;
  const DEFAULT_TASK_LEASE_MS = 5 * 60 * 1000;
  const globalDispatcherWorkerBudget = options.globalDispatcherWorkerBudget !== undefined
    ? Math.max(1, Math.trunc(options.globalDispatcherWorkerBudget))
    : null;
  const teamDispatcherWorkerBudgets = Object.fromEntries(
    Object.entries(options.teamDispatcherWorkerBudgets ?? {})
      .map(([teamName, budget]) => [normalizeOptionalString(teamName), Math.max(1, Math.trunc(budget))] as const)
      .filter((entry): entry is [string, number] => Boolean(entry[0]) && Number.isFinite(entry[1])),
  );
  let reservedDispatcherWorkerSlots = 0;
  const reservedDispatcherWorkerSlotsByTeam = new Map<string, number>();
  let dispatcherFairnessCursor: string | null = null;

  interface TaskDispatcherAssignment {
    taskId: string;
    workerId: string;
    claimedAt?: string;
    lastHeartbeatAt?: string;
    leaseExpiresAt?: string;
    attempts?: number;
  }

  interface TaskDispatcherState {
    record: TaskDispatcherRecord;
    prompt?: string;
    name?: string;
    model?: string;
    maxTurns?: number;
    mode?: string;
    cwd?: string;
    isolation?: 'worktree';
    timer: ReturnType<typeof setTimeout> | null;
    running: boolean;
    rerunRequested: boolean;
    disposed: boolean;
    activeAssignments: Map<string, TaskDispatcherAssignment>;
  }

  interface TaskDispatcherOwnershipRecord {
    dispatcherId: string;
    queryInstanceId: string;
    sessionId: string;
    claimedAt: string;
    heartbeatAt: string;
  }

  interface TaskSchedulerOwnershipRecord {
    queryInstanceId: string;
    sessionId: string;
    claimedAt: string;
    heartbeatAt: string;
  }

  const cloneTaskDispatcherRecord = (record: TaskDispatcherRecord): TaskDispatcherRecord => {
    const cloned = JSON.parse(JSON.stringify(record)) as TaskDispatcherRecord;
    if (!cloned.schedulerState) {
      cloned.schedulerState = cloned.status === 'draining'
        ? 'draining'
        : cloned.status === 'stopped'
          ? 'stopped'
          : 'idle';
    }
    return cloned;
  };
  const queryInstanceId = randomUUID();
  const countActiveDispatcherAssignments = (): number => {
    let total = 0;
    for (const state of taskDispatchers.values()) {
      if (state.disposed || state.record.status === 'stopped') continue;
      total += state.activeAssignments.size;
    }
    return total;
  };
  const countActiveDispatcherAssignmentsForTeam = (teamName: string): number => {
    let total = 0;
    for (const state of taskDispatchers.values()) {
      if (state.disposed || state.record.status === 'stopped' || state.record.teamName !== teamName) continue;
      total += state.activeAssignments.size;
    }
    return total;
  };
  const getConfiguredTeamDispatcherWorkerBudget = (teamName: string): number | null => (
    teamDispatcherWorkerBudgets[teamName] ?? null
  );
  const getAvailableDispatcherWorkerBudget = (): number | null => {
    if (globalDispatcherWorkerBudget === null) {
      return null;
    }
    return Math.max(0, globalDispatcherWorkerBudget - countActiveDispatcherAssignments() - reservedDispatcherWorkerSlots);
  };
  const getAvailableDispatcherWorkerBudgetForTeam = (teamName: string): number | null => {
    const teamBudget = getConfiguredTeamDispatcherWorkerBudget(teamName);
    if (teamBudget === null) {
      return null;
    }
    return Math.max(
      0,
      teamBudget
      - countActiveDispatcherAssignmentsForTeam(teamName)
      - (reservedDispatcherWorkerSlotsByTeam.get(teamName) ?? 0),
    );
  };
  const tryReserveDispatcherWorkerSlot = (teamName: string): boolean => {
    if (globalDispatcherWorkerBudget === null) {
      const teamAvailable = getAvailableDispatcherWorkerBudgetForTeam(teamName);
      if (teamAvailable !== null && teamAvailable <= 0) {
        return false;
      }
    } else {
      const available = getAvailableDispatcherWorkerBudget();
      if (available === null || available <= 0) {
        return false;
      }
    }
    const teamAvailable = getAvailableDispatcherWorkerBudgetForTeam(teamName);
    if (teamAvailable !== null && teamAvailable <= 0) {
      return false;
    }
    reservedDispatcherWorkerSlots += 1;
    reservedDispatcherWorkerSlotsByTeam.set(teamName, (reservedDispatcherWorkerSlotsByTeam.get(teamName) ?? 0) + 1);
    return true;
  };
  const releaseReservedDispatcherWorkerSlot = (teamName: string): void => {
    if (reservedDispatcherWorkerSlots > 0) {
      reservedDispatcherWorkerSlots -= 1;
    }
    const reservedForTeam = reservedDispatcherWorkerSlotsByTeam.get(teamName) ?? 0;
    if (reservedForTeam <= 1) {
      reservedDispatcherWorkerSlotsByTeam.delete(teamName);
    } else {
      reservedDispatcherWorkerSlotsByTeam.set(teamName, reservedForTeam - 1);
    }
  };
  const countSchedulableDispatchers = (): number => {
    let total = 0;
    for (const state of taskDispatchers.values()) {
      if (!canDispatcherAcceptNewWork(state)) continue;
      total += 1;
    }
    return total;
  };
  const canDispatcherAcceptNewWork = (state: TaskDispatcherState): boolean => (
    !state.disposed
    && state.record.status === 'running'
    && state.activeAssignments.size < state.record.maxConcurrentWorkers
    && (getAvailableDispatcherWorkerBudgetForTeam(state.record.teamName) ?? 1) > 0
  );
  const listFairDispatchers = (): TaskDispatcherState[] => (
    [...taskDispatchers.values()]
      .filter((state) => canDispatcherAcceptNewWork(state))
      .sort((left, right) =>
        left.record.startedAt.localeCompare(right.record.startedAt)
        || left.record.dispatcherId.localeCompare(right.record.dispatcherId))
  );
  const pickFairDispatcher = (): TaskDispatcherState | null => {
    const eligible = listFairDispatchers();
    if (eligible.length === 0) return null;
    if (eligible.length === 1) return eligible[0] ?? null;
    if (!dispatcherFairnessCursor) return eligible[0] ?? null;
    const cursorIndex = eligible.findIndex((state) => state.record.dispatcherId === dispatcherFairnessCursor);
    if (cursorIndex < 0) return eligible[0] ?? null;
    return eligible[(cursorIndex + 1) % eligible.length] ?? eligible[0] ?? null;
  };
  const isDispatcherFairnessTurn = (state: TaskDispatcherState): boolean => {
    if (globalDispatcherWorkerBudget === null) {
      return true;
    }
    const next = pickFairDispatcher();
    return !next || next.record.dispatcherId === state.record.dispatcherId;
  };
  const noteDispatcherFairnessDispatch = (state: TaskDispatcherState): void => {
    dispatcherFairnessCursor = state.record.dispatcherId;
  };
  const wakeFairDispatchers = (): void => {
    if (!refreshTaskSchedulerOwnership()) {
      syncAppSchedulerControlPlane();
      return;
    }
    for (const dispatcher of listFairDispatchers()) {
      scheduleTaskDispatcherRun(dispatcher, 0);
    }
    syncAppSchedulerControlPlane();
  };
  const clearDispatcherFairnessCursorIfNeeded = (dispatcherId: string): void => {
    if (dispatcherFairnessCursor === dispatcherId) {
      dispatcherFairnessCursor = null;
    }
  };
  const buildSchedulerQueueEntries = (): SchedulerQueueEntry[] => {
    const eligible = listFairDispatchers();
    const nextTurnDispatcherId = pickFairDispatcher()?.record.dispatcherId ?? null;
    return eligible.map((state) => ({
      dispatcherId: state.record.dispatcherId,
      teamName: state.record.teamName,
      status: state.record.status,
      schedulerState: state.record.schedulerState,
      activeAssignments: state.activeAssignments.size,
      maxConcurrentWorkers: state.record.maxConcurrentWorkers,
      startedAt: state.record.startedAt,
      updatedAt: state.record.updatedAt,
      ...(state.record.lastBlockedReason ? { lastBlockedReason: state.record.lastBlockedReason } : {}),
      ...(state.record.lastBlockedAt ? { lastBlockedAt: state.record.lastBlockedAt } : {}),
      nextTurn: nextTurnDispatcherId === state.record.dispatcherId,
    }));
  };
  const buildSchedulerControlPlaneSnapshot = (): SchedulerControlPlaneSnapshot => {
    const ownership = readTaskSchedulerOwnershipRecord();
    return {
      ownerQueryInstanceId: ownership?.queryInstanceId ?? null,
      ownerSessionId: sessionId,
      ownerScope: ownership
        ? ownership.queryInstanceId === queryInstanceId
          ? 'local'
          : 'remote'
        : 'unowned',
      ...(ownership?.claimedAt ? { claimedAt: ownership.claimedAt } : {}),
      ...(ownership?.heartbeatAt ? { heartbeatAt: ownership.heartbeatAt } : {}),
      fairnessCursor: dispatcherFairnessCursor,
      updatedAt: new Date().toISOString(),
      queue: buildSchedulerQueueEntries(),
    };
  };
  const touchTaskDispatcherRecord = (state: TaskDispatcherState, timestamp = new Date().toISOString()): void => {
    state.record.updatedAt = timestamp;
  };
  const setTaskDispatcherSchedulerState = (
    state: TaskDispatcherState,
    schedulerState: TaskDispatcherSchedulingState,
    blockReason?: TaskDispatcherBlockReason,
  ): boolean => {
    let changed = false;
    if (state.record.schedulerState !== schedulerState) {
      touchTaskDispatcherRecord(state);
      state.record.schedulerState = schedulerState;
      changed = true;
    }
    if (blockReason) {
      const timestamp = new Date().toISOString();
      state.record.lastBlockedReason = blockReason;
      state.record.lastBlockedAt = timestamp;
      state.record.updatedAt = timestamp;
      changed = true;
    }
    return changed;
  };

  const toWorkerRecord = (session: AgentSession): WorkerRecord => ({
    workerId: session.agentId,
    workerType: session.agentType,
    ...(session.name ? { name: session.name } : {}),
    status: session.state,
    ...(session.parentToolUseId ? { parentToolCallId: session.parentToolUseId } : {}),
    ...(session.parentSessionId ? { parentSessionId: session.parentSessionId } : {}),
    ...(session.teamName ? { teamName: session.teamName } : {}),
    model: session.model,
    ...(session.mode ? { mode: session.mode } : {}),
    startedAt: session.startedAt,
    ...(session.completedAt ? { completedAt: session.completedAt } : {}),
    ...(session.outputFile ? { outputFile: session.outputFile } : {}),
    ...(session.worktreePath ? { worktreePath: session.worktreePath } : {}),
    ...(session.worktreeBranch ? { worktreeBranch: session.worktreeBranch } : {}),
    numTurns: session.numTurns,
    durationMs: session.durationMs,
    ...(typeof session.totalToolUseCount === 'number' ? { totalToolUseCount: session.totalToolUseCount } : {}),
    ...(typeof session.totalTokens === 'number' ? { totalTokens: session.totalTokens } : {}),
    summary: summarizePlainText(session.result ?? session.error ?? session.name ?? session.agentType),
    ...(session.result ? { result: session.result } : {}),
    ...(session.error ? { error: session.error } : {}),
  });

  const taskToolsDeps = {
    createTask: async (params: {
      subject: string;
      description: string;
      activeForm?: string;
      metadata?: Record<string, unknown>;
      priority?: number;
    }) => {
      const item = getTaskManager().create(
        params.subject,
        params.description,
        params.activeForm,
        params.metadata,
        params.priority,
      );
      return { id: item.id, subject: item.subject };
    },
    updateTask: async (params: { taskId: string; [key: string]: unknown }) => {
      getTaskManager().update(params.taskId, params as any);
      return { success: true };
    },
    getTask: async (taskId: string) => getTaskManager().get(taskId),
    listTasks: async () => getTaskManager().listAll(),
  };

  if (!toolRegistry.get('TaskCreate')) {
    toolRegistry.register(createTaskCreateTool(taskToolsDeps));
  }

  if (!toolRegistry.get('TaskUpdate')) {
    toolRegistry.register(createTaskUpdateTool(taskToolsDeps));
  }

  if (!toolRegistry.get('TaskGet')) {
    toolRegistry.register(createTaskGetTool(taskToolsDeps));
  }

  if (!toolRegistry.get('TaskList')) {
    toolRegistry.register(createTaskListTool(taskToolsDeps));
  }

  if (!toolRegistry.get('TeamCreate')) {
    toolRegistry.register(createTeamCreateTool({
      createTeam: async (name: string, description?: string) => {
        sdkTeamManager.createTeam(name, description);
        activeTeamName = name;
        return {
          teamName: name,
          configPath: join(homedir(), '.open-agent', 'teams', name, 'config.json'),
          scratchpadPath: sdkTeamManager.getScratchpadDir(name),
        };
      },
      deleteTeam: async (name: string) => {
        sdkTeamManager.deleteTeam(name);
        if (activeTeamName === name) {
          activeTeamName = null;
        }
        return { success: true };
      },
      getActiveTeam: () => activeTeamName ?? defaultTeamName,
      sendMessage: async ({ type, recipient, content, summary, approve, request_id }) => {
        const activeTeam = activeTeamName ?? defaultTeamName;
        sdkTeamManager.sendMessage(activeTeam, {
          type,
          from: 'sdk',
          to: recipient,
          content: content ?? '',
          summary,
          timestamp: new Date().toISOString(),
          requestId: request_id,
          approve,
        });

        return {
          success: true,
          message: 'Message sent',
          routing: {
            sender: 'sdk',
            target: type === 'broadcast' ? '@all' : (recipient ?? 'unknown'),
            summary: summary ?? content?.slice(0, 60),
            content,
          },
        };
      },
    }));
  }

  if (!toolRegistry.get('TeamDelete')) {
    toolRegistry.register(createTeamDeleteTool({
      createTeam: async (name: string, description?: string) => {
        sdkTeamManager.createTeam(name, description);
        return {
          teamName: name,
          configPath: join(homedir(), '.open-agent', 'teams', name, 'config.json'),
          scratchpadPath: sdkTeamManager.getScratchpadDir(name),
        };
      },
      deleteTeam: async (name: string) => {
        sdkTeamManager.deleteTeam(name);
        if (activeTeamName === name) {
          activeTeamName = null;
        }
        return { success: true };
      },
      getActiveTeam: () => activeTeamName ?? defaultTeamName,
      sendMessage: async () => ({ success: true, message: 'Message sent' }),
    }));
  }

  if (!toolRegistry.get('SendMessage')) {
    toolRegistry.register(createSendMessageTool({
      createTeam: async (name: string, description?: string) => {
        sdkTeamManager.createTeam(name, description);
        activeTeamName = name;
        return {
          teamName: name,
          configPath: join(homedir(), '.open-agent', 'teams', name, 'config.json'),
          scratchpadPath: sdkTeamManager.getScratchpadDir(name),
        };
      },
      deleteTeam: async (name: string) => {
        sdkTeamManager.deleteTeam(name);
        if (activeTeamName === name) {
          activeTeamName = null;
        }
        return { success: true };
      },
      getActiveTeam: () => activeTeamName ?? defaultTeamName,
      sendMessage: async ({ type, recipient, content, summary, approve, request_id }) => {
        const activeTeam = activeTeamName ?? defaultTeamName;
        sdkTeamManager.sendMessage(activeTeam, {
          type,
          from: 'sdk',
          to: recipient,
          content: content ?? '',
          summary,
          timestamp: new Date().toISOString(),
          requestId: request_id,
          approve,
        });

        return {
          success: true,
          message: 'Message sent',
          routing: {
            sender: 'sdk',
            target: type === 'broadcast' ? '@all' : (recipient ?? 'unknown'),
            summary: summary ?? content?.slice(0, 60),
            content,
          },
        };
      },
    }));
  }

  // ------------------------------------------------------------------
  // Subagent auto-wiring — register Task, TaskOutput, TaskStop tools
  // when not already provided via setupTools.  The AgentExecutor
  // instance is created later (after hooks) and captured via closure.
  // ------------------------------------------------------------------
  let sdkAgentExecutor: AgentExecutor | undefined;
  const taskDispatchers = new Map<string, TaskDispatcherState>();
  const taskDispatcherByWorkerId = new Map<string, { dispatcherId: string; taskId: string }>();
  let taskDispatcherRecoveryPromise: Promise<void> | null = null;
  const taskToolAutoWired = !toolRegistry.get('Task');
  if (taskToolAutoWired) {
    const getAgentInfo = (agentId: string) => {
      if (!sdkAgentExecutor) return null;
      const s = sdkAgentExecutor.getAgent(agentId);
      if (!s) return null;
      return {
        status: (
          s.state === 'running'
            ? 'running'
            : s.state === 'completed'
              ? 'completed'
              : s.state === 'shutdown'
                ? 'stopped'
                : 'failed'
        ) as 'running' | 'completed' | 'failed' | 'stopped',
        output_file: s.outputFile ?? '',
        result: s.result,
        summary: summarizePlainText(s.result ?? s.error),
        description: s.name ?? s.agentType,
        usage: {
          total_tokens: s.totalTokens ?? 0,
          tool_uses: s.totalToolUseCount ?? 0,
          duration_ms: s.durationMs,
        },
      };
    };

    toolRegistry.register(createTaskTool({
      runSubagent: async ({
        prompt: agentPrompt, subagentType, name, model: agentModel,
        cwd: agentCwd, maxTurns, mode, isolation, runInBackground, resume, teamName,
        parentToolUseId,
      }) => {
        if (!sdkAgentExecutor) {
          throw new Error('Subagent executor not initialized.');
        }
        const agentDef = availableAgents.get(subagentType);
        if (!agentDef) {
          throw new Error(
            `Unknown agent type: ${subagentType}. Available: ${[...availableAgents.keys()].join(', ')}`,
          );
        }

        const effectiveAgentCwd = agentCwd ?? cwd;
        let worktreePath: string | undefined;
        let worktreeBranch: string | undefined;

        if (isolation === 'worktree') {
          const wt = await createWorktree(effectiveAgentCwd, name ?? `agent-${resume ?? Date.now()}`);
          worktreePath = wt.path;
          worktreeBranch = wt.branch;
        }

        const executeOptions = {
          definition: agentDef,
          agentType: subagentType,
          provider,
          tools: new Map(toolRegistry.list().map((t) => [t.name, t])),
          prompt: agentPrompt,
          cwd: effectiveAgentCwd,
          name,
          model: agentModel ?? resolveAgentModel(agentDef.model) ?? model,
          maxTurns,
          mode: mode ?? agentDef.mode,
          teamName,
          isolation,
          runInBackground,
          resume,
          parentToolUseId,
          parentSessionId: sessionId,
          worktreePath,
          ...(worktreePath ? {
            onWorktreeCleanup: async (wtPath: string, hasChanges: boolean) => {
              if (!hasChanges) await cleanupWorktree(wtPath);
            },
          } : {}),
          ...(parentToolUseId ? {
            onEvent: (event: SubagentStreamEvent) => {
              enqueueSubagentMessages(parentToolUseId, teamName && !event.teamName
                ? { ...event, teamName }
                : event);
            },
          } : {}),
        };

        if (runInBackground) {
          const bg = await sdkAgentExecutor.executeInBackground(executeOptions);
          return JSON.stringify({
            status: 'async_launched',
            agentId: bg.agentId,
            description: name ?? subagentType,
            prompt: agentPrompt,
            outputFile: bg.outputFile,
            canReadOutputFile: true,
            task_event: {
              type: 'system',
              subtype: 'task_started',
              task_id: bg.agentId,
              ...(parentToolUseId ? { tool_use_id: parentToolUseId } : {}),
              description: name ?? subagentType,
              task_type: 'agent',
            },
            ...(worktreePath ? { worktree_path: worktreePath, worktree_branch: worktreeBranch } : {}),
          });
        }

        const { agentId, result: agentResult, session: agentSession } = await sdkAgentExecutor.execute(executeOptions);

        let worktreeCleanedUp = false;
        if (worktreePath) {
          const changed = await hasWorktreeChanges(worktreePath);
          if (!changed) {
            await cleanupWorktree(worktreePath);
            worktreeCleanedUp = true;
          }
        }

        const defaultUsage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: null, cache_read_input_tokens: null, server_tool_use: null, service_tier: null, cache_creation: null };
        const orchestrationTemplates = buildTaskOrchestrationTemplates({
          taskId: agentId,
          status: 'completed',
          description: name ?? subagentType,
          summary: summarizePlainText(agentResult),
          result: agentResult,
        });
        return JSON.stringify({
          status: 'completed',
          agentId,
          content: [{ type: 'text', text: agentResult }],
          totalToolUseCount: agentSession.totalToolUseCount ?? 0,
          totalDurationMs: agentSession.durationMs,
          totalTokens: agentSession.totalTokens ?? 0,
          usage: agentSession.usage ?? defaultUsage,
          prompt: agentPrompt,
          orchestration_templates: orchestrationTemplates,
          task_event: {
            type: 'system',
            subtype: 'task_notification',
            task_id: agentId,
            ...(parentToolUseId ? { tool_use_id: parentToolUseId } : {}),
            status: 'completed',
            ...(teamName ? { team_name: teamName } : {}),
            ...(name ? { description: name } : {}),
            output_file: agentSession.outputFile ?? '',
            summary: summarizePlainText(agentResult),
            orchestration_templates: orchestrationTemplates,
            usage: {
              total_tokens: agentSession.totalTokens ?? 0,
              tool_uses: agentSession.totalToolUseCount ?? 0,
              duration_ms: agentSession.durationMs,
            },
          },
          ...(worktreePath ? { worktree_path: worktreePath, worktree_branch: worktreeBranch, worktree_cleaned_up: worktreeCleanedUp } : {}),
        });
      },
      getBackgroundAgent: getAgentInfo,
    }));

    toolRegistry.register(createTaskOutputTool({
      getBackgroundAgent: getAgentInfo,
      stopBackgroundAgent: (id) => sdkAgentExecutor?.stopAgent(id) ?? false,
    }));
    toolRegistry.register(createTaskStopTool({
      getBackgroundAgent: getAgentInfo,
      stopBackgroundAgent: (id) => sdkAgentExecutor?.stopAgent(id) ?? false,
    }));
  }

  // Apply selected agent tool policy first, then caller-level tool policies.
  if (selectedAgent?.tools && selectedAgent.tools.length > 0) {
    const allowed = new Set(selectedAgent.tools);
    for (const tool of toolRegistry.list()) {
      if (!allowed.has(tool.name)) {
        toolRegistry.unregister(tool.name);
      }
    }
  }

  if (selectedAgent?.disallowedTools) {
    for (const name of selectedAgent.disallowedTools) {
      toolRegistry.unregister(name);
    }
  }

  // Apply `tools` baseline first (official semantics): explicit list limits the
  // available set before allowedTools/disallowedTools are layered on top.
  if (options.tools) {
    if (Array.isArray(options.tools)) {
      const baseline = new Set(options.tools);
      for (const tool of toolRegistry.list()) {
        if (!baseline.has(tool.name)) {
          toolRegistry.unregister(tool.name);
        }
      }
    } else if (options.tools.type !== 'preset' || options.tools.preset !== 'claude_code') {
      throw new Error('Unsupported tools preset.');
    }
  }

  // Apply allowedTools: discard everything not in the list.
  if (Array.isArray(options.allowedTools) && options.allowedTools.length > 0) {
    const allowed = new Set(options.allowedTools);
    for (const tool of toolRegistry.list()) {
      if (!allowed.has(tool.name)) {
        toolRegistry.unregister(tool.name);
      }
    }
  }

  // Apply disallowedTools: remove each named tool.
  if (options.disallowedTools) {
    // Validate: warn if a tool appears in both lists (programming error).
    if (options.allowedTools) {
      const allowedSet = new Set(options.allowedTools);
      for (const name of options.disallowedTools) {
        if (allowedSet.has(name)) {
          console.warn(
            `[open-agent/sdk] Tool "${name}" is in both allowedTools and disallowedTools — it will be removed.`,
          );
        }
      }
    }
    for (const name of options.disallowedTools) {
      toolRegistry.unregister(name);
    }
  }
  const isToolAllowedByPolicy = (toolName: string) =>
    __internal_isToolAllowedByPolicies(toolName, {
      agentAllowedTools: selectedAgent?.tools,
      agentDisallowedTools: selectedAgent?.disallowedTools,
      toolsBaseline: Array.isArray(options.tools) ? options.tools : undefined,
      allowedTools: options.allowedTools,
      disallowedTools: options.disallowedTools,
    });

  // Base non-MCP tool set after all static filtering. Used to restore any
  // built-in tool shadowed by an MCP tool when that MCP tool disappears.
  baseTools = new Map(toolRegistry.list().map((t) => [t.name, t]));

  // ------------------------------------------------------------------
  // Hooks — wire from QueryOptions
  // ------------------------------------------------------------------
  let hookExecutor: InstanceType<typeof HookExecutor> | undefined;
  const configuredHooks = mergeHookConfigs(
    loadedSettings?.hooks as Partial<Record<HookEvent, any[]>> | undefined,
    pluginRuntime.hookConfig,
    options.hooks,
  );
  if (configuredHooks && Object.keys(configuredHooks).length > 0) {
    hookExecutor = new HookExecutor();
    hookExecutor.loadFromConfig(configuredHooks);
  }
  // Adapt HookExecutor to LoopHookExecutor interface (loose → strict input type).
  const loopHookExecutor = hookExecutor
    ? { execute: (event: string, input: Record<string, unknown>, toolUseId?: string) => hookExecutor!.execute(event as any, input as any, toolUseId) }
    : undefined;

  // ------------------------------------------------------------------
  // File checkpointing — record file state before modifications
  // ------------------------------------------------------------------
  let fileCheckpoint: InstanceType<typeof FileCheckpoint> | undefined;
  if (options.enableFileCheckpointing) {
    const sessionMgr = new SessionManager();
    const sessionDir = sessionMgr.getSessionDir(cwd, sessionId);
    fileCheckpoint = new FileCheckpoint(sessionDir);
  }

  // Wrap hook executor to intercept PreToolUse for checkpointing
  const effectiveHookExecutor = fileCheckpoint
    ? {
        execute: async (event: string, input: Record<string, unknown>, toolUseId?: string) => {
          if (event === 'PreToolUse' && toolUseId) {
            const toolName = input.tool_name as string;
            if (toolName === 'Write' || toolName === 'Edit' || toolName === 'NotebookEdit') {
              const filePath = (input.tool_input as any)?.file_path ?? (input.tool_input as any)?.notebook_path;
              if (filePath) {
                try { fileCheckpoint!.save(toolUseId, filePath); } catch { /* ignore */ }
              }
            }
          }
          return loopHookExecutor ? loopHookExecutor.execute(event, input, toolUseId) : {};
        },
      }
    : loopHookExecutor;

  // Initialize the SDK agent executor now that hooks are available.
  if (taskToolAutoWired) {
    sdkAgentExecutor = new AgentExecutor(effectiveHookExecutor as any);
  }

  // ------------------------------------------------------------------
  // MCP servers — connect and discover tools
  // ------------------------------------------------------------------
  const mcpManager = runtime.getMcpManager();
  const configuredMcpServers = mergeMcpServerConfigs(
    loadedSettings?.mcpServers as Record<string, McpServerConfig> | undefined,
    pluginRuntime.mcpServers,
    options.mcpServers,
  );
  let hasConfiguredMcpServers = Object.keys(configuredMcpServers).length > 0;
  let mcpReadyPromise = runtime.waitForMcpReady();
  if (hasConfiguredMcpServers) {
    void runtime.setMcpServers(configuredMcpServers);
    mcpReadyPromise = runtime.waitForMcpReady();
  }

  // (env and debug overrides already applied above, before provider resolution)

  // ------------------------------------------------------------------
  // Model resolution
  // ------------------------------------------------------------------
  const model =
    requestedModelHint ??
    (provider.name === 'anthropic' ? 'claude-sonnet-4-6' : 'gpt-4o');
  const sessionMgr = sharedSessionManager ?? (shouldPersist ? new SessionManager() : null);
  if (sessionMgr) {
    try {
      sessionMgr.ensureSession(cwd, sessionId, model);
    } catch {
      // Non-fatal: keep query usable even if session metadata init fails.
    }
  }

  // ------------------------------------------------------------------
  // Permission engine — wire from QueryOptions
  // ------------------------------------------------------------------
  const requestedPermissionMode = options.permissionMode ?? selectedAgent?.mode ?? 'default';
  if (
    requestedPermissionMode === 'bypassPermissions' &&
    options.allowDangerouslySkipPermissions !== true
  ) {
    throw new Error(
      'permissionMode="bypassPermissions" requires allowDangerouslySkipPermissions=true',
    );
  }
  if (
    options.allowDangerouslySkipPermissions === true &&
    requestedPermissionMode !== 'bypassPermissions'
  ) {
    throw new Error(
      'allowDangerouslySkipPermissions=true requires permissionMode="bypassPermissions"',
    );
  }
  const permMode = requestedPermissionMode;
  if (sessionMgr) {
    try {
      sessionMgr.updateSession(
        cwd,
        sessionId,
        {
          permissionMode: permMode,
          outputStyle,
          ...(responseLanguage ? { language: responseLanguage } : {}),
          ...(options.agent ? { agent: options.agent } : {}),
          ...(options.resumeSessionAt ? { resumeSessionAt: options.resumeSessionAt } : {}),
          ...buildResumeMetadata(options, effectiveResumeSessionId),
          ...(pluginRuntime.plugins.length > 0 ? {
            plugins: pluginRuntime.plugins.map((plugin) => ({
              name: plugin.name,
              path: plugin.path,
            })),
          } : {}),
          ...(runtimeDiagnostics.length > 0 ? {
            runtimeDiagnostics: runtimeDiagnostics.map((entry) => ({
              code: entry.code,
              message: entry.message,
              severity: entry.severity,
              ...(entry.source ? { source: entry.source } : {}),
            })),
          } : {}),
          ...(
            (!sessionExistedBeforeQuery || options.forkSession)
              ? buildPromptSessionMetadata(
                typeof prompt === 'string' ? prompt : undefined,
                options.sessionTitle,
              )
              : (options.sessionTitle ? { title: options.sessionTitle } : {})
          ),
        },
        { touch: false },
      );
    } catch {
      // Non-fatal: metadata enrichment is best-effort.
    }
  }
  const transcriptCwd = sessionMgr?.getSession(cwd, sessionId)?.cwd ?? cwd;
  if (sessionMgr) {
    try {
      const persistedAgentExecutor = sdkAgentExecutor ?? new AgentExecutor();
      const pendingTaskNotifications = __internal_collectPendingTaskNotifications({
        sessionId,
        transcriptEntries: sessionMgr.readTranscript(transcriptCwd, sessionId),
        childSessions: persistedAgentExecutor.listPersistedAgents(),
      });
      for (const message of pendingTaskNotifications) {
        sessionMgr.appendToTranscript(transcriptCwd, sessionId, message);
      }
    } catch {
      // Non-fatal: background task notification sync is best-effort.
    }
  }
  const settingsSandbox = parseSandboxConfig(loadedSettings?.sandbox);
  if (loadedSettings && loadedSettings.sandbox !== undefined && !settingsSandbox) {
    throw new Error('Loaded settings sandbox config is invalid; expected explicit boolean enabled field.');
  }
  let optionSandbox: SandboxConfig | undefined;
  if (options.sandbox !== undefined) {
    optionSandbox = parseSandboxConfig(options.sandbox);
    if (!optionSandbox) {
      throw new Error('options.sandbox must be a valid sandbox config with an explicit boolean enabled field.');
    }
  }
  const effectiveSandboxConfig = optionSandbox ?? settingsSandbox;
  const permissionEngine = new PermissionEngine({
    mode: permMode,
    ...(effectiveSandboxConfig ? { sandbox: effectiveSandboxConfig } : {}),
  });
  if (loadedSettings) {
    permissionEngine.loadFromSettings(loadedSettings as Record<string, any>);
  }
  let effectivePermissionEngine: {
    evaluate: (request: {
      toolName: string;
      input: unknown;
      toolUseId?: string;
      metadata?: {
        readOnly?: boolean;
        destructive?: boolean;
        openWorld?: boolean;
        source?: 'builtin' | 'dynamic' | 'mcp';
        serverName?: string;
        capability?: {
          category?: string;
          risk?: 'low' | 'medium' | 'high';
          needsWorkspaceWrite?: boolean;
        };
      };
    }) => { behavior: 'allow' | 'deny' | 'ask'; reason?: string } | Promise<{ behavior: 'allow' | 'deny' | 'ask'; reason?: string }>;
    addRule: (behavior: 'allow' | 'deny' | 'ask', rule: { toolName: string; ruleContent?: string }) => void;
    removeRule?: (behavior: 'allow' | 'deny' | 'ask', rule: { toolName: string; ruleContent?: string }) => void;
    setMode?: (mode: string) => void;
  } = permissionEngine as any;

  // Wire permissionPromptToolName into the permission engine when provided.
  if (options.permissionPromptToolName) {
    permissionEngine.setPermissionPromptToolName(options.permissionPromptToolName);
  }

  const attachBashSandboxPolicy = (
    request: { toolName: string; input: unknown; metadata?: unknown },
    permissionBehavior?: 'allow' | 'deny' | 'ask',
  ): void => {
    if (request.toolName !== 'Bash') return;
    if (!request.input || typeof request.input !== 'object' || Array.isArray(request.input)) return;

    const input = request.input as Record<string, unknown>;
    const policy = buildBashSandboxPolicy({
      sandbox: effectiveSandboxConfig,
      cwd,
      dangerouslyDisableSandbox: input.dangerouslyDisableSandbox === true,
      bypassApproved: input[BASH_SANDBOX_BYPASS_APPROVED_FIELD] === true,
      permissionBehavior,
    });
    input[BASH_SANDBOX_POLICY_FIELD] = policy;
  };

  const originalEvaluate = permissionEngine.evaluate.bind(permissionEngine);
  effectivePermissionEngine = {
    evaluate: async (request) => {
      const baselineDecision = await originalEvaluate(request as any);
      attachBashSandboxPolicy(request, baselineDecision.behavior);

      if (!options.canUseTool) {
        return baselineDecision;
      }

      const normalizedInput = request.input as Record<string, unknown>;
      const result = await options.canUseTool!(
        request.toolName,
        normalizedInput,
        {
          signal: internalAbortController.signal,
          suggestions: undefined,
          decisionReason: baselineDecision.reason,
          toolUseID: request.toolUseId ?? randomUUID(),
          agentID: options.agent,
        },
      );

      if (
        result &&
        typeof result === 'object' &&
        'toolUseID' in result &&
        typeof result.toolUseID === 'string' &&
        request.toolUseId &&
        result.toolUseID !== request.toolUseId
      ) {
        const decision = {
          behavior: 'deny' as const,
          reason: `Mismatched toolUseID from canUseTool callback: expected ${request.toolUseId}, got ${result.toolUseID}`,
        };
        attachBashSandboxPolicy(request, decision.behavior);
        return decision;
      }

      if (result && typeof result === 'object' && 'updatedPermissions' in result) {
        applyPermissionUpdates(permissionEngine, result.updatedPermissions);
      }

      if (result && typeof result === 'object' && 'updatedInput' in result) {
        applyUpdatedInput(request.input, result.updatedInput);
        attachBashSandboxPolicy(request, baselineDecision.behavior);
      }

      if (result && typeof result === 'object' && 'behavior' in result) {
        if (result.behavior === 'allow') {
          const decision = {
            behavior: 'allow' as const,
            reason: 'Allowed by canUseTool callback',
          };
          attachBashSandboxPolicy(request, decision.behavior);
          return decision;
        }
        if (result.behavior === 'deny') {
          if ('interrupt' in result && result.interrupt === true) {
            internalAbortController.abort();
          }
          const denyMessage = 'message' in result && typeof result.message === 'string'
            ? result.message
            : ('reason' in result && typeof result.reason === 'string'
              ? result.reason
              : 'Denied by canUseTool callback');
          const decision = { behavior: 'deny' as const, reason: denyMessage };
          attachBashSandboxPolicy(request, decision.behavior);
          return decision;
        }
      }
      if (result === false) {
        const decision = { behavior: 'deny' as const, reason: 'Denied by canUseTool callback' };
        attachBashSandboxPolicy(request, decision.behavior);
        return decision;
      }
      if (
        typeof result === 'object' &&
        result !== null &&
        'behavior' in result &&
        (result as any).behavior === 'ask'
      ) {
        const decision = { behavior: 'ask' as const, reason: (result as any).reason };
        attachBashSandboxPolicy(request, decision.behavior);
        return decision;
      }
      attachBashSandboxPolicy(request, baselineDecision.behavior);
      return baselineDecision;
    },
    addRule: permissionEngine.addRule.bind(permissionEngine),
    removeRule: (permissionEngine as any).removeRule?.bind(permissionEngine),
    setMode: (permissionEngine as any).setMode?.bind(permissionEngine),
  };

  const basePermissionPrompter = createPermissionPrompterBridge({
    permissionPromptToolName: options.permissionPromptToolName,
    permissionPrompter: options.permissionPrompter,
    getMcpClient: () => mcpManager,
    waitForMcpReady: () => mcpReadyPromise,
  });
  const permissionPrompter = basePermissionPrompter
    ? {
      prompt: async (request: { toolName: string; input: any; reason?: string }) => {
        const userDecision = await basePermissionPrompter.prompt(request);
        if (userDecision !== 'deny' && request.toolName === 'Bash') {
          const input = request.input as Record<string, unknown> | undefined;
          const maybePolicy = input?.[BASH_SANDBOX_POLICY_FIELD];
          if (
            maybePolicy &&
            typeof maybePolicy === 'object' &&
            (maybePolicy as BashSandboxExecutionPolicy).bypassRequested === true
          ) {
            (maybePolicy as BashSandboxExecutionPolicy).bypassAllowed = true;
            if (input) {
              input[BASH_SANDBOX_BYPASS_APPROVED_FIELD] = true;
            }
          }
        }
        return userDecision;
      },
    }
    : undefined;

  // ------------------------------------------------------------------
  // System prompt
  // ------------------------------------------------------------------
  const sources = new Set(settingSources);
  const promptContext = loadPromptContext({
    cwd,
    includeGit: isGitRepo,
    includeMemory: sources.has('project'),
    includeAgentInstructions: sources.size > 0,
    instructionSources: [
      ...(sources.has('user') ? ['user' as const] : []),
      ...(sources.has('project') ? ['project' as const] : []),
    ],
    additionalDirectories: options.additionalDirectories,
  });
  const hasContextSection = (key: string): boolean =>
    promptContext.sections.some((section) => section.key === key);

  let activeModel = model;
  let sessionLifecycleStatus: SessionStateSnapshot['status'] = 'idle';
  let sessionLastActivityAt = new Date().toISOString();
  let sessionLastResultAt: string | undefined;
  let sessionIdleReason: string | undefined;
  let sessionLastError: string | undefined;
  let sessionActiveTurn = false;
  let coordinatorTaskNotificationsForPrompt: Array<Pick<
    SDKTaskNotificationMessage,
    'task_id' | 'status' | 'team_name' | 'description' | 'orchestration_templates'
  >> = [];
  const presetSystemPrompt = typeof options.systemPrompt === 'object'
    ? options.systemPrompt
    : undefined;
  const buildManagedSystemPrompt = (): string => {
    let nextPrompt: string;
    if (typeof options.systemPrompt === 'string') {
      nextPrompt = options.systemPrompt;
    } else {
      const runtimeSnapshot = runtime.buildSnapshot();
      const connectedMcpServers = runtimeSnapshot.mcpServers.filter((server) => server.status === 'connected');
      const availableTools = toolRegistry.list().map((tool) => tool.name);
      const configuredActiveTeam = activeTeamName ?? defaultTeamName;
      const coordinatorScratchpadDir = sdkTeamManager.getTeam(configuredActiveTeam)
        ? sdkTeamManager.getScratchpadDir(configuredActiveTeam)
        : join(cwd, '.open-agent', 'scratchpad');
      const coordinatorContext = buildCoordinatorContext({
        workerTools: availableTools.filter((name) => name !== 'Task'),
        activeTeam: sdkTeamManager.getTeam(configuredActiveTeam) ? configuredActiveTeam : undefined,
        scratchpadDir: coordinatorScratchpadDir,
        canUseSkills: Boolean(toolRegistry.get('Skill')) && runtimeSnapshot.skills.length > 0,
        canUseMcpTools: connectedMcpServers.length > 0,
        taskNotifications: coordinatorTaskNotificationsForPrompt,
      });
      nextPrompt = buildSystemPrompt({
        model: activeModel,
        cwd,
        tools: availableTools,
        permissionMode: permMode,
        language: responseLanguage,
        outputStyle,
        knowledgeCutoff: 'August 2025',
        agentInstructions: promptContext.agentInstructions,
        memoryDir: hasContextSection('memory-context') ? undefined : promptContext.memoryDir,
        memoryContent: hasContextSection('memory-context') ? undefined : promptContext.memoryContent,
        isGitRepo,
        gitContext: hasContextSection('git-context') ? undefined : promptContext.gitContext,
        contextSections: promptContext.sections,
        toolDescriptions: getToolPromptDescriptions(),
        runtimeSnapshot: {
          agents: runtimeSnapshot.agents,
          skills: runtimeSnapshot.skills,
          mcpServers: runtimeSnapshot.mcpServers,
          capabilitySnapshot: runtimeSnapshot.capabilitySnapshot,
          coordinator: coordinatorContext,
        },
      });
    }

    if (selectedAgent?.prompt) {
      nextPrompt += '\n\n' + selectedAgent.prompt;
    }

    if (presetSystemPrompt?.type === 'preset' && presetSystemPrompt.append) {
      nextPrompt += '\n\n' + presetSystemPrompt.append;
    }

    return nextPrompt;
  };

  // ------------------------------------------------------------------
  // Session resume — restore prior history if requested
  // ------------------------------------------------------------------
  let initialMessages: Message[] = (options as QueryOptions & { initialMessages?: Message[] }).initialMessages ?? [];
  if (effectiveResumeSessionId && initialMessages.length === 0) {
    try {
      const sessionMgr = new SessionManager();
      if (options.resumeSessionAt) {
        const scoped = sessionMgr.loadTranscriptAnyCwdUpToAssistant(
          effectiveResumeSessionId,
          cwd,
          options.resumeSessionAt,
        );
        if (!scoped.found) {
          throw new Error(`Assistant message not found for resumeSessionAt: ${options.resumeSessionAt}`);
        }
        initialMessages = scoped.messages;
      } else {
        initialMessages = sessionMgr.loadTranscriptAnyCwd(effectiveResumeSessionId, cwd);
      }
    } catch (error) {
      if (options.resumeSessionAt) {
        throw error;
      }
      // If transcript is corrupted or missing, start fresh.
      initialMessages = [];
    }
  }
  const trailingTaskNotifications = __internal_collectTrailingTaskNotifications(initialMessages);
  coordinatorTaskNotificationsForPrompt = trailingTaskNotifications;
  for (const notification of trailingTaskNotifications) {
    recordTaskNotificationObservation(currentTurnObservation, notification);
  }
  let systemPrompt = buildManagedSystemPrompt();

  // ------------------------------------------------------------------
  // Conversation loop
  // ------------------------------------------------------------------
  // Respect the caller's AbortController when provided; otherwise create one
  // internally so interrupt() / close() can still abort the loop.
  const callerAbortController = options.abortController;
  const internalAbortController = new AbortController();
  const callerAbortListener = () => {
    if (!internalAbortController.signal.aborted) {
      internalAbortController.abort();
    }
  };
  if (callerAbortController) {
    if (callerAbortController.signal.aborted) {
      callerAbortListener();
    } else {
      callerAbortController.signal.addEventListener('abort', callerAbortListener, { once: true });
    }
  }

  function removeCallerAbortListener(): void {
    if (callerAbortController) {
      callerAbortController.signal.removeEventListener('abort', callerAbortListener);
    }
  }

  function abortQuery(abortCaller = false): void {
    if (!internalAbortController.signal.aborted) {
      internalAbortController.abort();
    }
    if (abortCaller && callerAbortController && !callerAbortController.signal.aborted) {
      callerAbortController.abort();
    }
  }

  let cleanedUp = false;
  function cleanupQueryResources(): void {
    if (cleanedUp) return;
    cleanedUp = true;
    cleanupTaskDispatchers(true);
    releaseTaskSchedulerOwnership();
    if (mcpManager) {
      runtime.disconnectMcpServers().catch(() => {});
    }
    for (const subscriber of [...orchestrationSubscribers]) {
      subscriber.close();
    }
    inputClosed = true;
    notifyQueue();
    removeCallerAbortListener();
    restoreEnv();
  }

  // Wire up a cost calculator so ConversationLoop can track spending and
  // enforce maxBudgetUsd.
  const maxBudgetUsd = options.maxBudgetUsd;

  const appStore = createStore<AppState>(createDefaultAppState({
    sessionId,
    cwd,
    model: activeModel,
    permissionMode: permMode,
    tools: new Map(toolRegistry.list().map((t) => [t.name, t])),
    thinkingConfig: options.thinking ?? (options.maxThinkingTokens ? { type: 'enabled', budgetTokens: options.maxThinkingTokens } : { type: 'adaptive' }),
    verbose: options.debug ?? false,
  }));

  const mapAppStateMcpServers = () => runtime.listMcpServerStatus().map((server) => ({
    name: server.name,
    status: mapMcpStatus(server.status) as AppState['mcpServers'][number]['status'],
    toolCount: server.tools.length,
    ...(server.error ? { error: server.error } : {}),
  }));

  const syncAppRuntimeControlPlane = () => {
    const runtimeSnapshot = runtime.buildSnapshot();
    appStore.setState((prev) => {
      let next = syncToolRegistryState(prev, toolRegistry.list());
      next = syncMcpServerState(next, mapAppStateMcpServers());
      next = syncRuntimeControlPlane(next, runtimeSnapshot);
      next = setActiveTeamControlPlane(next, activeTeamName);
      return next;
    });
  };
  const syncAppSchedulerControlPlane = () => {
    const liveSnapshot = buildSchedulerControlPlaneSnapshot();
    const persistedSnapshot = readPersistedSchedulerControlPlaneSnapshot();
    const schedulerSnapshot = liveSnapshot.queue.length > 0 || !persistedSnapshot
      ? liveSnapshot
      : persistedSnapshot;
    appStore.setState((prev) => syncSchedulerControlPlane(prev, schedulerSnapshot));
    if (liveSnapshot.queue.length > 0 || !persistedSnapshot) {
      persistSchedulerControlPlaneSnapshot(schedulerSnapshot);
    }
  };

  syncAppRuntimeControlPlane();

  const touchSessionState = (patch: Partial<Pick<
    SessionStateSnapshot,
    'status' | 'lastResultAt' | 'idleReason' | 'lastError' | 'activeTurn'
  >> = {}): void => {
    sessionLifecycleStatus = patch.status ?? sessionLifecycleStatus;
    if ('lastResultAt' in patch) {
      sessionLastResultAt = patch.lastResultAt;
    }
    if ('idleReason' in patch) {
      sessionIdleReason = patch.idleReason;
    }
    if ('lastError' in patch) {
      sessionLastError = patch.lastError;
    }
    sessionActiveTurn = patch.activeTurn ?? sessionActiveTurn;
    sessionLastActivityAt = new Date().toISOString();
  };

  const readSessionStateSnapshot = (): SessionStateSnapshot => ({
    sessionId,
    status: sessionLifecycleStatus,
    activeTurn: sessionActiveTurn,
    canAcceptInput: typeof prompt !== 'string'
      && !inputClosed
      && !internalAbortController.signal.aborted
      && sessionLifecycleStatus !== 'running'
      && sessionLifecycleStatus !== 'closed',
    pendingInputCount: queuedInputs.length,
    model: activeModel,
    permissionMode: appStore.getState().permissionMode,
    activeTeamName,
    lastActivityAt: sessionLastActivityAt,
    ...(sessionLastResultAt ? { lastResultAt: sessionLastResultAt } : {}),
    ...(sessionIdleReason ? { idleReason: sessionIdleReason } : {}),
    ...(sessionLastError ? { lastError: sessionLastError } : {}),
  });

  const upsertDispatcherStoreRecord = (record: TaskDispatcherRecord) => {
    appStore.setState((prev) => upsertDispatcherControlPlane(prev, {
      dispatcherId: record.dispatcherId,
      teamName: record.teamName,
      status: record.status,
      startedAt: record.startedAt,
      updatedAt: record.updatedAt,
      payload: cloneTaskDispatcherRecord(record),
    }));
  };

  const upsertTaskStoreRecord = (
    record: TaskRecord,
    options?: { persist?: boolean },
  ) => {
    appStore.setState((prev) => upsertTaskControlPlane(prev, {
      id: record.id,
      subject: record.subject,
      description: record.description,
      status: record.status,
      ...(record.owner ? { owner: record.owner } : {}),
      ...(record.priority !== undefined ? { priority: record.priority } : {}),
      ...(record.activeForm ? { activeForm: record.activeForm } : {}),
      blocks: [...record.blocks],
      blockedBy: [...record.blockedBy],
      ...(record.lease ? { lease: { ...record.lease } } : {}),
      teamName: record.teamName,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      ...(record.metadata ? { metadata: { ...record.metadata } } : {}),
      payload: JSON.parse(JSON.stringify(record)),
    }));
    if (options?.persist !== false) {
      persistTaskLedgerRecord(record);
    }
  };

  const upsertWorkerStoreRecord = (
    record: WorkerRecord,
    options?: { persist?: boolean },
  ) => {
    appStore.setState((prev) => upsertWorkerControlPlane(prev, {
      workerId: record.workerId,
      workerType: record.workerType,
      status: record.status,
      ...(record.teamName ? { teamName: record.teamName } : {}),
      startedAt: record.startedAt,
      updatedAt: record.completedAt ?? record.startedAt,
      payload: JSON.parse(JSON.stringify(record)),
    }));
    if (options?.persist !== false) {
      persistWorkerLedgerRecord(record);
    }
  };

  const upsertDispatcherDiagnosisStoreRecord = (report: TaskDispatcherHealthReport) => {
    appStore.setState((prev) => upsertDispatcherDiagnosisControlPlane(prev, {
      dispatcherId: report.dispatcherId,
      teamName: report.dispatcher.teamName,
      healthy: report.healthy,
      source: report.source,
      observedAt: report.observedAt,
      findingCount: report.findings.length,
      payload: JSON.parse(JSON.stringify(report)),
    }));
  };

  const appendTimelineStoreItem = (
    item: SDKTimelineItem,
    options?: { persist?: boolean },
  ) => {
    const key = item.cursor ?? item.timelineId ?? `${item.kind}:${item.timestamp}:${item.sessionId}`;
    appStore.setState((prev) => appendTimelineControlPlane(prev, {
      key,
      kind: item.kind,
      sessionId: item.sessionId,
      timestamp: item.timestamp,
      ...(item.cursor ? { cursor: item.cursor } : {}),
      ...(item.timelineId ? { timelineId: item.timelineId } : {}),
      payload: JSON.parse(JSON.stringify(item)),
    }));
    if (options?.persist !== false) {
      persistOrchestrationTimelineLedgerItem(item);
    }
  };

  const appendTimelineStoreItems = (
    items: SDKTimelineItem[],
    options?: { persist?: boolean },
  ) => {
    if (items.length === 0) {
      return;
    }
    appStore.setState((prev) => items.reduce((state, item) => appendTimelineControlPlane(state, {
      key: item.cursor ?? item.timelineId ?? `${item.kind}:${item.timestamp}:${item.sessionId}`,
      kind: item.kind,
      sessionId: item.sessionId,
      timestamp: item.timestamp,
      ...(item.cursor ? { cursor: item.cursor } : {}),
      ...(item.timelineId ? { timelineId: item.timelineId } : {}),
      payload: JSON.parse(JSON.stringify(item)),
    }), prev));
    if (options?.persist !== false) {
      for (const item of items) {
        persistOrchestrationTimelineLedgerItem(item);
      }
    }
  };

  const readTimelineStoreItems = (teamName?: string): SDKTimelineItem[] => (
    appStore.getState().timeline
      .map((entry) => entry.payload as SDKTimelineItem)
      .filter((item) => !teamName || item.teamName === teamName)
  );

  const readRuntimeControlPlaneSnapshot = (): RuntimeControlPlaneSnapshot => {
    const state = appStore.getState();
    return {
      sessionId: state.sessionId,
      cwd: state.cwd,
      model: state.model,
      permissionMode: state.permissionMode,
      activeTeamName: state.activeTeamName,
      mcpServers: state.mcpServers.map((server) => ({ ...server })),
      runtime: {
        agentNames: [...state.runtime.agentNames],
        skillNames: [...state.runtime.skillNames],
        plugins: state.runtime.plugins.map((plugin) => ({ ...plugin })),
        hooks: state.runtime.hooks.map((hook) => ({
          ...hook,
          sources: [...hook.sources],
        })),
        diagnostics: state.runtime.diagnostics.map((entry) => ({ ...entry })) as RuntimeDiagnosticRecord[],
        capabilitySummary: {
          ...state.runtime.capabilitySummary,
        },
      },
    };
  };

  const readOrchestrationControlPlaneSnapshot = (
    options?: OrchestrationControlPlaneOptions,
  ): OrchestrationControlPlaneSnapshot => {
    const state = appStore.getState();
    const teamName = normalizeOptionalString(options?.teamName);
    const tasks = Object.values(state.tasks)
      .map((entry) => entry.payload as TaskRecord)
      .filter((entry) => !teamName || entry.teamName === teamName)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const workers = Object.values(state.workers)
      .map((entry) => entry.payload as WorkerRecord)
      .filter((entry) => !teamName || entry.teamName === teamName)
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
    const dispatchers = Object.values(state.dispatchers)
      .map((entry) => entry.payload as TaskDispatcherRecord)
      .filter((entry) => !teamName || entry.teamName === teamName)
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
    const dispatcherDiagnoses = Object.values(state.dispatcherDiagnoses)
      .map((entry) => entry.payload as TaskDispatcherHealthReport)
      .filter((entry) => !teamName || entry.dispatcher.teamName === teamName)
      .sort((left, right) => left.observedAt.localeCompare(right.observedAt));
    const scheduler = {
      ownerQueryInstanceId: state.scheduler.ownerQueryInstanceId,
      ownerSessionId: state.scheduler.ownerSessionId,
      ...(state.scheduler.claimedAt ? { claimedAt: state.scheduler.claimedAt } : {}),
      ...(state.scheduler.heartbeatAt ? { heartbeatAt: state.scheduler.heartbeatAt } : {}),
      fairnessCursor: state.scheduler.fairnessCursor,
      updatedAt: state.scheduler.updatedAt,
      queue: state.scheduler.queue
        .filter((entry) => !teamName || entry.teamName === teamName)
        .map((entry) => ({ ...entry })),
    };
    const summary = {
      taskCount: tasks.length,
      pendingTaskCount: tasks.filter((entry) => entry.status === 'pending').length,
      inProgressTaskCount: tasks.filter((entry) => entry.status === 'in_progress').length,
      completedTaskCount: tasks.filter((entry) => entry.status === 'completed').length,
      deletedTaskCount: tasks.filter((entry) => entry.status === 'deleted').length,
      leasedTaskCount: tasks.filter((entry) => Boolean(entry.lease)).length,
      workerCount: workers.length,
      runningWorkerCount: workers.filter((entry) => entry.status === 'running' || entry.status === 'spawning').length,
      idleWorkerCount: workers.filter((entry) => entry.status === 'idle').length,
      terminalWorkerCount: workers.filter((entry) => entry.status === 'completed' || entry.status === 'failed' || entry.status === 'shutdown').length,
      globalDispatcherWorkerBudget,
      availableDispatcherWorkerBudget: getAvailableDispatcherWorkerBudget(),
      teamDispatcherWorkerBudgets: { ...teamDispatcherWorkerBudgets },
      availableTeamDispatcherWorkerBudgets: Object.fromEntries(
        Object.keys(teamDispatcherWorkerBudgets)
          .sort((left, right) => left.localeCompare(right))
          .map((teamKey) => [teamKey, getAvailableDispatcherWorkerBudgetForTeam(teamKey) ?? 0] as const),
      ),
      dispatcherCount: dispatchers.length,
      liveDispatcherCount: dispatchers.filter((entry) => entry.source === 'live').length,
      ledgerDispatcherCount: dispatchers.filter((entry) => entry.source === 'ledger').length,
      transcriptDispatcherCount: dispatchers.filter((entry) => entry.source === 'transcript').length,
      runningDispatcherCount: dispatchers.filter((entry) => entry.status === 'running').length,
      drainingDispatcherCount: dispatchers.filter((entry) => entry.status === 'draining').length,
      stoppedDispatcherCount: dispatchers.filter((entry) => entry.status === 'stopped').length,
      idleDispatcherCount: dispatchers.filter((entry) => entry.schedulerState === 'idle').length,
      ownershipBlockedDispatcherCount: dispatchers.filter((entry) => entry.schedulerState === 'waiting_for_scheduler_owner').length,
      globalBudgetBlockedDispatcherCount: dispatchers.filter((entry) => entry.schedulerState === 'waiting_for_global_worker_budget').length,
      teamBudgetBlockedDispatcherCount: dispatchers.filter((entry) => entry.schedulerState === 'waiting_for_team_worker_budget').length,
      fairnessBlockedDispatcherCount: dispatchers.filter((entry) => entry.schedulerState === 'waiting_for_fair_turn').length,
      activeAssignmentCount: dispatchers.reduce((total, entry) => total + entry.activeAssignments.length, 0),
      unhealthyDispatcherCount: dispatcherDiagnoses.filter((entry) => !entry.healthy).length,
      dispatcherErrorCount: dispatcherDiagnoses.reduce((total, entry) => total + entry.summary.errorCount, 0),
      dispatcherWarningCount: dispatcherDiagnoses.reduce((total, entry) => total + entry.summary.warningCount, 0),
    };
    return {
      sessionId: state.sessionId,
      activeTeamName: state.activeTeamName,
      summary,
      scheduler,
      tasks,
      workers,
      dispatchers,
      dispatcherDiagnoses,
    };
  };

  const hydratePersistedOrchestrationLedgersIntoStore = (options?: OrchestrationControlPlaneOptions) => {
    const teamName = normalizeOptionalString(options?.teamName);
    for (const record of readPersistedTaskLedgerRecords()) {
      if (!teamName || record.teamName === teamName) {
        upsertTaskStoreRecord(record, { persist: false });
      }
    }
    for (const record of readPersistedWorkerLedgerRecords()) {
      if (!teamName || record.teamName === teamName) {
        upsertWorkerStoreRecord(record, { persist: false });
      }
    }
  };

  const hydratePersistedOrchestrationTimelineIntoStore = (options?: {
    teamName?: string;
    includeOrchestration?: boolean;
    includeTaskNotifications?: boolean;
  }) => {
    const teamName = normalizeOptionalString(options?.teamName);
    const includeKinds = new Set<SDKTimelineItem['kind']>();
    if (options?.includeOrchestration !== false) {
      includeKinds.add('worker_lifecycle');
      includeKinds.add('task_dispatcher');
    }
    if (options?.includeTaskNotifications !== false) {
      includeKinds.add('task_notification');
    }
    for (const item of readPersistedOrchestrationTimelineLedgerItems()) {
      if (!includeKinds.has(item.kind)) {
        continue;
      }
      if (teamName && item.teamName !== teamName) {
        continue;
      }
      appendTimelineStoreItem(item, { persist: false });
    }
  };

  const appendOrchestrationTimelineStoreItem = (event: SDKOrchestrationEvent) => {
    if (event.kind !== 'worker_lifecycle') {
      return;
    }
    appendTimelineStoreItem(toTimelineOrchestrationItem(event));
  };

  const syncWorkerFromLifecycleEvent = (event: SDKOrchestrationEvent): void => {
    if (event.kind !== 'worker_lifecycle' || !event.workerId) {
      return;
    }
    const persistedAgentExecutor = sdkAgentExecutor ?? new AgentExecutor();
    const session = persistedAgentExecutor.getAgent(event.workerId);
    if (session) {
      upsertWorkerStoreRecord(toWorkerRecord(session));
    }
  };

  const loop = new ConversationLoop({
    provider,
    tools: new Map(toolRegistry.list().map((t) => [t.name, t])),
    model: activeModel,
    systemPrompt,
    maxTurns: options.maxTurns ?? selectedAgent?.maxTurns,
    thinking: options.thinking ?? (options.maxThinkingTokens ? { type: 'enabled', budgetTokens: options.maxThinkingTokens } : { type: 'adaptive' }),
    effort: options.effort,
    cwd,
    sessionId,
    abortSignal: internalAbortController.signal,
    permissionEngine: effectivePermissionEngine,
    permissionPrompter,
    initialMessages: initialMessages.length > 0 ? initialMessages : undefined,
    hookExecutor: effectiveHookExecutor,
    costCalculator: (m, inTok, outTok, cacheCreate, cacheRead) =>
      calculateCost(m, inTok, outTok, cacheCreate, cacheRead),
    responseFormat: options.outputFormat ? { type: options.outputFormat.type, schema: options.outputFormat.schema } : undefined,
    serverTools: options.serverTools,
    getAppState: () => appStore.getState(),
    setAppState: (updater) => appStore.setState(updater),
  });

  const syncLoopToolsFromRegistry = () => {
    loop.setTools(new Map(toolRegistry.list().map((t) => [t.name, t])));
    syncAppRuntimeControlPlane();
  };
  const refreshManagedSystemPrompt = () => {
    if (typeof options.systemPrompt === 'string') {
      return;
    }
    systemPrompt = buildManagedSystemPrompt();
    loop.setSystemPrompt(systemPrompt);
    syncAppRuntimeControlPlane();
  };

  // ------------------------------------------------------------------
  // Core generator – iterates over all SDKMessages
  // ------------------------------------------------------------------
  async function* generateMessages(): AsyncGenerator<SDKMessage, void> {
    const executionErrorResult = (error: Error): SDKMessage => {
      const { totalCostUsd, totalInputTokens, totalOutputTokens } = loop.getTotalCost();
      return {
        type: 'result',
        subtype: 'error_during_execution',
        duration_ms: 0,
        duration_api_ms: 0,
        is_error: true,
        num_turns: loop.getTurnCount(),
        stop_reason: internalAbortController.signal.aborted ? 'interrupted' : 'error',
        total_cost_usd: totalCostUsd,
        usage: { input_tokens: totalInputTokens, output_tokens: totalOutputTokens },
        modelUsage: {},
        permission_denials: [],
        errors: [error.message || String(error)],
        uuid: randomUUID(),
        session_id: sessionId,
      };
    };
    try {
      await runtimeReadyPromise;
      // Wait for async setupTools to complete before the first LLM call.
      if (setupToolsReady) {
        await setupToolsReady;
        refreshManagedSystemPrompt();
        syncLoopToolsFromRegistry();
      }
      // Wait for MCP servers to connect and register their tools into the loop
      // before the first LLM call. This runs once when iteration starts.
      if (mcpReadyPromise) {
        await mcpReadyPromise;
        refreshManagedSystemPrompt();
        syncLoopToolsFromRegistry();
      }
      if (typeof prompt === 'string') {
        let usedFallback = false;
        // Retry loop — runs once normally; a second time with fallbackModel on model errors.
        while (true) {
          let resultEmittedForTurn = false;
          // Buffer the result message so we can inspect it for model errors before
          // deciding whether to yield it or retry with the fallback model.
          let resultMessage: SDKMessage | undefined;
          let modelError: Error | undefined;
          touchSessionState({
            status: 'running',
            activeTurn: true,
            idleReason: undefined,
            lastError: undefined,
          });
          try {
            for await (const msg of loop.run(prompt)) {
              yield* flushPendingSubagentMessages();
              // Default behavior matches official SDK: partials are off unless explicitly enabled.
              if (options.includePartialMessages !== true && msg.type === 'stream_event') {
                continue;
              }
              // Hold back the result message — check it for model errors first.
              if (msg.type === 'result') {
                resultMessage = msg;
                continue;
              }
              yield msg;
              // Enforce maxBudgetUsd: check cumulative cost after each message.
              if (maxBudgetUsd !== undefined) {
                const { totalCostUsd } = loop.getTotalCost();
                if (totalCostUsd >= maxBudgetUsd) {
                  internalAbortController.abort();
                  yield {
                    type: 'result',
                    subtype: 'error_max_budget_usd',
                    duration_ms: 0,
                    duration_api_ms: 0,
                    is_error: true,
                    num_turns: loop.getTurnCount(),
                    stop_reason: 'max_budget_usd',
                    total_cost_usd: totalCostUsd,
                    usage: { input_tokens: 0, output_tokens: 0 },
                    modelUsage: {},
                    permission_denials: [],
                    errors: [`Budget limit exceeded: $${totalCostUsd.toFixed(4)} >= $${maxBudgetUsd}`],
                    uuid: randomUUID(),
                    session_id: sessionId,
                  };
                  return;
                }
              }
            }
          } catch (err) {
            modelError = err instanceof Error ? err : new Error(String(err));
          }
          yield* flushPendingSubagentMessages();

          // Check if the result message signals a model error that warrants
          // a fallback retry.  ConversationLoop yields result messages instead
          // of throwing for provider errors, so we must inspect the result too.
          if (
            !modelError &&
            resultMessage &&
            (resultMessage as any).is_error === true &&
            (resultMessage as any).stop_reason === 'error'
          ) {
            const errText = ((resultMessage as any).errors as string[] | undefined)?.join(' ') ?? '';
            if (isModelError(new Error(errText))) {
              modelError = new Error(errText);
            }
          }

          if (modelError) {
            touchSessionState({
              status: 'failed',
              activeTurn: false,
              lastError: modelError.message,
            });
            // Switch to fallbackModel and retry once if this looks like a model error.
            if (options.fallbackModel && !usedFallback && isModelError(modelError)) {
              usedFallback = true;
              activeModel = options.fallbackModel;
              loop.setModel(options.fallbackModel);
              refreshManagedSystemPrompt();
              // Reset conversation history so that the user prompt is not
              // duplicated when loop.run(prompt) is called again below.
              loop.resetMessages(initialMessages.length > 0 ? initialMessages : undefined);
              resultMessage = undefined; // discard the error result — will retry
              continue; // retry with fallback model
            }
            // Not retrying — yield the buffered result if we have one, then surface error.
            if (resultMessage) {
              if (!resultEmittedForTurn) {
                yield* flushPendingSubagentMessages();
                yield resultMessage;
                resultEmittedForTurn = true;
              }
            } else {
              if (!resultEmittedForTurn) {
                yield* flushPendingSubagentMessages();
                yield executionErrorResult(modelError);
                resultEmittedForTurn = true;
              }
            }
          } else {
            touchSessionState({
              status: 'idle',
              activeTurn: false,
              lastResultAt: new Date().toISOString(),
              idleReason: typeof prompt === 'string' ? 'turn_complete' : sessionIdleReason,
              lastError: undefined,
            });
            // Normal completion — yield the buffered result message.
            if (resultMessage && !resultEmittedForTurn) {
              yield* flushPendingSubagentMessages();
              yield resultMessage;
              resultEmittedForTurn = true;
            }
          }
          break; // normal completion
        }
      } else {
        // Multi-turn mode: consume user messages from the merged input queue.
        startSourcePromptPumpIfNeeded();
        let multiturnUsedFallback = false;
        while (true) {
          let userMsg: SDKUserMessage | typeof STREAM_DONE;
          try {
            userMsg = await readQueuedInput();
          } catch (sourceErr) {
            const error = sourceErr instanceof Error ? sourceErr : new Error(String(sourceErr));
            yield executionErrorResult(error);
            break;
          }
          if (userMsg === STREAM_DONE) break;
          const userPrompt = __internal_extractUserMessagePrompt(userMsg);
          if (userPrompt === undefined) continue;
          const preTurnMessages = loop.getMessages();
          let resultEmittedForTurn = false;

          let modelError: Error | undefined;
          let resultMessage: SDKMessage | undefined;
          touchSessionState({
            status: 'running',
            activeTurn: true,
            idleReason: undefined,
            lastError: undefined,
          });
          try {
            for await (const msg of loop.run(userPrompt)) {
              yield* flushPendingSubagentMessages();
              if (options.includePartialMessages !== true && msg.type === 'stream_event') {
                continue;
              }
              if (msg.type === 'result') {
                resultMessage = msg;
                continue;
              }
              yield msg;
              // Enforce maxBudgetUsd in multi-turn mode too.
              if (maxBudgetUsd !== undefined) {
                const { totalCostUsd } = loop.getTotalCost();
                if (totalCostUsd >= maxBudgetUsd) {
                  internalAbortController.abort();
                  yield {
                    type: 'result',
                    subtype: 'error_max_budget_usd',
                    duration_ms: 0,
                    duration_api_ms: 0,
                    is_error: true,
                    num_turns: loop.getTurnCount(),
                    stop_reason: 'max_budget_usd',
                    total_cost_usd: totalCostUsd,
                    usage: { input_tokens: 0, output_tokens: 0 },
                    modelUsage: {},
                    permission_denials: [],
                    errors: [`Budget limit exceeded: $${totalCostUsd.toFixed(4)} >= $${maxBudgetUsd}`],
                    uuid: randomUUID(),
                    session_id: sessionId,
                  };
                  return;
                }
              }
            }
          } catch (err) {
            modelError = err instanceof Error ? err : new Error(String(err));
          }
          yield* flushPendingSubagentMessages();

          // Check result for model error (same logic as single-turn).
          if (
            !modelError &&
            resultMessage &&
            (resultMessage as any).is_error === true &&
            (resultMessage as any).stop_reason === 'error'
          ) {
            const errText = ((resultMessage as any).errors as string[] | undefined)?.join(' ') ?? '';
            if (isModelError(new Error(errText))) {
              modelError = new Error(errText);
            }
          }

          if (modelError) {
            touchSessionState({
              status: 'failed',
              activeTurn: false,
              lastError: modelError.message,
            });
            if (options.fallbackModel && !multiturnUsedFallback && isModelError(modelError)) {
              multiturnUsedFallback = true;
              activeModel = options.fallbackModel;
              loop.setModel(options.fallbackModel);
              refreshManagedSystemPrompt();
              // Retry the same user message with the fallback model while
              // preserving conversation context accumulated before this turn.
              loop.resetMessages(preTurnMessages.length > 0 ? preTurnMessages : undefined);
              resultMessage = undefined;
              try {
                for await (const msg of loop.run(userPrompt)) {
                  yield* flushPendingSubagentMessages();
                  if (options.includePartialMessages !== true && msg.type === 'stream_event') continue;
                  if (msg.type === 'result') { resultMessage = msg; continue; }
                  yield msg;
                }
              } catch (retryErr) {
                modelError = retryErr instanceof Error ? retryErr : new Error(String(retryErr));
              }
              yield* flushPendingSubagentMessages();
            } else {
              if (resultMessage) {
                if (!resultEmittedForTurn) {
                  yield* flushPendingSubagentMessages();
                  yield resultMessage;
                  resultEmittedForTurn = true;
                }
                resultMessage = undefined;
              } else {
                if (!resultEmittedForTurn) {
                  yield executionErrorResult(modelError);
                  resultEmittedForTurn = true;
                }
              }
            }
          }
          if (modelError && !resultMessage && !resultEmittedForTurn) {
            yield* flushPendingSubagentMessages();
            yield executionErrorResult(modelError);
            resultEmittedForTurn = true;
          }
          if (resultMessage && !resultEmittedForTurn) {
            if (!modelError) {
              touchSessionState({
                status: 'idle',
                activeTurn: false,
                lastResultAt: new Date().toISOString(),
                idleReason: 'awaiting_input',
                lastError: undefined,
              });
            }
            yield* flushPendingSubagentMessages();
            yield resultMessage;
          }
        }
      }
    } finally {
      // Ensure the abort controller fires so any dangling HTTP requests or
      // child processes are cleaned up when the caller stops iterating early.
      abortQuery(false);
      cleanupQueryResources();
    }
  }

  const rawGen = generateMessages();
  let sessionPromptMetadataCaptured =
    typeof prompt === 'string' ||
    !sessionMgr ||
    (sessionExistedBeforeQuery && !options.forkSession);
  const gen = sessionMgr
    ? (async function* persistAndYield(): AsyncGenerator<SDKMessage, void> {
        try {
          for await (const msg of rawGen) {
            recordPromptSuggestionObservation(currentTurnObservation, msg);
            if (!sessionPromptMetadataCaptured && msg.type === 'user') {
              const promptText = extractUserPromptText(msg);
              if (promptText) {
                try {
                  sessionMgr.updateSession(
                    cwd,
                    sessionId,
                    buildPromptSessionMetadata(promptText, options.sessionTitle),
                    { touch: false },
                  );
                } catch {
                  // Non-fatal
                }
                sessionPromptMetadataCaptured = true;
              }
            }
            try {
              sessionMgr.appendToTranscript(cwd, sessionId, msg);
            } catch {
              // Non-fatal: never fail the request on transcript write errors.
            }
            yield msg;

            if (msg.type === 'result') {
              try {
                sessionMgr.updateSession(
                  cwd,
                  sessionId,
                  buildResultSessionMetadata(
                    sessionMgr.getSession(cwd, sessionId),
                    msg,
                  ),
                  { touch: false },
                );
              } catch {
                // Non-fatal
              }

              if (options.promptSuggestions === true) {
                const suggestions = __internal_buildPromptSuggestions({
                  result: msg,
                  observation: currentTurnObservation,
                  language: responseLanguage,
                });
                for (const suggestion of suggestions) {
                  const suggestionMessage: SDKMessage = {
                    ...suggestion,
                    uuid: randomUUID(),
                    session_id: sessionId,
                  };
                  try {
                    sessionMgr.appendToTranscript(cwd, sessionId, suggestionMessage);
                  } catch {
                    // Non-fatal
                  }
                  yield suggestionMessage;
                }
              }

              currentTurnObservation = createPromptSuggestionObservation();
            }
          }
        } finally {
          try {
            sessionMgr.touchSession(cwd, sessionId);
          } catch {
            // Non-fatal
          }
        }
      })()
    : (async function* withSuggestions(): AsyncGenerator<SDKMessage, void> {
        for await (const msg of rawGen) {
          recordPromptSuggestionObservation(currentTurnObservation, msg);
          yield msg;
          if (msg.type === 'result') {
            if (options.promptSuggestions === true) {
              const suggestions = __internal_buildPromptSuggestions({
                result: msg,
                observation: currentTurnObservation,
                language: responseLanguage,
              });
              for (const suggestion of suggestions) {
                yield {
                  ...suggestion,
                  uuid: randomUUID(),
                  session_id: sessionId,
                };
              }
            }
            currentTurnObservation = createPromptSuggestionObservation();
          }
        }
      })();

  // ------------------------------------------------------------------
  // Attach control methods to make the generator satisfy Query
  // ------------------------------------------------------------------
  const queryObj = gen as unknown as Query;
  (queryObj as Query & { __internal_getAppState?: () => AppState }).__internal_getAppState = () => appStore.getState();
  const finalizeGenerator = () => {
    const returnPromise = queryObj.return?.(undefined as any) as Promise<IteratorResult<SDKMessage, void>> | undefined;
    if (returnPromise) {
      void returnPromise.catch(() => {});
    }
  };

  const buildTaskDispatcherFollowUps = (
    event: Omit<SDKTaskDispatcherEvent, 'followUps'>,
  ): WorkerFollowUpSuggestion[] => {
    const isChinese = /中文|chinese|zh/i.test(responseLanguage ?? '');
    const build = (zh: string, en: string) => (isChinese ? zh : en);
    const followUps: WorkerFollowUpSuggestion[] = [];

    const buildStartAction = (): NonNullable<NonNullable<SDKPromptSuggestionMessage['scaffold']>['action']> => ({
      tool: 'TaskDispatcher',
      arguments: {
        action: 'start',
        dispatcher_id: event.dispatcherId,
        owner: event.owner,
        team_name: event.teamName,
        worker_type: event.workerType,
        poll_interval_ms: event.pollIntervalMs,
        lease_ms: event.leaseMs,
        max_concurrent_workers: event.maxConcurrentWorkers,
        ...(event.name ? { name: event.name } : {}),
        ...(event.prompt ? { prompt: event.prompt } : {}),
        ...(event.model ? { model: event.model } : {}),
        ...(event.maxTurns !== undefined ? { max_turns: event.maxTurns } : {}),
        ...(event.mode ? { mode: event.mode } : {}),
        ...(event.cwd ? { cwd: event.cwd } : {}),
        ...(event.isolation ? { isolation: event.isolation } : {}),
      },
    });

    const buildStopAction = (): NonNullable<NonNullable<SDKPromptSuggestionMessage['scaffold']>['action']> => ({
      tool: 'TaskDispatcher',
      arguments: {
        action: 'stop',
        dispatcher_id: event.dispatcherId,
      },
    });

    const buildRequeueAction = (): NonNullable<NonNullable<SDKPromptSuggestionMessage['scaffold']>['action']> | null => {
      if (!event.taskId || !event.workerId) {
        return null;
      }
      return {
        tool: 'TaskDispatcher',
        arguments: {
          action: 'requeue',
          dispatcher_id: event.dispatcherId,
          task_id: event.taskId,
          worker_id: event.workerId,
        },
      };
    };

    if (event.type === 'stopped' || event.type === 'task_requeued') {
      followUps.push({
        suggestion: build(
          `重新启动调度器 \`${event.dispatcherId}\`，继续处理 ${event.teamName} 队列`,
          `Restart dispatcher \`${event.dispatcherId}\` and continue draining the ${event.teamName} queue`,
        ),
        scaffold: {
          kind: 'generic_followup',
          title: build('恢复调度器', 'Resume dispatcher'),
          prompt: build(
            `恢复调度器 ${event.dispatcherId} 并继续处理队列`,
            `Resume dispatcher ${event.dispatcherId} and continue processing the queue`,
          ),
          action: buildStartAction(),
        },
      });
    }

    if (event.status === 'running' && (event.type === 'started' || event.type === 'dispatched' || event.type === 'task_completed')) {
      followUps.push({
        suggestion: build(
          `停止调度器 \`${event.dispatcherId}\`，阻止继续派发新任务`,
          `Stop dispatcher \`${event.dispatcherId}\` to prevent more tasks from being claimed`,
        ),
        scaffold: {
          kind: 'generic_followup',
          title: build('停止调度器', 'Stop dispatcher'),
          prompt: build(
            `停止调度器 ${event.dispatcherId}`,
            `Stop dispatcher ${event.dispatcherId}`,
          ),
          action: buildStopAction(),
        },
      });
    }

    if (event.type === 'dispatched') {
      const requeueAction = buildRequeueAction();
      if (requeueAction) {
        followUps.push({
          suggestion: build(
            `将任务 \`${event.taskId}\` 从 worker \`${event.workerId}\` 退回队列`,
            `Requeue task \`${event.taskId}\` from worker \`${event.workerId}\``,
          ),
          scaffold: {
            kind: 'generic_followup',
            title: build('退回当前派单', 'Requeue assignment'),
            prompt: build(
              `将任务 ${event.taskId} 从当前 worker 退回队列`,
              `Requeue task ${event.taskId} from its current worker`,
            ),
            action: requeueAction,
          },
        });
      }
    }

    return followUps;
  };

  const buildTaskDispatcherHealthFollowUps = (
    dispatcher: TaskDispatcherRecord,
    findings: TaskDispatcherHealthFinding[],
  ): WorkerFollowUpSuggestion[] => {
    const isChinese = /中文|chinese|zh/i.test(responseLanguage ?? '');
    const build = (zh: string, en: string) => (isChinese ? zh : en);
    const followUps: WorkerFollowUpSuggestion[] = [];
    const seenAssignments = new Set<string>();

    for (const finding of findings) {
      if (!finding.taskId || !finding.workerId) {
        continue;
      }
      const key = `${finding.taskId}:${finding.workerId}`;
      if (seenAssignments.has(key)) {
        continue;
      }
      seenAssignments.add(key);
      followUps.push({
        suggestion: build(
          `将卡住的派单 \`${finding.taskId}\` 从 worker \`${finding.workerId}\` 退回队列`,
          `Requeue stuck assignment \`${finding.taskId}\` from worker \`${finding.workerId}\``,
        ),
        scaffold: {
          kind: 'generic_followup',
          title: build('退回异常派单', 'Requeue assignment'),
          prompt: build(
            `将任务 ${finding.taskId} 从当前 worker 退回队列`,
            `Requeue task ${finding.taskId} from its current worker`,
          ),
          action: {
            tool: 'TaskDispatcher',
            arguments: {
              action: 'requeue',
              dispatcher_id: dispatcher.dispatcherId,
              task_id: finding.taskId,
              worker_id: finding.workerId,
            },
          },
        },
      });
    }

    if ((dispatcher.status === 'draining' || dispatcher.status === 'stopped') && findings.length > 0) {
      followUps.push({
        suggestion: build(
          `重新启动调度器 \`${dispatcher.dispatcherId}\`，恢复处理 ${dispatcher.teamName} 队列`,
          `Restart dispatcher \`${dispatcher.dispatcherId}\` for the ${dispatcher.teamName} queue`,
        ),
        scaffold: {
          kind: 'generic_followup',
          title: build('恢复调度器', 'Resume dispatcher'),
          prompt: build(
            `恢复调度器 ${dispatcher.dispatcherId}`,
            `Resume dispatcher ${dispatcher.dispatcherId}`,
          ),
          action: {
            tool: 'TaskDispatcher',
            arguments: {
              action: 'start',
              dispatcher_id: dispatcher.dispatcherId,
              owner: dispatcher.owner,
              team_name: dispatcher.teamName,
              worker_type: dispatcher.workerType,
              poll_interval_ms: dispatcher.pollIntervalMs,
              lease_ms: dispatcher.leaseMs,
              max_concurrent_workers: dispatcher.maxConcurrentWorkers,
            },
          },
        },
      });
    }

    return followUps;
  };

  const emitTaskDispatcherOrchestrationEvent = (
    state: TaskDispatcherState,
    type: SDKTaskDispatcherEvent['type'],
    overrides: Partial<Pick<SDKTaskDispatcherEvent, 'taskId' | 'workerId' | 'taskStatus' | 'timestamp'>> = {},
  ): void => {
    const eventTimestamp = overrides.timestamp ?? new Date().toISOString();
    state.record.updatedAt = eventTimestamp;
    const record = syncTaskDispatcherRecord(state);
    const rawBase: Omit<SDKTaskDispatcherEvent, 'followUps'> = {
      type,
      dispatcherId: record.dispatcherId,
      owner: record.owner,
      teamName: record.teamName,
      source: record.source,
      workerType: record.workerType,
      status: record.status,
      timestamp: eventTimestamp,
      pollIntervalMs: record.pollIntervalMs,
      leaseMs: record.leaseMs,
      maxConcurrentWorkers: record.maxConcurrentWorkers,
      ...(state.name ? { name: state.name } : {}),
      ...(state.prompt ? { prompt: state.prompt } : {}),
      ...(state.model ? { model: state.model } : {}),
      ...(state.maxTurns !== undefined ? { maxTurns: state.maxTurns } : {}),
      ...(state.mode ? { mode: state.mode } : {}),
      ...(state.cwd ? { cwd: state.cwd } : {}),
      ...(state.isolation ? { isolation: state.isolation } : {}),
      schedulerState: record.schedulerState,
      ...(record.lastBlockedReason ? { lastBlockedReason: record.lastBlockedReason } : {}),
      ...(record.lastBlockedAt ? { lastBlockedAt: record.lastBlockedAt } : {}),
      activeTaskIds: [...record.activeTaskIds],
      activeWorkerIds: [...record.activeWorkerIds],
      ...(overrides.taskId ? { taskId: overrides.taskId } : {}),
      ...(overrides.workerId ? { workerId: overrides.workerId } : {}),
      ...(overrides.taskStatus ? { taskStatus: overrides.taskStatus } : {}),
      activeAssignments: [...record.activeAssignments],
      startedAt: record.startedAt,
      updatedAt: record.updatedAt,
      ...(record.lastDispatchAt ? { lastDispatchAt: record.lastDispatchAt } : {}),
      ...(record.stoppedAt ? { stoppedAt: record.stoppedAt } : {}),
    };
    const raw: SDKTaskDispatcherEvent = {
      ...rawBase,
      followUps: buildTaskDispatcherFollowUps(rawBase),
    };
    const event: SDKOrchestrationEvent = {
      kind: 'task_dispatcher',
      sessionId,
      parentToolCallId: `sdk-dispatcher:${record.dispatcherId}`,
      dispatcherId: record.dispatcherId,
      ...(record.teamName ? { teamName: record.teamName } : {}),
      ...(raw.workerId ? { workerId: raw.workerId } : {}),
      ...(raw.taskId ? { taskId: raw.taskId } : {}),
      dispatcherEvent: raw,
      raw,
    };
    appendTimelineStoreItem(toTimelineOrchestrationItem(event));
    if (sessionMgr) {
      try {
        const transcriptMessage: PersistedTaskDispatcherEventMessage = {
          type: 'system',
          subtype: 'task_dispatcher_event',
          session_id: sessionId,
          dispatcher_id: record.dispatcherId,
          team_name: record.teamName,
          timestamp: raw.timestamp,
          event: JSON.parse(JSON.stringify(raw)),
        };
        sessionMgr.appendToTranscript(transcriptCwd, sessionId, transcriptMessage);
      } catch {
        // Non-fatal: never fail dispatcher orchestration on transcript write errors.
      }
    }
    for (const subscriber of orchestrationSubscribers) {
      subscriber.push(event);
    }
  };

  const syncTaskDispatcherRecord = (state: TaskDispatcherState): TaskDispatcherRecord => {
    state.record.name = state.name;
    state.record.prompt = state.prompt;
    state.record.model = state.model;
    state.record.maxTurns = state.maxTurns;
    state.record.mode = state.mode;
    state.record.cwd = state.cwd;
    state.record.isolation = state.isolation;
    const activeAssignments = [...state.activeAssignments.values()].map((assignment) => ({
      taskId: assignment.taskId,
      workerId: assignment.workerId,
      ...(assignment.claimedAt ? { claimedAt: assignment.claimedAt } : {}),
      ...(assignment.lastHeartbeatAt ? { lastHeartbeatAt: assignment.lastHeartbeatAt } : {}),
      ...(assignment.leaseExpiresAt ? { leaseExpiresAt: assignment.leaseExpiresAt } : {}),
      ...(assignment.attempts !== undefined ? { attempts: assignment.attempts } : {}),
    }));
    state.record.activeAssignments = activeAssignments;
    state.record.activeTaskIds = activeAssignments.map((assignment) => assignment.taskId);
    state.record.activeWorkerIds = activeAssignments.map((assignment) => assignment.workerId);
    upsertDispatcherStoreRecord(state.record);
    persistTaskDispatcherLedgerRecord(state.record);
    syncAppSchedulerControlPlane();
    return state.record;
  };

  const hydrateTaskDispatcherState = (record: TaskDispatcherRecord): TaskDispatcherState => {
    const clonedRecord = cloneTaskDispatcherRecord(record);
    const state: TaskDispatcherState = {
      record: {
        ...clonedRecord,
        source: 'live',
        schedulerState:
          clonedRecord.schedulerState
          ?? (clonedRecord.status === 'draining'
            ? 'draining'
            : clonedRecord.status === 'stopped'
              ? 'stopped'
              : 'idle'),
      },
      ...(clonedRecord.prompt ? { prompt: clonedRecord.prompt } : {}),
      ...(clonedRecord.name ? { name: clonedRecord.name } : {}),
      ...(clonedRecord.model ? { model: clonedRecord.model } : {}),
      ...(clonedRecord.maxTurns !== undefined ? { maxTurns: clonedRecord.maxTurns } : {}),
      ...(clonedRecord.mode ? { mode: clonedRecord.mode } : {}),
      ...(clonedRecord.cwd ? { cwd: clonedRecord.cwd } : {}),
      ...(clonedRecord.isolation ? { isolation: clonedRecord.isolation } : {}),
      timer: null,
      running: false,
      rerunRequested: false,
      disposed: false,
      activeAssignments: new Map(
        clonedRecord.activeAssignments.map((assignment) => [assignment.workerId, {
          taskId: assignment.taskId,
          workerId: assignment.workerId,
          ...(assignment.claimedAt ? { claimedAt: assignment.claimedAt } : {}),
          ...(assignment.lastHeartbeatAt ? { lastHeartbeatAt: assignment.lastHeartbeatAt } : {}),
          ...(assignment.leaseExpiresAt ? { leaseExpiresAt: assignment.leaseExpiresAt } : {}),
          ...(assignment.attempts !== undefined ? { attempts: assignment.attempts } : {}),
        }]),
      ),
    };
    for (const assignment of state.activeAssignments.values()) {
      taskDispatcherByWorkerId.set(assignment.workerId, {
        dispatcherId: state.record.dispatcherId,
        taskId: assignment.taskId,
      });
    }
    taskDispatchers.set(state.record.dispatcherId, state);
    syncTaskDispatcherRecord(state);
    return state;
  };

  const disposeTaskDispatcherState = (state: TaskDispatcherState): void => {
    state.disposed = true;
    state.running = false;
    state.rerunRequested = false;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    for (const assignment of state.activeAssignments.values()) {
      taskDispatcherByWorkerId.delete(assignment.workerId);
    }
    taskDispatchers.delete(state.record.dispatcherId);
    clearDispatcherFairnessCursorIfNeeded(state.record.dispatcherId);
    syncAppSchedulerControlPlane();
  };

  const ensureTaskDispatcherRecovery = async (): Promise<void> => {
    if (!taskDispatcherRecoveryPromise) {
      taskDispatcherRecoveryPromise = (async () => {
        if (!claimTaskSchedulerOwnership()) {
          syncAppSchedulerControlPlane();
          return;
        }
        const persisted = readPersistedTaskDispatcherRecords()
          .filter((record) => record.status === 'running' || record.status === 'draining');
        for (const record of persisted) {
          if (taskDispatchers.has(record.dispatcherId)) {
            continue;
          }
          if (!claimTaskDispatcherOwnership(record)) {
            continue;
          }
          const state = hydrateTaskDispatcherState({
            ...record,
            source: 'live',
            updatedAt: new Date().toISOString(),
          });
          scheduleTaskDispatcherRun(state, 0);
        }
        syncAppSchedulerControlPlane();
      })();
    }
    await taskDispatcherRecoveryPromise;
  };

  const markTaskDispatcherStopped = (state: TaskDispatcherState): TaskDispatcherRecord => {
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    state.running = false;
    state.rerunRequested = false;
    state.record.status = 'stopped';
    state.record.schedulerState = 'stopped';
    state.record.stoppedAt = state.record.stoppedAt ?? new Date().toISOString();
    touchTaskDispatcherRecord(state, state.record.stoppedAt);
    const record = syncTaskDispatcherRecord(state);
    releaseTaskDispatcherOwnership(state.record.dispatcherId);
    clearDispatcherFairnessCursorIfNeeded(state.record.dispatcherId);
    emitTaskDispatcherOrchestrationEvent(state, 'stopped', { timestamp: record.stoppedAt });
    return record;
  };

  const scheduleTaskDispatcherRun = (state: TaskDispatcherState, delayMs = state.record.pollIntervalMs): void => {
    if (state.disposed || state.record.status === 'stopped') {
      return;
    }
    if (state.running) {
      state.rerunRequested = true;
      return;
    }
    if (state.timer) {
      if (delayMs <= 0) {
        clearTimeout(state.timer);
        state.timer = null;
      } else {
        return;
      }
    }
    state.timer = setTimeout(() => {
      state.timer = null;
      void runTaskDispatcher(state);
    }, Math.max(0, delayMs));
  };

  const reconcileTaskDispatcherAssignment = async (
    state: TaskDispatcherState,
    workerId: string,
    status: 'pending' | 'completed',
  ): Promise<void> => {
    const assignment = state.activeAssignments.get(workerId);
    if (!assignment) {
      return;
    }

    state.activeAssignments.delete(workerId);
    taskDispatcherByWorkerId.delete(workerId);
    try {
      getTaskManager(state.record.teamName).releaseLease(
        assignment.taskId,
        state.record.owner,
        status,
      );
      const releasedTask = getTaskManager(state.record.teamName).get(assignment.taskId);
      if (releasedTask) {
        upsertTaskStoreRecord(toTaskRecord(releasedTask, state.record.teamName));
      }
    } catch {
      // Non-fatal — the task may already have been released manually.
    }
    syncTaskDispatcherRecord(state);
    emitTaskDispatcherOrchestrationEvent(
      state,
      status === 'completed' ? 'task_completed' : 'task_requeued',
      {
        taskId: assignment.taskId,
        workerId,
        taskStatus: status,
      },
    );
    if (state.record.status === 'draining' && state.activeAssignments.size === 0) {
      markTaskDispatcherStopped(state);
      return;
    }
    if (state.record.status === 'running') {
      wakeFairDispatchers();
    }
  };

  const runTaskDispatcher = async (state: TaskDispatcherState): Promise<void> => {
    if (state.disposed || state.record.status === 'stopped' || state.running) {
      return;
    }
    if (readTaskSchedulerOwnershipRecord()?.queryInstanceId === queryInstanceId) {
      if (refreshTaskSchedulerOwnership()) {
        syncAppSchedulerControlPlane();
      }
    }
    if (!refreshTaskDispatcherOwnership(state)) {
      disposeTaskDispatcherState(state);
      return;
    }

    state.running = true;
    let shouldContinueImmediately = false;
    try {
      const heartbeatNow = new Date();
      for (const assignment of [...state.activeAssignments.values()]) {
        try {
          const renewedTask = getTaskManager(state.record.teamName).heartbeat(
            assignment.taskId,
            state.record.owner,
            state.record.leaseMs,
            heartbeatNow,
          );
          upsertTaskStoreRecord(toTaskRecord(renewedTask, state.record.teamName));
          assignment.lastHeartbeatAt = heartbeatNow.toISOString();
          assignment.leaseExpiresAt = renewedTask.lease?.expiresAt;
          assignment.attempts = renewedTask.lease?.attempts;
        } catch {
          state.activeAssignments.delete(assignment.workerId);
          taskDispatcherByWorkerId.delete(assignment.workerId);
        }
      }
      syncTaskDispatcherRecord(state);

      if (state.record.status === 'draining') {
        if (setTaskDispatcherSchedulerState(state, 'draining')) {
          syncTaskDispatcherRecord(state);
        }
        if (state.activeAssignments.size === 0) {
          markTaskDispatcherStopped(state);
        }
        return;
      }

      if (!refreshTaskSchedulerOwnership()) {
        if (setTaskDispatcherSchedulerState(state, 'waiting_for_scheduler_owner', 'scheduler_owner')) {
          syncTaskDispatcherRecord(state);
        }
        syncAppSchedulerControlPlane();
        return;
      }

      const dispatcherCapacity = state.record.maxConcurrentWorkers - state.activeAssignments.size;
      const availableWorkerBudget = getAvailableDispatcherWorkerBudget();
      const availableTeamWorkerBudget = getAvailableDispatcherWorkerBudgetForTeam(state.record.teamName);
      const sharedCapacity = availableWorkerBudget === null
        ? dispatcherCapacity
        : Math.min(dispatcherCapacity, availableWorkerBudget);
      const boundedCapacity = availableTeamWorkerBudget === null
        ? sharedCapacity
        : Math.min(sharedCapacity, availableTeamWorkerBudget);
      const dispatchLimit = countSchedulableDispatchers() > 1
        ? Math.min(boundedCapacity, 1)
        : boundedCapacity;
      if (dispatchLimit <= 0) {
        const schedulingState = availableTeamWorkerBudget !== null && availableTeamWorkerBudget <= 0
          ? 'waiting_for_team_worker_budget'
          : availableWorkerBudget !== null && availableWorkerBudget <= 0
            ? 'waiting_for_global_worker_budget'
            : state.activeAssignments.size > 0
              ? 'dispatching'
              : 'idle';
        const blockReason = schedulingState === 'waiting_for_team_worker_budget'
          ? 'team_worker_budget'
          : schedulingState === 'waiting_for_global_worker_budget'
            ? 'global_worker_budget'
            : undefined;
        if (setTaskDispatcherSchedulerState(state, schedulingState, blockReason)) {
          syncTaskDispatcherRecord(state);
        }
      }

      for (
        let dispatchedCount = 0;
        !state.disposed &&
        state.record.status === 'running' &&
        dispatchedCount < dispatchLimit;
        dispatchedCount += 1
      ) {
        if (!isDispatcherFairnessTurn(state)) {
          if (setTaskDispatcherSchedulerState(state, 'waiting_for_fair_turn', 'fairness_turn')) {
            syncTaskDispatcherRecord(state);
          }
          break;
        }
        if (!tryReserveDispatcherWorkerSlot(state.record.teamName)) {
          const remainingGlobalBudget = getAvailableDispatcherWorkerBudget();
          const remainingTeamBudget = getAvailableDispatcherWorkerBudgetForTeam(state.record.teamName);
          const schedulingState = remainingTeamBudget !== null && remainingTeamBudget <= 0
            ? 'waiting_for_team_worker_budget'
            : remainingGlobalBudget !== null && remainingGlobalBudget <= 0
              ? 'waiting_for_global_worker_budget'
              : 'idle';
          const blockReason = schedulingState === 'waiting_for_team_worker_budget'
            ? 'team_worker_budget'
            : schedulingState === 'waiting_for_global_worker_budget'
              ? 'global_worker_budget'
              : undefined;
          if (setTaskDispatcherSchedulerState(state, schedulingState, blockReason)) {
            syncTaskDispatcherRecord(state);
          }
          break;
        }
        let dispatched: Awaited<ReturnType<typeof queryObj.dispatchNextTask>> = null;
        try {
          dispatched = await queryObj.dispatchNextTask({
            owner: state.record.owner,
            teamName: state.record.teamName,
            leaseMs: state.record.leaseMs,
            workerType: state.record.workerType,
            ...(state.name ? { name: state.name } : {}),
            ...(state.prompt ? { prompt: state.prompt } : {}),
            ...(state.model ? { model: state.model } : {}),
            ...(state.maxTurns !== undefined ? { maxTurns: state.maxTurns } : {}),
            ...(state.mode ? { mode: state.mode } : {}),
            ...(state.cwd ? { cwd: state.cwd } : {}),
            ...(state.isolation ? { isolation: state.isolation } : {}),
          });
        } finally {
          releaseReservedDispatcherWorkerSlot(state.record.teamName);
        }
        if (!dispatched) {
          if (setTaskDispatcherSchedulerState(
            state,
            state.activeAssignments.size > 0 ? 'dispatching' : 'idle',
          )) {
            syncTaskDispatcherRecord(state);
          }
          break;
        }

        state.activeAssignments.set(dispatched.worker.workerId, {
          taskId: dispatched.task.id,
          workerId: dispatched.worker.workerId,
          claimedAt: dispatched.task.lease?.claimedAt,
          lastHeartbeatAt: dispatched.task.lease?.claimedAt,
          leaseExpiresAt: dispatched.task.lease?.expiresAt,
          attempts: dispatched.task.lease?.attempts,
        });
        taskDispatcherByWorkerId.set(dispatched.worker.workerId, {
          dispatcherId: state.record.dispatcherId,
          taskId: dispatched.task.id,
        });
        state.record.lastDispatchAt = new Date().toISOString();
        setTaskDispatcherSchedulerState(state, 'dispatching');
        syncTaskDispatcherRecord(state);
        emitTaskDispatcherOrchestrationEvent(state, 'dispatched', {
          taskId: dispatched.task.id,
          workerId: dispatched.worker.workerId,
          taskStatus: dispatched.task.status,
          timestamp: state.record.lastDispatchAt,
        });
        noteDispatcherFairnessDispatch(state);
        const remainingDispatcherCapacity = state.record.maxConcurrentWorkers - state.activeAssignments.size;
        const remainingWorkerBudget = getAvailableDispatcherWorkerBudget();
        const remainingTeamWorkerBudget = getAvailableDispatcherWorkerBudgetForTeam(state.record.teamName);
        shouldContinueImmediately = remainingDispatcherCapacity > 0
          && (remainingWorkerBudget === null || remainingWorkerBudget > 0)
          && (remainingTeamWorkerBudget === null || remainingTeamWorkerBudget > 0);
        if (shouldContinueImmediately) {
          wakeFairDispatchers();
        }
      }
    } finally {
      state.running = false;
      if (state.disposed || state.record.status === 'stopped') {
        return;
      }
      if (state.rerunRequested) {
        state.rerunRequested = false;
        scheduleTaskDispatcherRun(state, 0);
        return;
      }
      if (state.record.status === 'draining' && state.activeAssignments.size === 0) {
        markTaskDispatcherStopped(state);
        return;
      }
      if (shouldContinueImmediately) {
        scheduleTaskDispatcherRun(state, 0);
        return;
      }
      scheduleTaskDispatcherRun(state, state.record.pollIntervalMs);
    }
  };

  const handleTaskDispatcherOrchestrationEvent = (event: SDKOrchestrationEvent): void => {
    if (event.kind !== 'worker_lifecycle' || !event.workerId) {
      return;
    }

    const assignment = taskDispatcherByWorkerId.get(event.workerId);
    if (!assignment) {
      return;
    }

    const state = taskDispatchers.get(assignment.dispatcherId);
    if (!state) {
      taskDispatcherByWorkerId.delete(event.workerId);
      return;
    }

    const lifecycleType = event.lifecycle;
    if (lifecycleType === 'completed') {
      void reconcileTaskDispatcherAssignment(state, event.workerId, 'completed');
      return;
    }
    if (lifecycleType === 'failed' || lifecycleType === 'shutdown') {
      void reconcileTaskDispatcherAssignment(state, event.workerId, 'pending');
    }
  };

  function cleanupTaskDispatchers(releaseActiveTasks: boolean): void {
    for (const state of taskDispatchers.values()) {
      state.disposed = true;
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = null;
      }

      if (releaseActiveTasks) {
        for (const assignment of state.activeAssignments.values()) {
          taskDispatcherByWorkerId.delete(assignment.workerId);
          try {
            getTaskManager(state.record.teamName).releaseLease(
              assignment.taskId,
              state.record.owner,
              'pending',
            );
          } catch {
            // Non-fatal — tasks may already be released.
          }
        }
      }

      state.activeAssignments.clear();
      syncTaskDispatcherRecord(state);
      markTaskDispatcherStopped(state);
    }
  }

  queryObj.interrupt = async () => {
    touchSessionState({
      status: 'closed',
      activeTurn: false,
      idleReason: 'interrupted',
    });
    abortQuery(true);
    cleanupQueryResources();
    finalizeGenerator();
  };

  queryObj.getSessionState = async () => readSessionStateSnapshot();

  queryObj.setPermissionMode = async (mode) => {
    if (mode !== undefined) {
      if (mode === 'bypassPermissions' && options.allowDangerouslySkipPermissions !== true) {
        throw new Error(
          'permissionMode="bypassPermissions" requires allowDangerouslySkipPermissions=true',
        );
      }
      loop.setPermissionMode(mode);
      appStore.setState((prev) => syncSessionControlPlane(prev, {
        permissionMode: mode,
      }));
      try {
        sessionMgr?.updateSession(cwd, sessionId, { permissionMode: mode }, { touch: false });
      } catch {
        // Non-fatal
      }
    }
  };

  queryObj.setModel = async (newModel) => {
    if (newModel !== undefined) {
      if (typeof newModel !== 'string' || newModel.trim().length === 0) {
        throw new Error('setModel(model) requires a non-empty model string.');
      }
      activeModel = newModel;
      loop.setModel(newModel);
      appStore.setState((prev) => syncSessionControlPlane(prev, {
        model: newModel,
      }));
      refreshManagedSystemPrompt();
      try {
        sessionMgr?.updateSession(cwd, sessionId, { model: newModel }, { touch: false });
      } catch {
        // Non-fatal
      }
    }
  };

  queryObj.setMaxThinkingTokens = async (tokens) => {
    if (tokens !== null) {
      if (!Number.isFinite(tokens) || tokens <= 0) {
        throw new Error('setMaxThinkingTokens(maxThinkingTokens) requires a positive finite number or null.');
      }
      loop.setThinking({ type: 'enabled', budgetTokens: tokens });
      appStore.setState((prev) => syncSessionControlPlane(prev, {
        thinkingConfig: { type: 'enabled', budgetTokens: tokens },
      }));
    } else {
      loop.setThinking({ type: 'disabled' });
      appStore.setState((prev) => syncSessionControlPlane(prev, {
        thinkingConfig: { type: 'disabled' },
      }));
    }
  };

  queryObj.supportedCommands = async () => getDefaultSlashCommands(pluginRuntime.commands);

  queryObj.supportedAgents = async () => supportedAgentInfos.map((agent) => ({ ...agent }));

  queryObj.supportedSkills = async () => {
    await runtimeReadyPromise;
    return runtime.listSkills();
  };

  queryObj.readRuntimeControlPlane = async () => readRuntimeControlPlaneSnapshot();

  queryObj.listRuntimeDiagnostics = async (options?: RuntimeDiagnosticListOptions) => (
    readRuntimeControlPlaneSnapshot().runtime.diagnostics
      .filter((entry) => !options?.severity || entry.severity === options.severity)
      .filter((entry) => !options?.source || entry.source === options.source)
  );

  queryObj.readOrchestrationControlPlane = async (options?: OrchestrationControlPlaneOptions) => {
    await ensureTaskDispatcherRecovery();
    const teamName = normalizeOptionalString(options?.teamName);
    hydratePersistedOrchestrationLedgersIntoStore({ ...(teamName ? { teamName } : {}) });
    if (teamName) {
      await Promise.all([
        queryObj.listTasks({ teamName }),
        queryObj.listWorkers({ teamName }),
        queryObj.listTaskDispatchers({ teamName }),
        queryObj.listTaskDispatcherDiagnoses({ teamName }),
      ]);
    } else {
      await Promise.all([
        queryObj.listTasks(),
        queryObj.listWorkers(),
        queryObj.listTaskDispatchers(),
        queryObj.listTaskDispatcherDiagnoses(),
      ]);
    }
    return readOrchestrationControlPlaneSnapshot({ ...(teamName ? { teamName } : {}) });
  };

  queryObj.supportedModels = async () => provider.listModels();

  queryObj.getProviderCapabilities = async (requestedModel?: string): Promise<ProviderCapabilityRecord> => {
    const resolvedModel = normalizeOptionalString(requestedModel) ?? activeModel;
    const modelInfo = (await queryObj.supportedModels()).find((entry) => entry.value === resolvedModel);
    const providerCapabilities = provider.getCapabilities
      ? await provider.getCapabilities(resolvedModel)
      : null;
    return {
      provider: providerCapabilities?.provider ?? provider.name,
      model: providerCapabilities?.model ?? resolvedModel,
      thinkingMode: providerCapabilities?.thinking ?? ((modelInfo?.supportsThinking ?? provider.name === 'anthropic') ? 'native' : 'unsupported'),
      structuredOutputMode: providerCapabilities?.structuredOutput ?? ((modelInfo?.supportsStructuredOutput ?? provider.name !== 'ollama') ? 'native' : 'unsupported'),
      toolUseMode: providerCapabilities?.toolUse ?? 'native',
      serverToolsMode: providerCapabilities?.serverTools ?? ((modelInfo?.supportsServerTools ?? provider.name === 'anthropic') ? 'native' : 'unsupported'),
      supportsThinking: providerCapabilities
        ? providerCapabilities.thinking === 'native'
        : (modelInfo?.supportsThinking ?? provider.name === 'anthropic'),
      supportsAdaptiveThinking: providerCapabilities?.supportsAdaptiveThinking
        ?? modelInfo?.supportsAdaptiveThinking
        ?? provider.name === 'anthropic',
      supportsStructuredOutput: providerCapabilities
        ? providerCapabilities.structuredOutput === 'native'
        : (modelInfo?.supportsStructuredOutput ?? provider.name !== 'ollama'),
      supportsImages: modelInfo?.supportsImages ?? provider.name !== 'ollama',
      supportsServerTools: providerCapabilities
        ? providerCapabilities.serverTools === 'native'
        : (modelInfo?.supportsServerTools ?? provider.name === 'anthropic'),
      supportsEffort: modelInfo?.supportsEffort ?? provider.name === 'anthropic',
      supportedEffortLevels: [
        ...(providerCapabilities?.supportedEffortLevels ?? modelInfo?.supportedEffortLevels ?? []),
      ],
    };
  };

  queryObj.supportsThinking = async (requestedModel?: string) => (
    (await queryObj.getProviderCapabilities(requestedModel)).supportsThinking
  );

  queryObj.supportsStructuredOutput = async (requestedModel?: string) => (
    (await queryObj.getProviderCapabilities(requestedModel)).supportsStructuredOutput
  );

  queryObj.mcpServerStatus = async () => {
    return runtime.listMcpServerStatus().map((conn) => ({
      name: conn.name,
      status: mapMcpStatus(conn.status),
      ...(conn.serverInfo ? { serverInfo: { ...conn.serverInfo } } : {}),
      ...(conn.error ? { error: conn.error } : {}),
      config: sanitizeMcpStatusConfig(conn.config),
      tools: conn.tools.map((t) => ({
        name: t.name,
        ...(t.description ? { description: t.description } : {}),
        ...(t.annotations ? { annotations: { ...t.annotations } } : {}),
      })),
    }));
  };

  queryObj.accountInfo = async (): Promise<AccountInfo> => ({
    tokenSource: provider.name,
    apiKeySource,
    organization: provider.name,
  });

  queryObj.initializationResult = async () => {
    await runtimeReadyPromise;
    // If MCP tools are still loading, wait for them so the snapshot is complete.
    if (mcpReadyPromise) {
      await mcpReadyPromise;
    }
    const runtimeSnapshot = runtime.buildSnapshot();
    const [commands, models, account, agents, skills] = await Promise.all([
      queryObj.supportedCommands(),
      queryObj.supportedModels(),
      queryObj.accountInfo(),
      queryObj.supportedAgents(),
      queryObj.supportedSkills(),
    ]);
    return {
      commands,
      agents,
      skills,
      output_style: outputStyle,
      available_output_styles: ['text', 'stream-json'],
      models,
      account,
      capability_snapshot: runtimeSnapshot.capabilitySnapshot,
      fast_mode_state: undefined,
    };
  };

  queryObj.sessionInfo = async () => {
    if (!sessionMgr) return null;
    const info = sessionMgr.getSession(cwd, sessionId);
    return info ? JSON.parse(JSON.stringify(info)) : null;
  };

  queryObj.listTeams = async () => sdkTeamManager.listTeams()
    .map((name) => sdkTeamManager.getTeam(name))
    .filter((config): config is TeamConfig => Boolean(config))
    .map((config) => toTeamRecord(config));

  queryObj.getTeam = async (name: string) => {
    const team = sdkTeamManager.getTeam(name);
    return team ? toTeamRecord(team) : null;
  };

  queryObj.createTeam = async (input: TeamCreateInput) => {
    const team = sdkTeamManager.createTeam(input.name, input.description);
    getTaskManager(team.name);
    if (input.setActive !== false) {
      activeTeamName = team.name;
      appStore.setState((prev) => setActiveTeamControlPlane(prev, activeTeamName));
    }
    return toTeamRecord(team);
  };

  queryObj.deleteTeam = async (name: string) => {
    const existed = sdkTeamManager.getTeam(name) !== null;
    sdkTeamManager.deleteTeam(name);
    rmSync(join(cwd, '.open-agent', 'tasks', name), { recursive: true, force: true });
    appStore.setState((prev) => ({
      ...prev,
      dispatchers: Object.fromEntries(
        Object.entries(prev.dispatchers).filter(([, dispatcher]) => dispatcher.teamName !== name),
      ),
      timeline: prev.timeline.filter((item) => item.payload == null || (item.payload as { teamName?: string }).teamName !== name),
      inboxes: Object.fromEntries(
        Object.entries(prev.inboxes).filter(([teamName]) => teamName !== name),
      ),
      approvals: Object.fromEntries(
        Object.entries(prev.approvals).filter(([teamName]) => teamName !== name),
      ),
    }));
    if (activeTeamName === name) {
      activeTeamName = null;
      appStore.setState((prev) => setActiveTeamControlPlane(prev, activeTeamName));
    }
    return { success: existed };
  };

  queryObj.getActiveTeam = async () => {
    if (!activeTeamName) {
      return null;
    }
    const team = sdkTeamManager.getTeam(activeTeamName);
    return team ? toTeamRecord(team) : null;
  };

  queryObj.setActiveTeam = async (name: string | null) => {
    if (name === null) {
      activeTeamName = null;
      appStore.setState((prev) => setActiveTeamControlPlane(prev, activeTeamName));
      return null;
    }
    const team = sdkTeamManager.getTeam(name);
    if (!team) {
      throw new Error(`Team not found: ${name}`);
    }
    activeTeamName = name;
    appStore.setState((prev) => setActiveTeamControlPlane(prev, activeTeamName));
    return toTeamRecord(team);
  };

  queryObj.sendTeamMessage = async (input: TeamMessageInput) => {
    const teamName = resolveTeamName(input.teamName);
    const requestId = input.requestId
      ?? ((input.type === 'shutdown_request' || input.type === 'plan_approval_request') ? randomUUID() : undefined);
    const message: TeamMessage = {
      type: input.type,
      from: input.from ?? 'sdk',
      ...(input.recipient ? { to: input.recipient } : {}),
      content: input.content ?? '',
      ...(input.summary ? { summary: input.summary } : {}),
      timestamp: new Date().toISOString(),
      ...(requestId ? { requestId } : {}),
      ...(typeof input.approve === 'boolean' ? { approve: input.approve } : {}),
    };
    sdkTeamManager.sendMessage(teamName, message);
    const syncedRecords = resolveTeamMessageSyncTargets(teamName, message)
      .flatMap((memberName) => syncTeamInboxMemberSnapshot(teamName, memberName));
    return findMatchingSyncedTeamMessage(syncedRecords, message) ?? toTeamMessageRecord(teamName, message);
  };

  queryObj.readTeamInbox = async (options: TeamInboxOptions) => {
    const teamName = resolveTeamName(options?.teamName);
    const useStoreOnly = options?.consume === false && options?.acknowledge !== true;
    if (useStoreOnly) {
      syncTeamInboxMemberSnapshot(teamName, options.memberName);
      return readTeamInboxFromStore(teamName, options.memberName, {
        unreadOnly: options?.unreadOnly,
        after: options?.after,
        limit: options?.limit,
      });
    }
    const entries = sdkTeamManager.readInboxEntries(teamName, options.memberName, {
      consume: options?.consume !== false,
      acknowledge: options?.acknowledge,
      unreadOnly: options?.unreadOnly,
      after: options?.after,
      limit: options?.limit,
    });
    const records = entries.map((entry) => toTeamMessageRecord(teamName, entry.message, entry));
    appendTimelineStoreItems(records.map((entry) => toTimelineTeamMessage(entry)));
    syncTeamInboxMemberSnapshot(teamName, options.memberName);
    return records;
  };

  queryObj.acknowledgeTeamInbox = async (input: TeamInboxAcknowledgeInput) => {
    const teamName = resolveTeamName(input?.teamName);
    const acknowledged = sdkTeamManager.acknowledgeInboxMessages(teamName, input.memberName, input.messageIds);
    syncTeamInboxMemberSnapshot(teamName, input.memberName);
    return {
      acknowledged,
    };
  };

  queryObj.listPendingTeamApprovals = async (options: TeamApprovalListOptions) => {
    const teamName = resolveTeamName(options?.teamName);
    syncTeamInboxMemberSnapshot(teamName, options.memberName);
    const approvals = appStore.getState().approvals[teamName]?.[options.memberName] ?? [];
    return approvals
      .filter((entry) => !options?.unreadOnly || !entry.readAt)
      .filter((entry) => !options?.after || entry.messageId > options.after)
      .slice(0, options?.limit ?? Number.POSITIVE_INFINITY)
      .map((entry) => ({ ...entry }));
  };

  queryObj.respondToTeamApproval = async (
    input: TeamApprovalResponseInput,
  ): Promise<TeamApprovalResponseResult> => {
    const teamName = resolveTeamName(input?.teamName);
    const entries = sdkTeamManager.readInboxEntries(teamName, input.memberName, {
      consume: false,
    });
    const matchedEntry = entries.find((entry) => (
      (input.messageId && entry.id === input.messageId)
      || (input.requestId && entry.message.requestId === input.requestId)
    ));
    if (!matchedEntry) {
      throw new Error(
        `Pending team approval not found for member "${input.memberName}" in team "${teamName}".`,
      );
    }
    const request = toTeamApprovalRecord(teamName, input.memberName, matchedEntry);
    if (!request) {
      throw new Error(
        `Inbox entry "${matchedEntry.id}" is not a pending approval request.`,
      );
    }

    const responseMessage: TeamMessage = {
      type: getTeamApprovalResponseType(request.requestType),
      from: input.from ?? input.memberName,
      to: request.from,
      content: input.feedback ?? '',
      ...(input.feedback ? { summary: summarizePlainText(input.feedback) } : {}),
      timestamp: new Date().toISOString(),
      requestId: request.requestId,
      approve: input.approve,
    };
    sdkTeamManager.sendMessage(teamName, responseMessage);
    const acknowledged = input.acknowledge === false || !matchedEntry.id
      ? 0
      : sdkTeamManager.acknowledgeInboxMessages(teamName, input.memberName, [matchedEntry.id]);
    syncTeamInboxMemberSnapshot(teamName, input.memberName);
    const responseInboxRecords = responseMessage.to
      ? syncTeamInboxMemberSnapshot(teamName, responseMessage.to)
      : [];
    const responseRecord = findMatchingSyncedTeamMessage(responseInboxRecords, responseMessage)
      ?? toTeamMessageRecord(teamName, responseMessage);

    return {
      acknowledged,
      request,
      response: responseRecord,
    };
  };

  queryObj.getTeamInboxCount = async (memberName: string, options?: { teamName?: string }) => {
    const teamName = resolveTeamName(options?.teamName);
    syncTeamInboxMemberSnapshot(teamName, memberName);
    return appStore.getState().inboxes[teamName]?.[memberName]?.unreadCount ?? 0;
  };

  queryObj.readTimelineInbox = async (options: TimelineInboxOptions = {}) => {
    const items: SDKTimelineItem[] = [];
    let transcriptEntries: unknown[] = [];
    hydratePersistedOrchestrationTimelineIntoStore({
      teamName: options.teamName,
      includeOrchestration: options.includeOrchestration === true,
      includeTaskNotifications: options.includeTaskNotifications !== false,
    });
    if (sessionMgr && (options.includeTaskNotifications !== false || options.includeOrchestration === true)) {
      try {
        transcriptEntries = sessionMgr.readTranscript(transcriptCwd, sessionId);
      } catch {
        transcriptEntries = [];
      }
    }
    if (options.includeTeamMessages !== false && options.memberName) {
      const messages = await queryObj.readTeamInbox({
        teamName: options.teamName,
        memberName: options.memberName,
        consume: options.consume,
        acknowledge: options.acknowledge,
        unreadOnly: options.unreadOnly,
        after: options.after,
        limit: options.limit,
      });
      items.push(...messages.map((message) => toTimelineTeamMessage(message)));
    }
    if (options.includeOrchestration === true) {
      items.push(
        ...readTimelineStoreItems(options.teamName)
          .filter((item) => item.kind !== 'team_message' && item.kind !== 'task_notification')
          .filter((item) => !options.after || (item.cursor ?? item.timestamp) > options.after)
          .slice(0, options.limit ?? Number.POSITIVE_INFINITY),
      );
      items.push(
        ...extractTimelineDispatcherEventsFromTranscriptEntries(
          transcriptEntries,
          options.orchestrationTypes,
        )
          .filter((event) => !options.teamName || event.teamName === options.teamName)
          .map((event) => toTimelineOrchestrationItem(event))
          .filter((item) => !options.after || (item.cursor ?? item.timestamp) > options.after)
          .slice(0, options.limit ?? Number.POSITIVE_INFINITY),
      );
    }
    if (options.includeTaskNotifications !== false) {
      const taskNotificationItems = [
        ...readTimelineStoreItems(options.teamName)
          .filter((item) => item.kind === 'task_notification')
          .filter((item) => !options.after || (item.cursor ?? item.timestamp) > options.after)
          .slice(0, options.limit ?? Number.POSITIVE_INFINITY),
        ...collectTimelineTaskNotifications(options.teamName, transcriptEntries)
          .map((message) => toTimelineTaskNotification(message))
          .filter((item) => !options.after || (item.cursor ?? item.timestamp) > options.after)
          .slice(0, options.limit ?? Number.POSITIVE_INFINITY),
      ];
      appendTimelineStoreItems(taskNotificationItems, { persist: false });
      items.push(...taskNotificationItems);
    }
    return sortTimelineItems(dedupeTimelineItems(items));
  };

  queryObj.subscribeOrchestrationEvents = (
    subscriptionOptions: SubscribeOrchestrationEventsOptions = {},
  ): AsyncIterable<SDKOrchestrationEvent> => {
    const queue: SDKOrchestrationEvent[] = [];
    const eventTypes = subscriptionOptions.types?.length
      ? new Set(subscriptionOptions.types)
      : null;
    const teamFilter = normalizeOptionalString(subscriptionOptions.teamName);
    let closed = false;
    let queueNotifier: (() => void) | null = null;

    const notify = () => {
      if (queueNotifier) {
        const resolve = queueNotifier;
        queueNotifier = null;
        resolve();
      }
    };

    const subscriber = {
      push(event: SDKOrchestrationEvent) {
        if (closed) return;
        if (eventTypes && !eventTypes.has(event.kind)) return;
        if (teamFilter && event.teamName !== teamFilter) return;
        queue.push(cloneOrchestrationEvent(event));
        notify();
      },
      close() {
        if (closed) return;
        closed = true;
        orchestrationSubscribers.delete(subscriber);
        if (subscriptionOptions.signal) {
          subscriptionOptions.signal.removeEventListener('abort', abortListener);
        }
        notify();
      },
    };

    const abortListener = () => {
      subscriber.close();
    };

    if (subscriptionOptions.signal?.aborted) {
      subscriber.close();
    } else {
      orchestrationSubscribers.add(subscriber);
      subscriptionOptions.signal?.addEventListener('abort', abortListener, { once: true });
    }

    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      async next() {
        while (queue.length === 0) {
          if (closed) {
            return { done: true, value: undefined };
          }
          await new Promise<void>((resolve) => {
            queueNotifier = resolve;
          });
        }
        return { done: false, value: queue.shift()! };
      },
      async return() {
        subscriber.close();
        return { done: true, value: undefined };
      },
    };
  };

  queryObj.subscribeTimeline = (
    subscriptionOptions: SubscribeTimelineOptions = {},
  ): AsyncIterable<SDKTimelineItem> => {
    const queue: SDKTimelineItem[] = [];
    const teamSeen = new Set<string>();
    const includeTeamMessages = subscriptionOptions.includeTeamMessages !== false;
    const includeOrchestration = subscriptionOptions.includeOrchestration !== false;
    const includeTaskNotifications = subscriptionOptions.includeTaskNotifications !== false;
    const pollIntervalMs = Math.max(25, subscriptionOptions.pollIntervalMs ?? 250);
    let closed = false;
    let queueNotifier: (() => void) | null = null;
    let teamPollInFlight = false;
    let teamPollTimer: ReturnType<typeof setInterval> | null = null;
    let orchestrationIterator: AsyncIterator<SDKOrchestrationEvent> | null = null;

    const notify = () => {
      if (queueNotifier) {
        const resolve = queueNotifier;
        queueNotifier = null;
        resolve();
      }
    };

    const push = (item: SDKTimelineItem) => {
      if (closed) return;
      queue.push(cloneTimelineItem(item));
      notify();
    };

    const pollTeamInbox = async () => {
      if (!includeTeamMessages || !subscriptionOptions.memberName || teamPollInFlight || closed) {
        return;
      }
      teamPollInFlight = true;
      try {
        const teamMessages = await queryObj.readTeamInbox({
          teamName: subscriptionOptions.teamName,
          memberName: subscriptionOptions.memberName,
          consume: subscriptionOptions.consume,
          acknowledge: subscriptionOptions.acknowledge,
          unreadOnly: subscriptionOptions.unreadOnly,
          after: subscriptionOptions.after,
          limit: subscriptionOptions.limit,
        });
        for (const message of teamMessages) {
          const fingerprint = message.messageId ?? buildTimelineTeamMessageFingerprint(message);
          if (subscriptionOptions.consume === true || !teamSeen.has(fingerprint)) {
            teamSeen.add(fingerprint);
            push(toTimelineTeamMessage(message));
          }
        }
      } finally {
        teamPollInFlight = false;
      }
    };

    const close = async () => {
      if (closed) return;
      closed = true;
      if (teamPollTimer) {
        clearInterval(teamPollTimer);
        teamPollTimer = null;
      }
      if (subscriptionOptions.signal) {
        subscriptionOptions.signal.removeEventListener('abort', abortListener);
      }
      if (orchestrationIterator?.return) {
        await orchestrationIterator.return();
      }
      notify();
    };

    const abortListener = () => {
      void close();
    };

    if (subscriptionOptions.signal?.aborted) {
      void close();
    } else {
      if (includeTeamMessages && subscriptionOptions.memberName) {
        void pollTeamInbox();
        teamPollTimer = setInterval(() => {
          void pollTeamInbox();
        }, pollIntervalMs);
      }

      if (includeOrchestration || includeTaskNotifications) {
        orchestrationIterator = queryObj.subscribeOrchestrationEvents({
          teamName: subscriptionOptions.teamName,
          types: includeOrchestration
            ? subscriptionOptions.orchestrationTypes
            : ['worker_lifecycle'],
        })[Symbol.asyncIterator]();
        void (async () => {
          while (!closed && orchestrationIterator) {
            const next = await orchestrationIterator.next();
            if (next.done || closed) {
              break;
            }
            if (includeOrchestration) {
              push(toTimelineOrchestrationItem(next.value));
            }
            if (includeTaskNotifications) {
              const taskNotification = buildTimelineTaskNotificationFromOrchestrationEvent(
                next.value,
                responseLanguage,
              );
              if (taskNotification) {
                push(taskNotification);
              }
            }
          }
        })();
      }

      subscriptionOptions.signal?.addEventListener('abort', abortListener, { once: true });
    }

    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      async next() {
        while (queue.length === 0) {
          if (closed) {
            return { done: true, value: undefined };
          }
          await new Promise<void>((resolve) => {
            queueNotifier = resolve;
          });
        }
        return { done: false, value: queue.shift()! };
      },
      async return() {
        await close();
        return { done: true, value: undefined };
      },
    };
  };

  const collectTimelineTaskNotifications = (
    teamName?: string,
    transcriptEntriesOverride?: unknown[],
  ): SDKTaskNotificationMessage[] => {
    const persistedAgentExecutor = sdkAgentExecutor ?? new AgentExecutor();
    let transcriptEntries: unknown[] = transcriptEntriesOverride ?? [];
    if (!transcriptEntriesOverride && sessionMgr) {
      try {
        transcriptEntries = sessionMgr.readTranscript(transcriptCwd, sessionId);
      } catch {
        transcriptEntries = [];
      }
    }

    const collected = [
      ...extractTimelineTaskNotificationsFromTranscriptEntries(transcriptEntries),
      ...__internal_collectPendingTaskNotifications({
        sessionId,
        transcriptEntries,
        childSessions: persistedAgentExecutor.listPersistedAgents(),
      }),
    ];

    const filteredTeamName = normalizeOptionalString(teamName);
    const deduped = new Map<string, SDKTaskNotificationMessage>();
    for (const notification of collected) {
      if (filteredTeamName && notification.team_name !== filteredTeamName) {
        continue;
      }
      const fingerprint = buildTaskNotificationFingerprint(notification)
        ?? `${notification.task_id}::${notification.status}::${notification.completed_at ?? ''}`;
      deduped.set(fingerprint, cloneTaskNotificationMessage(notification));
    }

    return [...deduped.values()].sort((left, right) =>
      compareTimelineTimestamps(left.completed_at, right.completed_at),
    );
  };

  queryObj.executeFollowUp = async (followUp: FollowUpExecutable): Promise<FollowUpExecutionResult> => {
    const scaffold = resolveFollowUpScaffold(followUp);
    if (!scaffold?.action) {
      throw new Error('Follow-up scaffold is missing an executable action.');
    }

    const action = scaffold.action;
    if (action.tool === 'Task') {
      const prompt = normalizeOptionalString(action.arguments['prompt']);
      if (!prompt) {
        throw new Error('Task follow-up action is missing a prompt.');
      }
      const subagentType = normalizeOptionalString(action.arguments['subagent_type']) ?? 'worker';
      const input = {
        prompt,
        ...(normalizeOptionalString(action.arguments['name']) ? { name: normalizeOptionalString(action.arguments['name']) } : {}),
        ...(normalizeOptionalString(action.arguments['team_name']) ? { teamName: normalizeOptionalString(action.arguments['team_name']) } : {}),
        ...(normalizeOptionalString(action.arguments['model']) ? { model: normalizeOptionalString(action.arguments['model']) } : {}),
        ...(normalizeOptionalString(action.arguments['mode']) ? { mode: normalizeOptionalString(action.arguments['mode']) } : {}),
        ...(normalizeOptionalString(action.arguments['cwd']) ? { cwd: normalizeOptionalString(action.arguments['cwd']) } : {}),
        ...(action.arguments['isolation'] === 'worktree' ? { isolation: 'worktree' as const } : {}),
        ...(normalizeIntegerField(action.arguments['max_turns']) !== undefined
          ? { maxTurns: normalizeIntegerField(action.arguments['max_turns'])! }
          : {}),
      };
      const resumeTaskId = normalizeOptionalString(action.arguments['resume']);

      if (subagentType === 'verifier') {
        return {
          kind: 'worker',
          followUpKind: scaffold.kind,
          worker: await queryObj.launchVerifier(input),
        };
      }
      if (subagentType !== 'worker') {
        throw new Error(`Unsupported Task follow-up subagent_type: ${subagentType}`);
      }
      return {
        kind: 'worker',
        followUpKind: scaffold.kind,
        worker: resumeTaskId
          ? await queryObj.resumeWorker(resumeTaskId, input)
          : await queryObj.launchWorker(input),
      };
    }

    if (action.tool === 'SendMessage') {
      const recipient = normalizeOptionalString(action.arguments['recipient'])
        ?? normalizeOptionalString(action.arguments['to']);
      if (!recipient) {
        throw new Error('SendMessage follow-up action is missing a recipient.');
      }
      return {
        kind: 'team_message',
        followUpKind: scaffold.kind,
        teamMessage: await queryObj.sendTeamMessage({
          ...(normalizeOptionalString(action.arguments['team_name']) ? { teamName: normalizeOptionalString(action.arguments['team_name']) } : {}),
          type: normalizeTimelineMessageType(action.arguments['type']) ?? 'message',
          ...(normalizeOptionalString(action.arguments['from']) ? { from: normalizeOptionalString(action.arguments['from']) } : {}),
          recipient,
          ...(normalizeOptionalString(action.arguments['content']) ? { content: normalizeOptionalString(action.arguments['content']) } : {}),
          ...(normalizeOptionalString(action.arguments['summary']) ? { summary: normalizeOptionalString(action.arguments['summary']) } : {}),
          ...(typeof action.arguments['approve'] === 'boolean' ? { approve: action.arguments['approve'] } : {}),
          ...(normalizeOptionalString(action.arguments['requestId']) ? { requestId: normalizeOptionalString(action.arguments['requestId']) } : {}),
        }),
      };
    }

    if (action.tool === 'TaskDispatcher') {
      const dispatcherAction = normalizeOptionalString(action.arguments['action']);
      if (!dispatcherAction) {
        throw new Error('TaskDispatcher follow-up action is missing an action.');
      }

      if (dispatcherAction === 'start') {
        const owner = normalizeOptionalString(action.arguments['owner']);
        if (!owner) {
          throw new Error('TaskDispatcher start follow-up action is missing an owner.');
        }
        const dispatcherId = normalizeOptionalString(action.arguments['dispatcher_id']);
        const dispatcher = dispatcherId
          ? await queryObj.resumeTaskDispatcher(dispatcherId) ?? await queryObj.startTaskDispatcher({
              owner,
              dispatcherId,
              ...(normalizeOptionalString(action.arguments['team_name']) ? { teamName: normalizeOptionalString(action.arguments['team_name']) } : {}),
              ...(normalizeOptionalString(action.arguments['worker_type']) === 'verifier' ? { workerType: 'verifier' as const } : {}),
              ...(normalizeOptionalString(action.arguments['name']) ? { name: normalizeOptionalString(action.arguments['name']) } : {}),
              ...(normalizeOptionalString(action.arguments['prompt']) ? { prompt: normalizeOptionalString(action.arguments['prompt']) } : {}),
              ...(normalizeOptionalString(action.arguments['model']) ? { model: normalizeOptionalString(action.arguments['model']) } : {}),
              ...(normalizeOptionalString(action.arguments['mode']) ? { mode: normalizeOptionalString(action.arguments['mode']) } : {}),
              ...(normalizeOptionalString(action.arguments['cwd']) ? { cwd: normalizeOptionalString(action.arguments['cwd']) } : {}),
              ...(action.arguments['isolation'] === 'worktree' ? { isolation: 'worktree' as const } : {}),
              ...(normalizeIntegerField(action.arguments['max_turns']) !== undefined
                ? { maxTurns: normalizeIntegerField(action.arguments['max_turns'])! }
                : {}),
              ...(normalizeIntegerField(action.arguments['poll_interval_ms']) !== undefined
                ? { pollIntervalMs: normalizeIntegerField(action.arguments['poll_interval_ms'])! }
                : {}),
              ...(normalizeIntegerField(action.arguments['lease_ms']) !== undefined
                ? { leaseMs: normalizeIntegerField(action.arguments['lease_ms'])! }
                : {}),
              ...(normalizeIntegerField(action.arguments['max_concurrent_workers']) !== undefined
                ? { maxConcurrentWorkers: normalizeIntegerField(action.arguments['max_concurrent_workers'])! }
                : {}),
            })
          : await queryObj.startTaskDispatcher({
              owner,
              ...(normalizeOptionalString(action.arguments['team_name']) ? { teamName: normalizeOptionalString(action.arguments['team_name']) } : {}),
              ...(normalizeOptionalString(action.arguments['worker_type']) === 'verifier' ? { workerType: 'verifier' as const } : {}),
              ...(normalizeOptionalString(action.arguments['name']) ? { name: normalizeOptionalString(action.arguments['name']) } : {}),
              ...(normalizeOptionalString(action.arguments['prompt']) ? { prompt: normalizeOptionalString(action.arguments['prompt']) } : {}),
              ...(normalizeOptionalString(action.arguments['model']) ? { model: normalizeOptionalString(action.arguments['model']) } : {}),
              ...(normalizeOptionalString(action.arguments['mode']) ? { mode: normalizeOptionalString(action.arguments['mode']) } : {}),
              ...(normalizeOptionalString(action.arguments['cwd']) ? { cwd: normalizeOptionalString(action.arguments['cwd']) } : {}),
              ...(action.arguments['isolation'] === 'worktree' ? { isolation: 'worktree' as const } : {}),
              ...(normalizeIntegerField(action.arguments['max_turns']) !== undefined
                ? { maxTurns: normalizeIntegerField(action.arguments['max_turns'])! }
                : {}),
              ...(normalizeIntegerField(action.arguments['poll_interval_ms']) !== undefined
                ? { pollIntervalMs: normalizeIntegerField(action.arguments['poll_interval_ms'])! }
                : {}),
              ...(normalizeIntegerField(action.arguments['lease_ms']) !== undefined
                ? { leaseMs: normalizeIntegerField(action.arguments['lease_ms'])! }
                : {}),
              ...(normalizeIntegerField(action.arguments['max_concurrent_workers']) !== undefined
                ? { maxConcurrentWorkers: normalizeIntegerField(action.arguments['max_concurrent_workers'])! }
                : {}),
            });
        return {
          kind: 'task_dispatcher',
          followUpKind: scaffold.kind,
          dispatcher,
        };
      }

      if (dispatcherAction === 'stop') {
        const dispatcherId = normalizeOptionalString(action.arguments['dispatcher_id']);
        if (!dispatcherId) {
          throw new Error('TaskDispatcher stop follow-up action is missing a dispatcher_id.');
        }
        const dispatcherStop = await queryObj.stopTaskDispatcher(dispatcherId);
        return {
          kind: 'task_dispatcher',
          followUpKind: scaffold.kind,
          ...(dispatcherStop.dispatcher ? { dispatcher: dispatcherStop.dispatcher } : {}),
          dispatcherStop,
        };
      }

      if (dispatcherAction === 'requeue') {
        const dispatcherId = normalizeOptionalString(action.arguments['dispatcher_id']);
        if (!dispatcherId) {
          throw new Error('TaskDispatcher requeue follow-up action is missing a dispatcher_id.');
        }
        const dispatcherRequeue = await queryObj.requeueTaskDispatcherAssignment({
          dispatcherId,
          ...(normalizeOptionalString(action.arguments['worker_id'])
            ? { workerId: normalizeOptionalString(action.arguments['worker_id']) }
            : {}),
          ...(normalizeOptionalString(action.arguments['task_id'])
            ? { taskId: normalizeOptionalString(action.arguments['task_id']) }
            : {}),
          ...(typeof action.arguments['stop_worker'] === 'boolean'
            ? { stopWorker: action.arguments['stop_worker'] }
            : {}),
        });
        return {
          kind: 'task_dispatcher',
          followUpKind: scaffold.kind,
          ...(dispatcherRequeue.dispatcher ? { dispatcher: dispatcherRequeue.dispatcher } : {}),
          dispatcherRequeue,
        };
      }

      throw new Error(`Unsupported TaskDispatcher follow-up action: ${dispatcherAction}`);
    }

    throw new Error(`Unsupported follow-up action tool: ${String((action as { tool?: unknown }).tool)}`);
  };

  queryObj.listRegisteredTools = async (): Promise<ToolCapabilityExportEntry[]> => (
    toolRegistry.listCapabilities().map((entry) => ({
      ...entry,
      ...(entry.tags ? { tags: [...entry.tags] } : {}),
    }))
  );

  queryObj.registerRuntimeTools = async (tools: ToolDefinition[]): Promise<RuntimeToolMutationResult> => {
    await runtimeReadyPromise;
    if (setupToolsReady) {
      await setupToolsReady;
    }
    const added: string[] = [];
    const replaced: string[] = [];
    for (const tool of tools) {
      if (!tool || typeof tool.name !== 'string' || tool.name.trim().length === 0) {
        throw new Error('registerRuntimeTools() requires every tool to have a non-empty name.');
      }
      if (toolRegistry.get(tool.name)) {
        replaced.push(tool.name);
      } else {
        added.push(tool.name);
      }
      toolRegistry.register(tool);
    }
    refreshManagedSystemPrompt();
    syncLoopToolsFromRegistry();
    return { added, replaced };
  };

  queryObj.unregisterRuntimeTools = async (names: string[]): Promise<RuntimeToolRemovalResult> => {
    const removed: string[] = [];
    for (const name of names) {
      const normalizedName = normalizeOptionalString(name);
      if (!normalizedName) continue;
      if (toolRegistry.unregister(normalizedName)) {
        removed.push(normalizedName);
      }
    }
    if (removed.length > 0) {
      refreshManagedSystemPrompt();
      syncLoopToolsFromRegistry();
    }
    return { removed };
  };

  const emitStandaloneOrchestrationEvent = (event: SubagentStreamEvent): void => {
    const orchestrationEvent = convertSubagentEventToOrchestrationEvent(undefined, sessionId, event);
    if (!orchestrationEvent) return;
    syncWorkerFromLifecycleEvent(orchestrationEvent);
    appendOrchestrationTimelineStoreItem(orchestrationEvent);
    handleTaskDispatcherOrchestrationEvent(orchestrationEvent);
    const taskNotification = buildTimelineTaskNotificationFromOrchestrationEvent(
      orchestrationEvent,
      responseLanguage,
    );
    if (taskNotification) {
      appendTimelineStoreItem(taskNotification);
    }
    for (const subscriber of orchestrationSubscribers) {
      subscriber.push(orchestrationEvent);
    }
  };

  const launchWorkerRecord = async (
    input: WorkerLaunchInput,
    subagentType: 'worker' | 'verifier',
    resume?: string,
  ): Promise<WorkerRecord> => {
    await runtimeReadyPromise;
    if (setupToolsReady) {
      await setupToolsReady;
      refreshManagedSystemPrompt();
      syncLoopToolsFromRegistry();
    }
    if (mcpReadyPromise) {
      await mcpReadyPromise;
      refreshManagedSystemPrompt();
      syncLoopToolsFromRegistry();
    }

    const promptText = normalizeOptionalString(input.prompt);
    if (!promptText) {
      throw new Error('Worker prompt must be a non-empty string.');
    }

    const agentDef = availableAgents.get(subagentType);
    if (!agentDef) {
      throw new Error(
        `Unknown agent type: ${subagentType}. Available: ${[...availableAgents.keys()].join(', ')}`,
      );
    }

    if (!sdkAgentExecutor) {
      sdkAgentExecutor = new AgentExecutor(effectiveHookExecutor as any);
    }

    const resumedSession = resume ? sdkAgentExecutor.getAgent(resume) : null;
    const teamName = resolveWorkerTeamName(input.teamName) ?? resumedSession?.teamName;
    const effectiveAgentCwd = input.cwd ?? cwd;
    let worktreePath: string | undefined = resumedSession?.worktreePath;
    let worktreeBranch: string | undefined = resumedSession?.worktreeBranch;

    if (!worktreePath && input.isolation === 'worktree') {
      const wt = await createWorktree(
        effectiveAgentCwd,
        input.name ?? `${subagentType}-${resume ?? Date.now()}`,
      );
      worktreePath = wt.path;
      worktreeBranch = wt.branch;
    }

    try {
      const { agentId } = await sdkAgentExecutor.executeInBackground({
        definition: agentDef,
        agentType: subagentType,
        provider,
        tools: new Map(toolRegistry.list().map((tool) => [tool.name, tool])),
        prompt: promptText,
        cwd: effectiveAgentCwd,
        name: input.name ?? resumedSession?.name,
        model: input.model ?? resumedSession?.model ?? resolveAgentModel(agentDef.model) ?? model,
        maxTurns: input.maxTurns,
        mode: input.mode ?? resumedSession?.mode ?? agentDef.mode,
        teamName,
        isolation: input.isolation,
        runInBackground: true,
        resume,
        parentSessionId: sessionId,
        ...(worktreePath ? { worktreePath } : {}),
        ...(worktreePath ? {
          onWorktreeCleanup: async (wtPath: string, hasChanges: boolean) => {
            if (!hasChanges) await cleanupWorktree(wtPath);
          },
        } : {}),
        onEvent: (event: SubagentStreamEvent) => {
          emitStandaloneOrchestrationEvent(teamName && !event.teamName
            ? { ...event, teamName }
            : event);
        },
      });
      const session = sdkAgentExecutor.getAgent(agentId);
      if (!session) {
        throw new Error(`Worker ${agentId} was launched but its session could not be loaded.`);
      }
      const record = toWorkerRecord(session);
      upsertWorkerStoreRecord(record);
      return worktreePath && worktreeBranch && !record.worktreeBranch
        ? { ...record, worktreePath, worktreeBranch }
        : record;
    } catch (error) {
      if (worktreePath) {
        try {
          const hasChanges = await hasWorktreeChanges(worktreePath);
          if (!hasChanges) {
            await cleanupWorktree(worktreePath);
          }
        } catch {
          // Non-fatal cleanup failure.
        }
      }
      throw error;
    }
  };

  queryObj.listWorkers = async (options?: WorkerListOptions) => {
    const teamName = normalizeOptionalString(options?.teamName);
    const persistedAgentExecutor = sdkAgentExecutor ?? new AgentExecutor();
    const merged = new Map<string, WorkerRecord>();
    for (const record of readPersistedWorkerLedgerRecords()) {
      merged.set(record.workerId, JSON.parse(JSON.stringify(record)) as WorkerRecord);
    }
    for (const session of persistedAgentExecutor.listPersistedAgents()) {
      const record = toWorkerRecord(session);
      merged.set(record.workerId, record);
    }
    const records = [...merged.values()]
      .filter((record) => !teamName || record.teamName === teamName)
      .sort((left, right) => new Date(right.startedAt).getTime() - new Date(left.startedAt).getTime());
    for (const record of records) {
      upsertWorkerStoreRecord(record, { persist: false });
    }
    return records;
  };

  queryObj.getWorker = async (workerId: string) => {
    const normalizedWorkerId = normalizeOptionalString(workerId);
    if (!normalizedWorkerId) {
      throw new Error('workerId is required to inspect a worker.');
    }
    return (await queryObj.listWorkers()).find((record) => record.workerId === normalizedWorkerId) ?? null;
  };

  queryObj.getWorkerFollowUps = async (workerId: string) => {
    const persistedAgentExecutor = sdkAgentExecutor ?? new AgentExecutor();
    const session = persistedAgentExecutor.getAgent(workerId);
    if (!session) {
      return [];
    }

    const taskStatus = mapAgentStateToTaskStatus(session.state);
    if (!taskStatus) {
      return [];
    }

    const observation = createPromptSuggestionObservation();
    observation.sawTask = true;
    observation.sawSubagent = true;
    observation.lastTaskId = session.agentId;
    observation.lastTaskStatus = taskStatus;
    observation.lastTaskTeamName = session.teamName;
    observation.lastTaskDescription = session.name ?? session.agentType;
    observation.lastTaskTemplates = buildTaskOrchestrationTemplates({
      taskId: session.agentId,
      status: taskStatus,
      description: session.name ?? session.agentType,
      summary: summarizePlainText(session.result ?? session.error),
      result: session.result ?? session.error,
    });

    const resultMessage: SDKResultMessage = {
      type: 'result',
      subtype: 'success',
      duration_ms: session.durationMs,
      duration_api_ms: 0,
      is_error: false,
      num_turns: session.numTurns,
      result: session.result ?? session.error ?? '',
      stop_reason: 'end_turn',
      total_cost_usd: 0,
      usage: {
        input_tokens: 0,
        output_tokens: typeof session.totalTokens === 'number' ? session.totalTokens : 0,
      },
      modelUsage: {},
      permission_denials: [],
      uuid: randomUUID(),
      session_id: sessionId,
    };

    return __internal_buildPromptSuggestions({
      result: resultMessage,
      observation,
      language: responseLanguage,
    })
      .filter((item): item is WorkerFollowUpSuggestion => Boolean(item.scaffold))
      .map((item) => ({
        suggestion: item.suggestion,
        scaffold: item.scaffold!,
      }));
  };

  queryObj.launchWorker = async (input: WorkerLaunchInput) => launchWorkerRecord(input, 'worker');

  queryObj.launchVerifier = async (input: WorkerLaunchInput) => launchWorkerRecord(input, 'verifier');

  queryObj.resumeWorker = async (workerId: string, input: WorkerLaunchInput) => {
    const normalizedWorkerId = normalizeOptionalString(workerId);
    if (!normalizedWorkerId) {
      throw new Error('workerId is required to resume a worker.');
    }
    const persistedAgentExecutor = sdkAgentExecutor ?? new AgentExecutor();
    const session = persistedAgentExecutor.getAgent(normalizedWorkerId);
    if (!session) {
      throw new Error(`Worker not found: ${normalizedWorkerId}`);
    }
    const subagentType = session.agentType === 'verifier' ? 'verifier' : 'worker';
    return launchWorkerRecord(input, subagentType, normalizedWorkerId);
  };

  queryObj.stopWorker = async (workerId: string) => ({
    success: sdkAgentExecutor?.stopAgent(workerId) ?? false,
  });

  queryObj.listRunningSubagents = async (options?: WorkerListOptions): Promise<SubagentRecord[]> => (
    (await queryObj.listWorkers(options))
      .filter((record) => record.status === 'spawning' || record.status === 'running' || record.status === 'idle')
  );

  queryObj.cancelSubagent = async (workerId: string) => queryObj.stopWorker(workerId);

  queryObj.listTasks = async (options?: TaskListOptions) => {
    const teamName = resolveTaskTeamName(options?.teamName);
    const manager = getTaskManager(teamName);
    const merged = new Map<string, TaskRecord>();
    if (!options?.availableOnly) {
      for (const record of readPersistedTaskLedgerRecords()) {
        if (!teamName || record.teamName === teamName) {
          merged.set(record.id, JSON.parse(JSON.stringify(record)) as TaskRecord);
        }
      }
    }
    const tasks = options?.availableOnly
      ? manager.listAvailable(options.now ?? new Date())
      : manager.listAll();
    for (const task of tasks) {
      const record = toTaskRecord(task, teamName);
      merged.set(record.id, record);
    }
    const records = [...merged.values()]
      .filter((record) => !teamName || record.teamName === teamName)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    for (const record of records) {
      upsertTaskStoreRecord(record, { persist: false });
    }
    return records;
  };

  queryObj.getTask = async (taskId: string, options?: { teamName?: string }) => {
    const teamName = resolveTaskTeamName(options?.teamName);
    const task = getTaskManager(teamName).get(taskId);
    const record = task ? toTaskRecord(task, teamName) : null;
    if (record) {
      upsertTaskStoreRecord(record, { persist: false });
    }
    return record;
  };

  queryObj.createTask = async (input: TaskCreateInput) => {
    const teamName = resolveTaskTeamName(input.teamName);
    const item = getTaskManager(teamName).create(
      input.subject,
      input.description,
      input.activeForm,
      input.metadata,
      input.priority,
    );
    const record = toTaskRecord(item, teamName);
    upsertTaskStoreRecord(record);
    return record;
  };

  queryObj.updateTask = async (input: TaskUpdateInput) => {
    const teamName = resolveTaskTeamName(input.teamName);
    const item = getTaskManager(teamName).update(input.taskId, input as any);
    const record = toTaskRecord(item, teamName);
    upsertTaskStoreRecord(record);
    return record;
  };

  queryObj.claimNextTask = async (owner: string, options?: TaskClaimOptions) => {
    const teamName = resolveTaskTeamName(options?.teamName);
    const task = getTaskManager(teamName).claimNext(owner, {
      leaseMs: options?.leaseMs,
      now: options?.now,
    });
    const record = task ? toTaskRecord(task, teamName) : null;
    if (record) {
      upsertTaskStoreRecord(record);
    }
    return record;
  };

  queryObj.heartbeatTask = async (taskId: string, owner: string, options?: TaskClaimOptions) => {
    const teamName = resolveTaskTeamName(options?.teamName);
    const task = getTaskManager(teamName).heartbeat(
      taskId,
      owner,
      options?.leaseMs,
      options?.now,
    );
    const record = toTaskRecord(task, teamName);
    upsertTaskStoreRecord(record);
    return record;
  };

  queryObj.releaseTask = async (taskId: string, owner: string, options?: TaskReleaseOptions) => {
    const teamName = resolveTaskTeamName(options?.teamName);
    const task = getTaskManager(teamName).releaseLease(
      taskId,
      owner,
      options?.status ?? 'pending',
    );
    const record = toTaskRecord(task, teamName);
    upsertTaskStoreRecord(record);
    return record;
  };

  queryObj.dispatchNextTask = async (input: TaskDispatchInput): Promise<TaskDispatchResult | null> => {
    const owner = normalizeOptionalString(input.owner);
    if (!owner) {
      throw new Error('dispatchNextTask requires a non-empty owner.');
    }

    const teamName = resolveTaskTeamName(input.teamName);
    const claimed = getTaskManager(teamName).claimNext(owner, {
      leaseMs: input.leaseMs,
      now: input.now,
    });
    if (!claimed) {
      return null;
    }

    const taskRecord = toTaskRecord(claimed, teamName);
    upsertTaskStoreRecord(taskRecord);
    const workerPrompt = normalizeOptionalString(input.prompt)
      ?? buildTaskDispatchPrompt(claimed);

    try {
      const worker = input.workerType === 'verifier'
        ? await queryObj.launchVerifier({
            teamName,
            name: input.name ?? claimed.subject,
            prompt: workerPrompt,
            ...(input.model ? { model: input.model } : {}),
            ...(input.maxTurns !== undefined ? { maxTurns: input.maxTurns } : {}),
            ...(input.mode ? { mode: input.mode } : {}),
            ...(input.cwd ? { cwd: input.cwd } : {}),
            ...(input.isolation ? { isolation: input.isolation } : {}),
          })
        : await queryObj.launchWorker({
            teamName,
            name: input.name ?? claimed.subject,
            prompt: workerPrompt,
            ...(input.model ? { model: input.model } : {}),
            ...(input.maxTurns !== undefined ? { maxTurns: input.maxTurns } : {}),
            ...(input.mode ? { mode: input.mode } : {}),
            ...(input.cwd ? { cwd: input.cwd } : {}),
            ...(input.isolation ? { isolation: input.isolation } : {}),
          });

      return {
        task: taskRecord,
        worker,
      };
    } catch (error) {
      getTaskManager(teamName).releaseLease(claimed.id, owner, 'pending');
      throw error;
    }
  };

  queryObj.startTaskDispatcher = async (input: TaskDispatcherStartInput): Promise<TaskDispatcherRecord> => {
    const owner = normalizeOptionalString(input.owner);
    if (!owner) {
      throw new Error('startTaskDispatcher requires a non-empty owner.');
    }

    const teamName = resolveTaskTeamName(input.teamName);
    const dispatcherId = normalizeOptionalString(input.dispatcherId) ?? randomUUID();
    const existing = taskDispatchers.get(dispatcherId);
    if (existing && existing.record.status !== 'stopped') {
      throw new Error(`Task dispatcher already exists: ${dispatcherId}`);
    }

    const pollIntervalMs = Math.max(25, input.pollIntervalMs ?? DEFAULT_TASK_DISPATCHER_POLL_INTERVAL_MS);
    const maxConcurrentWorkers = Math.max(1, Math.trunc(input.maxConcurrentWorkers ?? 1));
    const leaseMs = input.leaseMs ?? DEFAULT_TASK_LEASE_MS;
    if (!claimTaskDispatcherOwnership({ dispatcherId, leaseMs, pollIntervalMs })) {
      throw new Error(`Task dispatcher is already owned by another active query: ${dispatcherId}`);
    }
    const startedAt = new Date().toISOString();
    const state: TaskDispatcherState = {
      record: {
        dispatcherId,
        owner,
        teamName,
        source: 'live',
        workerType: input.workerType === 'verifier' ? 'verifier' : 'worker',
        status: 'running',
        pollIntervalMs,
        leaseMs,
        maxConcurrentWorkers,
        ...(normalizeOptionalString(input.name) ? { name: normalizeOptionalString(input.name) } : {}),
        ...(normalizeOptionalString(input.prompt) ? { prompt: normalizeOptionalString(input.prompt) } : {}),
        ...(normalizeOptionalString(input.model) ? { model: normalizeOptionalString(input.model) } : {}),
        ...(input.maxTurns !== undefined ? { maxTurns: input.maxTurns } : {}),
        ...(normalizeOptionalString(input.mode) ? { mode: normalizeOptionalString(input.mode) } : {}),
        ...(normalizeOptionalString(input.cwd) ? { cwd: normalizeOptionalString(input.cwd) } : {}),
        ...(input.isolation ? { isolation: input.isolation } : {}),
        schedulerState: 'idle',
        activeTaskIds: [],
        activeWorkerIds: [],
        activeAssignments: [],
        startedAt,
        updatedAt: startedAt,
      },
      ...(normalizeOptionalString(input.prompt) ? { prompt: normalizeOptionalString(input.prompt) } : {}),
      ...(normalizeOptionalString(input.name) ? { name: normalizeOptionalString(input.name) } : {}),
      ...(normalizeOptionalString(input.model) ? { model: normalizeOptionalString(input.model) } : {}),
      ...(input.maxTurns !== undefined ? { maxTurns: input.maxTurns } : {}),
      ...(normalizeOptionalString(input.mode) ? { mode: normalizeOptionalString(input.mode) } : {}),
      ...(normalizeOptionalString(input.cwd) ? { cwd: normalizeOptionalString(input.cwd) } : {}),
      ...(input.isolation ? { isolation: input.isolation } : {}),
      timer: null,
      running: false,
      rerunRequested: false,
      disposed: false,
      activeAssignments: new Map(),
    };
    taskDispatchers.set(dispatcherId, state);
    claimTaskSchedulerOwnership();
    syncTaskDispatcherRecord(state);
    emitTaskDispatcherOrchestrationEvent(state, 'started', { timestamp: startedAt });
    scheduleTaskDispatcherRun(state, 0);
    return cloneTaskDispatcherRecord(state.record);
  };

  queryObj.resumeTaskDispatcher = async (dispatcherId: string): Promise<TaskDispatcherRecord | null> => {
    const normalizedDispatcherId = normalizeOptionalString(dispatcherId);
    if (!normalizedDispatcherId) {
      throw new Error('dispatcherId is required to resume a task dispatcher.');
    }

    const existing = taskDispatchers.get(normalizedDispatcherId);
    if (existing && !existing.disposed) {
      if (existing.record.status !== 'stopped') {
        return cloneTaskDispatcherRecord(syncTaskDispatcherRecord(existing));
      }
      taskDispatchers.delete(normalizedDispatcherId);
      for (const assignment of existing.activeAssignments.values()) {
        taskDispatcherByWorkerId.delete(assignment.workerId);
      }
    }

    const persisted = readPersistedTaskDispatcherRecords().find((record) => record.dispatcherId === normalizedDispatcherId);
    if (!persisted) {
      return null;
    }
    if (!claimTaskDispatcherOwnership(persisted)) {
      return cloneTaskDispatcherRecord({
        ...persisted,
        source: 'ledger',
      });
    }

    const state = hydrateTaskDispatcherState({
      ...persisted,
      source: 'live',
      status: persisted.status === 'stopped' ? 'running' : persisted.status,
      ...(persisted.stoppedAt ? { stoppedAt: undefined } : {}),
      updatedAt: new Date().toISOString(),
    });
    claimTaskSchedulerOwnership();
    emitTaskDispatcherOrchestrationEvent(state, 'started', { timestamp: state.record.updatedAt });
    scheduleTaskDispatcherRun(state, 0);
    return cloneTaskDispatcherRecord(state.record);
  };

  const getTaskDispatcherLedgerPath = () => sessionMgr
    ? join(dirname(sessionMgr.getTranscriptPath(transcriptCwd, sessionId)), `${sessionId}.dispatchers.json`)
    : join(cwd, '.open-agent', 'dispatcher-ledgers', `${sessionId}.json`);
  const getTaskDispatcherOwnershipPath = (dispatcherId: string) => sessionMgr
    ? join(dirname(sessionMgr.getTranscriptPath(transcriptCwd, sessionId)), `${sessionId}.dispatcher-ownership.${dispatcherId}.json`)
    : join(cwd, '.open-agent', 'dispatcher-ledgers', `${sessionId}.${dispatcherId}.ownership.json`);
  const getTaskSchedulerOwnershipPath = () => sessionMgr
    ? join(dirname(sessionMgr.getTranscriptPath(transcriptCwd, sessionId)), `${sessionId}.scheduler-ownership.json`)
    : join(cwd, '.open-agent', 'dispatcher-ledgers', `${sessionId}.scheduler-ownership.json`);
  const getTaskDispatcherDiagnosisLedgerPath = () => sessionMgr
    ? join(dirname(sessionMgr.getTranscriptPath(transcriptCwd, sessionId)), `${sessionId}.dispatcher-diagnoses.json`)
    : join(cwd, '.open-agent', 'dispatcher-ledgers', `${sessionId}.diagnoses.json`);
  const getTaskLedgerPath = () => sessionMgr
    ? join(dirname(sessionMgr.getTranscriptPath(transcriptCwd, sessionId)), `${sessionId}.tasks.json`)
    : join(cwd, '.open-agent', 'orchestration-ledgers', `${sessionId}.tasks.json`);
  const getWorkerLedgerPath = () => sessionMgr
    ? join(dirname(sessionMgr.getTranscriptPath(transcriptCwd, sessionId)), `${sessionId}.workers.json`)
    : join(cwd, '.open-agent', 'orchestration-ledgers', `${sessionId}.workers.json`);
  const getOrchestrationTimelineLedgerPath = () => sessionMgr
    ? join(dirname(sessionMgr.getTranscriptPath(transcriptCwd, sessionId)), `${sessionId}.orchestration-timeline.json`)
    : join(cwd, '.open-agent', 'orchestration-ledgers', `${sessionId}.timeline.json`);
  const getUnifiedOrchestrationLedgerPath = () => sessionMgr
    ? join(dirname(sessionMgr.getTranscriptPath(transcriptCwd, sessionId)), `${sessionId}.orchestration.json`)
    : join(cwd, '.open-agent', 'orchestration-ledgers', `${sessionId}.orchestration.json`);

  const readUnifiedOrchestrationLedger = (): PersistedOrchestrationLedgerFile | null => {
    const ledgerPath = getUnifiedOrchestrationLedgerPath();
    if (!existsSync(ledgerPath)) {
      return null;
    }
    try {
      const parsed = JSON.parse(readFileSync(ledgerPath, 'utf-8')) as PersistedOrchestrationLedgerFile;
      if (!parsed || parsed.version !== 1) {
        return null;
      }
      return {
        version: 1,
        tasks: Array.isArray(parsed.tasks) ? parsed.tasks.map((item) => JSON.parse(JSON.stringify(item)) as TaskRecord) : [],
        workers: Array.isArray(parsed.workers) ? parsed.workers.map((item) => JSON.parse(JSON.stringify(item)) as WorkerRecord) : [],
        dispatchers: Array.isArray(parsed.dispatchers)
          ? parsed.dispatchers.map((item) => cloneTaskDispatcherRecord(item))
          : [],
        timelineItems: Array.isArray(parsed.timelineItems)
          ? parsed.timelineItems.map((item) => JSON.parse(JSON.stringify(item)) as SDKTimelineItem)
          : [],
        dispatcherDiagnoses: Array.isArray(parsed.dispatcherDiagnoses)
          ? parsed.dispatcherDiagnoses.map((item) => JSON.parse(JSON.stringify(item)) as TaskDispatcherHealthReport)
          : [],
        scheduler: parsed.scheduler && typeof parsed.scheduler === 'object'
          ? {
            ownerQueryInstanceId:
              typeof parsed.scheduler.ownerQueryInstanceId === 'string'
                ? parsed.scheduler.ownerQueryInstanceId
                : null,
            ownerSessionId:
              typeof parsed.scheduler.ownerSessionId === 'string'
                ? parsed.scheduler.ownerSessionId
                : sessionId,
            ownerScope:
              parsed.scheduler.ownerQueryInstanceId === queryInstanceId
                ? 'local'
                : typeof parsed.scheduler.ownerQueryInstanceId === 'string'
                  ? 'remote'
                  : 'unowned',
            ...(typeof parsed.scheduler.claimedAt === 'string' ? { claimedAt: parsed.scheduler.claimedAt } : {}),
            ...(typeof parsed.scheduler.heartbeatAt === 'string' ? { heartbeatAt: parsed.scheduler.heartbeatAt } : {}),
            fairnessCursor:
              typeof parsed.scheduler.fairnessCursor === 'string'
                ? parsed.scheduler.fairnessCursor
                : null,
            updatedAt:
              typeof parsed.scheduler.updatedAt === 'string'
                ? parsed.scheduler.updatedAt
                : '',
            queue: Array.isArray(parsed.scheduler.queue)
              ? parsed.scheduler.queue
                .filter((item) => item && typeof item === 'object' && typeof item.dispatcherId === 'string')
                .map((item) => JSON.parse(JSON.stringify(item)) as SchedulerQueueEntry)
              : [],
          }
          : {
            ownerQueryInstanceId: null,
            ownerSessionId: sessionId,
            ownerScope: 'unowned',
            fairnessCursor: null,
            updatedAt: '',
            queue: [],
          },
      };
    } catch {
      return null;
    }
  };

  function readPersistedSchedulerControlPlaneSnapshot(): SchedulerControlPlaneSnapshot | null {
    const unified = readUnifiedOrchestrationLedger();
    if (!unified) {
      return null;
    }
    return {
      ownerQueryInstanceId: unified.scheduler.ownerQueryInstanceId,
      ownerSessionId: unified.scheduler.ownerSessionId,
      ownerScope: unified.scheduler.ownerScope,
      ...(unified.scheduler.claimedAt ? { claimedAt: unified.scheduler.claimedAt } : {}),
      ...(unified.scheduler.heartbeatAt ? { heartbeatAt: unified.scheduler.heartbeatAt } : {}),
      fairnessCursor: unified.scheduler.fairnessCursor,
      updatedAt: unified.scheduler.updatedAt,
      queue: unified.scheduler.queue.map((entry) => ({ ...entry })),
    };
  }

  const readTaskSchedulerOwnershipRecord = (): TaskSchedulerOwnershipRecord | null => {
    const ownershipPath = getTaskSchedulerOwnershipPath();
    if (!existsSync(ownershipPath)) {
      return null;
    }
    try {
      const parsed = JSON.parse(readFileSync(ownershipPath, 'utf-8')) as TaskSchedulerOwnershipRecord;
      if (
        !parsed
        || typeof parsed !== 'object'
        || typeof parsed.queryInstanceId !== 'string'
        || typeof parsed.sessionId !== 'string'
        || typeof parsed.claimedAt !== 'string'
        || typeof parsed.heartbeatAt !== 'string'
      ) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  };

  const readTaskDispatcherOwnershipRecord = (dispatcherId: string): TaskDispatcherOwnershipRecord | null => {
    const ownershipPath = getTaskDispatcherOwnershipPath(dispatcherId);
    if (!existsSync(ownershipPath)) {
      return null;
    }
    try {
      const parsed = JSON.parse(readFileSync(ownershipPath, 'utf-8')) as TaskDispatcherOwnershipRecord;
      if (
        !parsed
        || typeof parsed !== 'object'
        || parsed.dispatcherId !== dispatcherId
        || typeof parsed.queryInstanceId !== 'string'
        || typeof parsed.sessionId !== 'string'
        || typeof parsed.claimedAt !== 'string'
        || typeof parsed.heartbeatAt !== 'string'
      ) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  };

  const getTaskDispatcherOwnershipTtlMs = (
    record: Pick<TaskDispatcherRecord, 'leaseMs' | 'pollIntervalMs'>,
  ): number => Math.max(record.leaseMs, record.pollIntervalMs * 4, 1_000);

  const hasTaskDispatcherOwnershipExpired = (
    record: Pick<TaskDispatcherRecord, 'leaseMs' | 'pollIntervalMs'>,
    ownership: TaskDispatcherOwnershipRecord,
    now = new Date(),
  ): boolean => {
    const heartbeatMs = Date.parse(ownership.heartbeatAt);
    if (!Number.isFinite(heartbeatMs)) {
      return true;
    }
    return now.getTime() - heartbeatMs > getTaskDispatcherOwnershipTtlMs(record);
  };

  const getTaskSchedulerOwnershipTtlMs = (): number => {
    const pollIntervals = [...taskDispatchers.values()]
      .filter((state) => !state.disposed && state.record.status !== 'stopped')
      .map((state) => Math.max(state.record.leaseMs, state.record.pollIntervalMs * 4));
    return Math.max(1_000, ...pollIntervals);
  };

  const hasTaskSchedulerOwnershipExpired = (
    ownership: TaskSchedulerOwnershipRecord,
    now = new Date(),
  ): boolean => {
    const heartbeatMs = Date.parse(ownership.heartbeatAt);
    if (!Number.isFinite(heartbeatMs)) {
      return true;
    }
    return now.getTime() - heartbeatMs > getTaskSchedulerOwnershipTtlMs();
  };

  const writeTaskDispatcherOwnershipRecord = (
    dispatcherId: string,
    ownership: TaskDispatcherOwnershipRecord,
    exclusive: boolean,
  ): boolean => {
    try {
      const ownershipPath = getTaskDispatcherOwnershipPath(dispatcherId);
      mkdirSync(dirname(ownershipPath), { recursive: true });
      writeFileSync(ownershipPath, JSON.stringify(ownership, null, 2), exclusive ? { flag: 'wx' } : undefined);
      return true;
    } catch {
      return false;
    }
  };

  const writeTaskSchedulerOwnershipRecord = (
    ownership: TaskSchedulerOwnershipRecord,
    exclusive: boolean,
  ): boolean => {
    try {
      const ownershipPath = getTaskSchedulerOwnershipPath();
      mkdirSync(dirname(ownershipPath), { recursive: true });
      writeFileSync(ownershipPath, JSON.stringify(ownership, null, 2), exclusive ? { flag: 'wx' } : undefined);
      return true;
    } catch {
      return false;
    }
  };

  const claimTaskDispatcherOwnership = (
    record: Pick<TaskDispatcherRecord, 'dispatcherId' | 'leaseMs' | 'pollIntervalMs'>,
    now = new Date(),
  ): boolean => {
    const dispatcherId = record.dispatcherId;
    const existing = readTaskDispatcherOwnershipRecord(dispatcherId);
    const claimedAt = existing?.queryInstanceId === queryInstanceId ? existing.claimedAt : now.toISOString();
    const nextOwnership: TaskDispatcherOwnershipRecord = {
      dispatcherId,
      queryInstanceId,
      sessionId,
      claimedAt,
      heartbeatAt: now.toISOString(),
    };

    if (existing?.queryInstanceId === queryInstanceId) {
      return writeTaskDispatcherOwnershipRecord(dispatcherId, nextOwnership, false);
    }

    if (!existing) {
      return writeTaskDispatcherOwnershipRecord(dispatcherId, nextOwnership, true)
        || readTaskDispatcherOwnershipRecord(dispatcherId)?.queryInstanceId === queryInstanceId;
    }

    if (!hasTaskDispatcherOwnershipExpired(record, existing, now)) {
      return false;
    }

    try {
      unlinkSync(getTaskDispatcherOwnershipPath(dispatcherId));
    } catch {
      // Best-effort: another query may replace the ownership file concurrently.
    }
    return writeTaskDispatcherOwnershipRecord(dispatcherId, nextOwnership, true)
      || readTaskDispatcherOwnershipRecord(dispatcherId)?.queryInstanceId === queryInstanceId;
  };

  const refreshTaskDispatcherOwnership = (
    state: TaskDispatcherState,
    now = new Date(),
  ): boolean => claimTaskDispatcherOwnership(state.record, now);

  const releaseTaskDispatcherOwnership = (dispatcherId: string): void => {
    const existing = readTaskDispatcherOwnershipRecord(dispatcherId);
    if (existing && existing.queryInstanceId !== queryInstanceId) {
      return;
    }
    try {
      unlinkSync(getTaskDispatcherOwnershipPath(dispatcherId));
    } catch {
      // Best-effort: another query may already have cleaned up the ownership file.
    }
  };

  const claimTaskSchedulerOwnership = (now = new Date()): boolean => {
    const existing = readTaskSchedulerOwnershipRecord();
    const claimedAt = existing?.queryInstanceId === queryInstanceId ? existing.claimedAt : now.toISOString();
    const nextOwnership: TaskSchedulerOwnershipRecord = {
      queryInstanceId,
      sessionId,
      claimedAt,
      heartbeatAt: now.toISOString(),
    };

    if (existing?.queryInstanceId === queryInstanceId) {
      return writeTaskSchedulerOwnershipRecord(nextOwnership, false);
    }

    if (!existing) {
      return writeTaskSchedulerOwnershipRecord(nextOwnership, true)
        || readTaskSchedulerOwnershipRecord()?.queryInstanceId === queryInstanceId;
    }

    if (!hasTaskSchedulerOwnershipExpired(existing, now)) {
      return false;
    }

    try {
      unlinkSync(getTaskSchedulerOwnershipPath());
    } catch {
      // Best-effort: another query may replace the scheduler ownership file concurrently.
    }
    return writeTaskSchedulerOwnershipRecord(nextOwnership, true)
      || readTaskSchedulerOwnershipRecord()?.queryInstanceId === queryInstanceId;
  };

  const refreshTaskSchedulerOwnership = (now = new Date()): boolean => claimTaskSchedulerOwnership(now);

  const releaseTaskSchedulerOwnership = (): void => {
    const existing = readTaskSchedulerOwnershipRecord();
    if (existing && existing.queryInstanceId !== queryInstanceId) {
      return;
    }
    try {
      unlinkSync(getTaskSchedulerOwnershipPath());
    } catch {
      // Best-effort: another query may already have cleaned up the scheduler ownership file.
    }
  };

  const writeUnifiedOrchestrationLedger = (
    updater: (current: PersistedOrchestrationLedgerFile) => PersistedOrchestrationLedgerFile,
  ): void => {
    try {
      const ledgerPath = getUnifiedOrchestrationLedgerPath();
      mkdirSync(dirname(ledgerPath), { recursive: true });
      const current = readUnifiedOrchestrationLedger() ?? {
        version: 1 as const,
        tasks: [],
        workers: [],
        dispatchers: [],
        timelineItems: [],
        dispatcherDiagnoses: [],
        scheduler: {
          ownerQueryInstanceId: null,
          ownerSessionId: sessionId,
          ownerScope: 'unowned',
          fairnessCursor: null,
          updatedAt: '',
          queue: [],
        },
      };
      const next = updater(current);
      writeFileSync(ledgerPath, JSON.stringify(next, null, 2));
    } catch {
      // Non-fatal: unified orchestration durability should not break query execution.
    }
  };

  function persistSchedulerControlPlaneSnapshot(snapshot: SchedulerControlPlaneSnapshot): void {
    writeUnifiedOrchestrationLedger((current) => ({
      ...current,
      scheduler: {
        ownerQueryInstanceId: snapshot.ownerQueryInstanceId,
        ownerSessionId: snapshot.ownerSessionId,
        ownerScope: snapshot.ownerScope,
        ...(snapshot.claimedAt ? { claimedAt: snapshot.claimedAt } : {}),
        ...(snapshot.heartbeatAt ? { heartbeatAt: snapshot.heartbeatAt } : {}),
        fairnessCursor: snapshot.fairnessCursor,
        updatedAt: snapshot.updatedAt,
        queue: snapshot.queue.map((entry) => ({ ...entry })),
      },
    }));
  }

  syncAppSchedulerControlPlane();

  const readPersistedOrchestrationTimelineLedgerItems = (): SDKTimelineItem[] => {
    const unified = readUnifiedOrchestrationLedger();
    if (unified) {
      return unified.timelineItems
        .filter((item) => item.kind === 'worker_lifecycle' || item.kind === 'task_dispatcher' || item.kind === 'task_notification')
        .map((item) => JSON.parse(JSON.stringify(item)) as SDKTimelineItem)
        .sort((left, right) => compareTimelineTimestamps(left.timestamp, right.timestamp));
    }
    const ledgerPath = getOrchestrationTimelineLedgerPath();
    if (!existsSync(ledgerPath)) {
      return [];
    }
    try {
      const parsed = JSON.parse(readFileSync(ledgerPath, 'utf-8')) as PersistedOrchestrationTimelineLedgerFile;
      if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.items)) {
        return [];
      }
      return parsed.items
        .filter((item): item is SDKTimelineItem => {
          if (!item || typeof item !== 'object') return false;
          const kind = (item as { kind?: unknown }).kind;
          return kind === 'worker_lifecycle' || kind === 'task_dispatcher' || kind === 'task_notification';
        })
        .map((item) => JSON.parse(JSON.stringify(item)) as SDKTimelineItem)
        .sort((left, right) => compareTimelineTimestamps(left.timestamp, right.timestamp));
    } catch {
      return [];
    }
  };

  const persistOrchestrationTimelineLedgerItem = (item: SDKTimelineItem): void => {
    if (item.kind !== 'worker_lifecycle' && item.kind !== 'task_dispatcher' && item.kind !== 'task_notification') {
      return;
    }
    writeUnifiedOrchestrationLedger((current) => {
      const merged = new Map<string, SDKTimelineItem>(
        current.timelineItems.map((entry) => [
          entry.cursor ?? entry.timelineId ?? `${entry.kind}:${entry.timestamp}:${entry.sessionId}`,
          JSON.parse(JSON.stringify(entry)) as SDKTimelineItem,
        ]),
      );
      const key = item.cursor ?? item.timelineId ?? `${item.kind}:${item.timestamp}:${item.sessionId}`;
      merged.set(key, JSON.parse(JSON.stringify(item)) as SDKTimelineItem);
      return {
        ...current,
        timelineItems: sortTimelineItems([...merged.values()]),
      };
    });
    try {
      const ledgerPath = getOrchestrationTimelineLedgerPath();
      mkdirSync(dirname(ledgerPath), { recursive: true });
      const merged = new Map<string, SDKTimelineItem>(
        readPersistedOrchestrationTimelineLedgerItems().map((entry) => [
          entry.cursor ?? entry.timelineId ?? `${entry.kind}:${entry.timestamp}:${entry.sessionId}`,
          JSON.parse(JSON.stringify(entry)) as SDKTimelineItem,
        ]),
      );
      const key = item.cursor ?? item.timelineId ?? `${item.kind}:${item.timestamp}:${item.sessionId}`;
      merged.set(key, JSON.parse(JSON.stringify(item)) as SDKTimelineItem);
      writeFileSync(ledgerPath, JSON.stringify({
        version: 1,
        items: sortTimelineItems([...merged.values()]),
      } satisfies PersistedOrchestrationTimelineLedgerFile, null, 2));
    } catch {
      // Non-fatal: timeline durability should not break runtime orchestration.
    }
  };

  const readPersistedTaskLedgerRecords = (): TaskRecord[] => {
    const unified = readUnifiedOrchestrationLedger();
    if (unified) {
      return unified.tasks
        .map((record) => JSON.parse(JSON.stringify(record)) as TaskRecord)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    }
    const ledgerPath = getTaskLedgerPath();
    if (!existsSync(ledgerPath)) {
      return [];
    }
    try {
      const parsed = JSON.parse(readFileSync(ledgerPath, 'utf-8')) as PersistedTaskLedgerFile;
      if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.tasks)) {
        return [];
      }
      return parsed.tasks
        .filter((record): record is TaskRecord => Boolean(record && typeof record === 'object' && typeof record.id === 'string'))
        .map((record) => JSON.parse(JSON.stringify(record)) as TaskRecord)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    } catch {
      return [];
    }
  };

  const persistTaskLedgerRecord = (record: TaskRecord): void => {
    writeUnifiedOrchestrationLedger((current) => {
      const merged = new Map<string, TaskRecord>(
        current.tasks.map((entry) => [entry.id, JSON.parse(JSON.stringify(entry)) as TaskRecord]),
      );
      merged.set(record.id, JSON.parse(JSON.stringify(record)) as TaskRecord);
      return {
        ...current,
        tasks: [...merged.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
      };
    });
    try {
      const ledgerPath = getTaskLedgerPath();
      mkdirSync(dirname(ledgerPath), { recursive: true });
      const merged = new Map<string, TaskRecord>(
        readPersistedTaskLedgerRecords().map((entry) => [entry.id, JSON.parse(JSON.stringify(entry)) as TaskRecord]),
      );
      merged.set(record.id, JSON.parse(JSON.stringify(record)) as TaskRecord);
      writeFileSync(ledgerPath, JSON.stringify({
        version: 1,
        tasks: [...merged.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
      } satisfies PersistedTaskLedgerFile, null, 2));
    } catch {
      // Non-fatal: task ledger durability should not break the query control plane.
    }
  };

  const readPersistedWorkerLedgerRecords = (): WorkerRecord[] => {
    const unified = readUnifiedOrchestrationLedger();
    if (unified) {
      return unified.workers
        .map((record) => JSON.parse(JSON.stringify(record)) as WorkerRecord)
        .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
    }
    const ledgerPath = getWorkerLedgerPath();
    if (!existsSync(ledgerPath)) {
      return [];
    }
    try {
      const parsed = JSON.parse(readFileSync(ledgerPath, 'utf-8')) as PersistedWorkerLedgerFile;
      if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.workers)) {
        return [];
      }
      return parsed.workers
        .filter((record): record is WorkerRecord => Boolean(record && typeof record === 'object' && typeof record.workerId === 'string'))
        .map((record) => JSON.parse(JSON.stringify(record)) as WorkerRecord)
        .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
    } catch {
      return [];
    }
  };

  const persistWorkerLedgerRecord = (record: WorkerRecord): void => {
    writeUnifiedOrchestrationLedger((current) => {
      const merged = new Map<string, WorkerRecord>(
        current.workers.map((entry) => [entry.workerId, JSON.parse(JSON.stringify(entry)) as WorkerRecord]),
      );
      merged.set(record.workerId, JSON.parse(JSON.stringify(record)) as WorkerRecord);
      return {
        ...current,
        workers: [...merged.values()].sort((left, right) => left.startedAt.localeCompare(right.startedAt)),
      };
    });
    try {
      const ledgerPath = getWorkerLedgerPath();
      mkdirSync(dirname(ledgerPath), { recursive: true });
      const merged = new Map<string, WorkerRecord>(
        readPersistedWorkerLedgerRecords().map((entry) => [entry.workerId, JSON.parse(JSON.stringify(entry)) as WorkerRecord]),
      );
      merged.set(record.workerId, JSON.parse(JSON.stringify(record)) as WorkerRecord);
      writeFileSync(ledgerPath, JSON.stringify({
        version: 1,
        workers: [...merged.values()].sort((left, right) => left.startedAt.localeCompare(right.startedAt)),
      } satisfies PersistedWorkerLedgerFile, null, 2));
    } catch {
      // Non-fatal: worker ledger durability should not break the query control plane.
    }
  };

  const readTaskDispatcherLedgerRecords = (): TaskDispatcherRecord[] => {
    const unified = readUnifiedOrchestrationLedger();
    if (unified) {
      return unified.dispatchers
        .map((record) => ({
          ...cloneTaskDispatcherRecord(record),
          source: 'ledger' as const,
        }))
        .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
    }
    const ledgerPath = getTaskDispatcherLedgerPath();
    if (!existsSync(ledgerPath)) {
      return [];
    }
    try {
      const parsed = JSON.parse(readFileSync(ledgerPath, 'utf-8')) as PersistedTaskDispatcherLedgerFile;
      if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.dispatchers)) {
        return [];
      }
      return parsed.dispatchers
        .filter((record): record is TaskDispatcherRecord => Boolean(record && typeof record === 'object' && typeof record.dispatcherId === 'string'))
        .map((record) => ({
          ...cloneTaskDispatcherRecord(record),
          source: 'ledger' as const,
        }))
        .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
    } catch {
      return [];
    }
  };

  const persistTaskDispatcherLedgerRecord = (record: TaskDispatcherRecord): void => {
    writeUnifiedOrchestrationLedger((current) => {
      const merged = new Map<string, TaskDispatcherRecord>(
        current.dispatchers.map((entry) => [entry.dispatcherId, cloneTaskDispatcherRecord(entry)]),
      );
      merged.set(record.dispatcherId, {
        ...cloneTaskDispatcherRecord(record),
        source: 'ledger',
      });
      return {
        ...current,
        dispatchers: [...merged.values()].sort((left, right) => left.startedAt.localeCompare(right.startedAt)),
      };
    });
    try {
      const ledgerPath = getTaskDispatcherLedgerPath();
      mkdirSync(dirname(ledgerPath), { recursive: true });
      const existing = readTaskDispatcherLedgerRecords();
      const merged = new Map<string, TaskDispatcherRecord>(
        existing.map((entry) => [entry.dispatcherId, cloneTaskDispatcherRecord(entry)]),
      );
      merged.set(record.dispatcherId, {
        ...cloneTaskDispatcherRecord(record),
        source: 'ledger',
      });
      const next: PersistedTaskDispatcherLedgerFile = {
        version: 1,
        dispatchers: [...merged.values()].sort((left, right) => left.startedAt.localeCompare(right.startedAt)),
      };
      writeFileSync(ledgerPath, JSON.stringify(next, null, 2));
    } catch {
      // Non-fatal: durable ledger write failures should not break dispatcher execution.
    }
  };

  const readPersistedTaskDispatcherDiagnoses = (): TaskDispatcherHealthReport[] => {
    const unified = readUnifiedOrchestrationLedger();
    if (unified) {
      return unified.dispatcherDiagnoses
        .map((entry) => JSON.parse(JSON.stringify(entry)) as TaskDispatcherHealthReport)
        .sort((left, right) => left.observedAt.localeCompare(right.observedAt));
    }
    const ledgerPath = getTaskDispatcherDiagnosisLedgerPath();
    if (!existsSync(ledgerPath)) {
      return [];
    }
    try {
      const parsed = JSON.parse(readFileSync(ledgerPath, 'utf-8')) as PersistedTaskDispatcherDiagnosisFile;
      if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.diagnoses)) {
        return [];
      }
      return parsed.diagnoses
        .filter((entry): entry is TaskDispatcherHealthReport => Boolean(entry && typeof entry === 'object' && typeof entry.dispatcherId === 'string'))
        .map((entry) => JSON.parse(JSON.stringify(entry)) as TaskDispatcherHealthReport)
        .sort((left, right) => left.observedAt.localeCompare(right.observedAt));
    } catch {
      return [];
    }
  };

  const persistTaskDispatcherDiagnosisReport = (report: TaskDispatcherHealthReport): void => {
    writeUnifiedOrchestrationLedger((current) => {
      const merged = new Map<string, TaskDispatcherHealthReport>(
        current.dispatcherDiagnoses.map((entry) => [entry.dispatcherId, JSON.parse(JSON.stringify(entry)) as TaskDispatcherHealthReport]),
      );
      merged.set(report.dispatcherId, JSON.parse(JSON.stringify(report)) as TaskDispatcherHealthReport);
      return {
        ...current,
        dispatcherDiagnoses: [...merged.values()].sort((left, right) => left.observedAt.localeCompare(right.observedAt)),
      };
    });
    try {
      const ledgerPath = getTaskDispatcherDiagnosisLedgerPath();
      mkdirSync(dirname(ledgerPath), { recursive: true });
      const merged = new Map<string, TaskDispatcherHealthReport>(
        readPersistedTaskDispatcherDiagnoses().map((entry) => [entry.dispatcherId, JSON.parse(JSON.stringify(entry)) as TaskDispatcherHealthReport]),
      );
      merged.set(report.dispatcherId, JSON.parse(JSON.stringify(report)) as TaskDispatcherHealthReport);
      writeFileSync(ledgerPath, JSON.stringify({
        version: 1,
        diagnoses: [...merged.values()].sort((left, right) => left.observedAt.localeCompare(right.observedAt)),
      } satisfies PersistedTaskDispatcherDiagnosisFile, null, 2));
    } catch {
      // Non-fatal: diagnosis durability should not abort control-plane reads.
    }
  };

  const readLatestTaskDispatcherDiagnosis = (dispatcherId: string): TaskDispatcherHealthReport | null => {
    const normalizedDispatcherId = normalizeOptionalString(dispatcherId);
    if (!normalizedDispatcherId) {
      return null;
    }
    const storeReport = appStore.getState().dispatcherDiagnoses[normalizedDispatcherId]?.payload;
    if (storeReport) {
      return JSON.parse(JSON.stringify(storeReport)) as TaskDispatcherHealthReport;
    }
    return readPersistedTaskDispatcherDiagnoses().find((entry) => entry.dispatcherId === normalizedDispatcherId) ?? null;
  };

  const readPersistedTaskDispatcherRecords = (): TaskDispatcherRecord[] => {
    const records = new Map<string, TaskDispatcherRecord>();
    for (const record of readTaskDispatcherLedgerRecords()) {
      records.set(record.dispatcherId, cloneTaskDispatcherRecord(record));
    }
    if (sessionMgr) {
      let transcriptEntries: unknown[] = [];
      try {
        transcriptEntries = sessionMgr.readTranscript(transcriptCwd, sessionId);
      } catch {
        transcriptEntries = [];
      }

      for (const event of extractTimelineDispatcherEventsFromTranscriptEntries(transcriptEntries)) {
        const dispatcherEvent = event.dispatcherEvent;
        if (!dispatcherEvent || !event.dispatcherId || !event.teamName) {
          continue;
        }
        if (records.has(event.dispatcherId)) {
          continue;
        }
        const previous = records.get(event.dispatcherId);
        records.set(event.dispatcherId, {
          dispatcherId: event.dispatcherId,
          owner: dispatcherEvent.owner,
          teamName: event.teamName,
          source: 'transcript',
          workerType: dispatcherEvent.workerType,
          status: dispatcherEvent.status,
          pollIntervalMs: dispatcherEvent.pollIntervalMs,
          leaseMs: dispatcherEvent.leaseMs,
          maxConcurrentWorkers: dispatcherEvent.maxConcurrentWorkers,
          ...(dispatcherEvent.name ? { name: dispatcherEvent.name } : {}),
          ...(dispatcherEvent.prompt ? { prompt: dispatcherEvent.prompt } : {}),
          ...(dispatcherEvent.model ? { model: dispatcherEvent.model } : {}),
          ...(dispatcherEvent.maxTurns !== undefined ? { maxTurns: dispatcherEvent.maxTurns } : {}),
          ...(dispatcherEvent.mode ? { mode: dispatcherEvent.mode } : {}),
          ...(dispatcherEvent.cwd ? { cwd: dispatcherEvent.cwd } : {}),
          ...(dispatcherEvent.isolation ? { isolation: dispatcherEvent.isolation } : {}),
          activeTaskIds: [...dispatcherEvent.activeTaskIds],
          activeWorkerIds: [...dispatcherEvent.activeWorkerIds],
          activeAssignments: [...dispatcherEvent.activeAssignments],
          startedAt: previous?.startedAt ?? dispatcherEvent.startedAt ?? dispatcherEvent.timestamp,
          updatedAt: dispatcherEvent.updatedAt ?? dispatcherEvent.timestamp,
          ...(dispatcherEvent.lastDispatchAt || previous?.lastDispatchAt
            ? { lastDispatchAt: dispatcherEvent.lastDispatchAt ?? previous?.lastDispatchAt }
            : {}),
          ...(dispatcherEvent.stoppedAt || previous?.stoppedAt
            ? { stoppedAt: dispatcherEvent.stoppedAt ?? previous?.stoppedAt }
            : {}),
        });
      }
    }

    return [...records.values()].sort((left, right) => left.startedAt.localeCompare(right.startedAt));
  };

  queryObj.listTaskDispatchers = async (options?: TaskDispatcherListOptions) => {
    await ensureTaskDispatcherRecovery();
    const teamName = normalizeOptionalString(options?.teamName);
    const status = options?.status;
    const merged = new Map<string, TaskDispatcherRecord>();
    for (const record of Object.values(appStore.getState().dispatchers)) {
      merged.set(record.dispatcherId, cloneTaskDispatcherRecord(record.payload as TaskDispatcherRecord));
    }
    for (const record of readPersistedTaskDispatcherRecords()) {
      merged.set(record.dispatcherId, cloneTaskDispatcherRecord(record));
    }
    for (const state of taskDispatchers.values()) {
      const record = cloneTaskDispatcherRecord(syncTaskDispatcherRecord(state));
      merged.set(record.dispatcherId, record);
    }
    const records = [...merged.values()]
      .filter((record) => (!teamName || record.teamName === teamName) && (!status || record.status === status))
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
    for (const record of records) {
      upsertDispatcherStoreRecord(record);
    }
    return records;
  };

  queryObj.getTaskDispatcher = async (dispatcherId: string) => {
    await ensureTaskDispatcherRecovery();
    const normalizedDispatcherId = normalizeOptionalString(dispatcherId);
    if (!normalizedDispatcherId) {
      throw new Error('dispatcherId is required to inspect a task dispatcher.');
    }
    return (await queryObj.listTaskDispatchers()).find((record) => record.dispatcherId === normalizedDispatcherId) ?? null;
  };

  queryObj.inspectTaskDispatcherHealth = async (
    dispatcherId: string,
    options?: TaskDispatcherHealthOptions,
  ): Promise<TaskDispatcherHealthReport | null> => {
    await ensureTaskDispatcherRecovery();
    const dispatcher = await queryObj.getTaskDispatcher(dispatcherId);
    if (!dispatcher) {
      return null;
    }

    const observedAt = options?.now instanceof Date
      ? options.now.toISOString()
      : typeof options?.now === 'string'
        ? options.now
        : new Date().toISOString();
    const observedAtMs = Date.parse(observedAt);
    const heartbeatGraceMs = options?.heartbeatGraceMs ?? Math.max(dispatcher.leaseMs, dispatcher.pollIntervalMs * 4);
    const drainingTimeoutMs = options?.drainingTimeoutMs ?? Math.max(dispatcher.leaseMs, dispatcher.pollIntervalMs * 8);
    const findings: TaskDispatcherHealthFinding[] = [];

    for (const assignment of dispatcher.activeAssignments) {
      const task = await queryObj.getTask(assignment.taskId, { teamName: dispatcher.teamName });
      if (!task) {
        findings.push({
          code: 'task_missing',
          severity: 'error',
          message: `Task ${assignment.taskId} is missing for dispatcher assignment ${assignment.workerId}.`,
          observedAt,
          taskId: assignment.taskId,
          workerId: assignment.workerId,
        });
      } else {
        const leaseOwner = task.lease?.owner;
        const driftReasons: string[] = [];
        if (task.status !== 'in_progress') {
          driftReasons.push(`status=${task.status}`);
        }
        if (task.owner !== dispatcher.owner) {
          driftReasons.push(`owner=${task.owner ?? 'none'}`);
        }
        if (leaseOwner !== dispatcher.owner) {
          driftReasons.push(`leaseOwner=${leaseOwner ?? 'none'}`);
        }
        if (!task.lease) {
          driftReasons.push('lease=missing');
        }
        if (driftReasons.length > 0) {
          findings.push({
            code: 'assignment_drift',
            severity: 'warning',
            message: `Assignment ${assignment.taskId} on worker ${assignment.workerId} drifted from task state (${driftReasons.join(', ')}).`,
            observedAt,
            taskId: assignment.taskId,
            workerId: assignment.workerId,
          });
        }
      }

      const worker = await queryObj.getWorker(assignment.workerId);
      if (!worker) {
        findings.push({
          code: 'worker_missing',
          severity: 'error',
          message: `Worker ${assignment.workerId} is missing for dispatcher assignment ${assignment.taskId}.`,
          observedAt,
          taskId: assignment.taskId,
          workerId: assignment.workerId,
        });
      }

      const leaseExpiresAtMs = assignment.leaseExpiresAt ? Date.parse(assignment.leaseExpiresAt) : NaN;
      if (Number.isFinite(leaseExpiresAtMs) && leaseExpiresAtMs <= observedAtMs) {
        findings.push({
          code: 'lease_expired',
          severity: 'error',
          message: `Lease expired for task ${assignment.taskId} on worker ${assignment.workerId}.`,
          observedAt,
          taskId: assignment.taskId,
          workerId: assignment.workerId,
        });
      }

      const lastHeartbeatAtMs = assignment.lastHeartbeatAt ? Date.parse(assignment.lastHeartbeatAt) : NaN;
      if (Number.isFinite(lastHeartbeatAtMs) && observedAtMs - lastHeartbeatAtMs > heartbeatGraceMs) {
        findings.push({
          code: 'stuck_assignment',
          severity: 'warning',
          message: `Assignment ${assignment.taskId} on worker ${assignment.workerId} has not heartbeat for ${observedAtMs - lastHeartbeatAtMs}ms.`,
          observedAt,
          taskId: assignment.taskId,
          workerId: assignment.workerId,
        });
      }
    }

    const teamBudget = getConfiguredTeamDispatcherWorkerBudget(dispatcher.teamName);
    const availableTeamWorkerBudget = getAvailableDispatcherWorkerBudgetForTeam(dispatcher.teamName);
    if (
      dispatcher.status === 'running'
      && dispatcher.activeAssignments.length < dispatcher.maxConcurrentWorkers
      && teamBudget !== null
      && availableTeamWorkerBudget !== null
      && availableTeamWorkerBudget <= 0
    ) {
      const pendingTeamTasks = (await queryObj.listTasks({ teamName: dispatcher.teamName }))
        .filter((task) => task.status === 'pending');
      if (pendingTeamTasks.length > 0) {
        findings.push({
          code: 'team_quota_saturated',
          severity: 'warning',
          message: `Team ${dispatcher.teamName} exhausted its dispatcher worker quota (${teamBudget}) while pending tasks remain.`,
          observedAt,
          taskId: pendingTeamTasks[0]?.id,
        });
      }
    }

    const updatedAtMs = Date.parse(dispatcher.updatedAt);
    if (
      dispatcher.status === 'draining'
      && dispatcher.activeAssignments.length > 0
      && Number.isFinite(updatedAtMs)
      && observedAtMs - updatedAtMs > drainingTimeoutMs
    ) {
      findings.push({
        code: 'draining_timeout',
        severity: 'warning',
        message: `Dispatcher ${dispatcher.dispatcherId} has been draining for ${observedAtMs - updatedAtMs}ms with active assignments.`,
        observedAt,
      });
    }

    const summary = {
      totalFindings: findings.length,
      errorCount: findings.filter((item) => item.severity === 'error').length,
      warningCount: findings.filter((item) => item.severity === 'warning').length,
      affectedTaskIds: [...new Set(findings.map((item) => item.taskId).filter((value): value is string => typeof value === 'string'))],
      affectedWorkerIds: [...new Set(findings.map((item) => item.workerId).filter((value): value is string => typeof value === 'string'))],
    };
    const followUps = buildTaskDispatcherHealthFollowUps(dispatcher, findings);

    const report: TaskDispatcherHealthReport = {
      dispatcherId: dispatcher.dispatcherId,
      source: dispatcher.source,
      observedAt,
      healthy: findings.length === 0,
      dispatcher,
      findings,
      summary,
      followUps,
    };
    upsertDispatcherDiagnosisStoreRecord(report);
    persistTaskDispatcherDiagnosisReport(report);
    return report;
  };

  queryObj.getTaskDispatcherDiagnosis = async (dispatcherId: string) => {
    await ensureTaskDispatcherRecovery();
    const normalizedDispatcherId = normalizeOptionalString(dispatcherId);
    if (!normalizedDispatcherId) {
      throw new Error('dispatcherId is required to inspect a dispatcher diagnosis.');
    }
    const storeReport = appStore.getState().dispatcherDiagnoses[normalizedDispatcherId]?.payload;
    if (storeReport) {
      return JSON.parse(JSON.stringify(storeReport)) as TaskDispatcherHealthReport;
    }
    return readPersistedTaskDispatcherDiagnoses().find((entry) => entry.dispatcherId === normalizedDispatcherId) ?? null;
  };

  queryObj.listTaskDispatcherDiagnoses = async (options?: TaskDispatcherDiagnosisListOptions) => {
    await ensureTaskDispatcherRecovery();
    const merged = new Map<string, TaskDispatcherHealthReport>();
    for (const diagnosis of Object.values(appStore.getState().dispatcherDiagnoses)) {
      merged.set(diagnosis.dispatcherId, JSON.parse(JSON.stringify(diagnosis.payload)) as TaskDispatcherHealthReport);
    }
    for (const report of readPersistedTaskDispatcherDiagnoses()) {
      if (!merged.has(report.dispatcherId)) {
        merged.set(report.dispatcherId, JSON.parse(JSON.stringify(report)) as TaskDispatcherHealthReport);
      }
    }
    const reports = [...merged.values()]
      .filter((report) => !options?.teamName || report.dispatcher.teamName === options.teamName)
      .filter((report) => options?.healthy === undefined || report.healthy === options.healthy)
      .sort((left, right) => left.observedAt.localeCompare(right.observedAt));
    for (const report of reports) {
      upsertDispatcherDiagnosisStoreRecord(report);
    }
    return reports;
  };

  queryObj.requeueTaskDispatcherAssignment = async (
    input: TaskDispatcherRequeueInput,
  ): Promise<TaskDispatcherRequeueResult> => {
    const dispatcherId = normalizeOptionalString(input.dispatcherId);
    if (!dispatcherId) {
      throw new Error('dispatcherId is required to requeue a task dispatcher assignment.');
    }

    const state = taskDispatchers.get(dispatcherId);
    if (!state) {
      return { success: false, dispatcher: null, task: null };
    }
    const readTaskRecord = (taskIdToRead: string): TaskRecord | null => {
      const task = getTaskManager(state.record.teamName).get(taskIdToRead);
      return task ? toTaskRecord(task, state.record.teamName) : null;
    };

    const workerId = normalizeOptionalString(input.workerId);
    const taskId = normalizeOptionalString(input.taskId);
    if (!workerId && !taskId) {
      throw new Error('workerId or taskId is required to requeue a task dispatcher assignment.');
    }

    const assignment = workerId
      ? state.activeAssignments.get(workerId) ?? null
      : [...state.activeAssignments.values()].find((item) => item.taskId === taskId) ?? null;
    if (!assignment) {
      return {
        success: false,
        dispatcher: cloneTaskDispatcherRecord(syncTaskDispatcherRecord(state)),
        task: taskId ? readTaskRecord(taskId) : null,
      };
    }

    const workerStop = input.stopWorker === false ? undefined : await queryObj.stopWorker(assignment.workerId);
    state.activeAssignments.delete(assignment.workerId);
    taskDispatcherByWorkerId.delete(assignment.workerId);

    let taskRecord: TaskRecord | null = null;
    try {
      taskRecord = toTaskRecord(
        getTaskManager(state.record.teamName).releaseLease(
          assignment.taskId,
          state.record.owner,
          'pending',
        ),
        state.record.teamName,
      );
    } catch {
      taskRecord = readTaskRecord(assignment.taskId);
    }

    syncTaskDispatcherRecord(state);
    emitTaskDispatcherOrchestrationEvent(state, 'task_requeued', {
      taskId: assignment.taskId,
      workerId: assignment.workerId,
      taskStatus: 'pending',
    });
    if (state.record.status === 'draining' && state.activeAssignments.size === 0) {
      markTaskDispatcherStopped(state);
    } else if (state.record.status === 'running') {
      scheduleTaskDispatcherRun(state, 0);
    }

    return {
      success: true,
      dispatcher: cloneTaskDispatcherRecord(syncTaskDispatcherRecord(state)),
      task: taskRecord,
      ...(workerStop ? { workerStop } : {}),
    };
  };

  queryObj.stopTaskDispatcher = async (dispatcherId: string): Promise<TaskDispatcherStopResult> => {
    const normalizedDispatcherId = normalizeOptionalString(dispatcherId);
    if (!normalizedDispatcherId) {
      throw new Error('dispatcherId is required to stop a task dispatcher.');
    }

    const state = taskDispatchers.get(normalizedDispatcherId);
    if (!state) {
      return { success: false, dispatcher: null };
    }

    if (state.record.status === 'stopped') {
      return {
        success: false,
        dispatcher: cloneTaskDispatcherRecord(syncTaskDispatcherRecord(state)),
      };
    }

    state.record.status = state.activeAssignments.size > 0 ? 'draining' : 'stopped';
    if (state.record.status === 'stopped') {
      markTaskDispatcherStopped(state);
    } else {
      setTaskDispatcherSchedulerState(state, 'draining');
      emitTaskDispatcherOrchestrationEvent(state, 'draining');
      scheduleTaskDispatcherRun(state, 0);
    }
    return {
      success: true,
      dispatcher: cloneTaskDispatcherRecord(syncTaskDispatcherRecord(state)),
    };
  };

  queryObj.listBackgroundTasks = async () => {
    const bashTasks = listPersistedBackgroundTasks().map((task) => ({
      task_id: task.taskId,
      type: 'bash' as const,
      status: task.status,
      summary: task.summary ?? task.error ?? task.status,
      session_id: task.sessionId,
      cwd: task.cwd,
      output_file: task.outputFile,
      command: task.command,
      started_at: task.startTime,
    }));

    const persistedAgentExecutor = sdkAgentExecutor ?? new AgentExecutor();
    const agentTasks = persistedAgentExecutor.listPersistedAgents().map((session) => ({
      task_id: session.agentId,
      type: 'agent' as const,
      status: session.state === 'running'
        ? 'running'
        : session.state === 'completed'
          ? 'completed'
          : session.state === 'shutdown'
            ? 'stopped'
            : 'failed',
      summary: summarizePlainText(session.result ?? session.error),
      session_id: session.parentSessionId,
      cwd: session.cwd,
      output_file: session.outputFile,
      command: session.name ?? session.agentType,
      started_at: session.startedAt ? new Date(session.startedAt).getTime() : undefined,
    }));

    return [...bashTasks, ...agentTasks]
      .sort((left, right) => (right.started_at ?? 0) - (left.started_at ?? 0));
  };

  queryObj.getBackgroundTask = async (taskId: string, options?: { block?: boolean; timeout?: number }) => {
    const taskOutputTool = createTaskOutputTool({
      getBackgroundAgent: (agentId) => {
        if (!sdkAgentExecutor) return null;
        const session = sdkAgentExecutor.getAgent(agentId);
        if (!session) return null;
        return {
          status: session.state === 'running'
            ? 'running'
            : session.state === 'completed'
              ? 'completed'
              : session.state === 'shutdown'
                ? 'stopped'
                : 'failed',
          output_file: session.outputFile ?? '',
          result: session.result,
          summary: summarizePlainText(session.result ?? session.error),
          team_name: session.teamName,
          description: session.name ?? session.agentType,
          usage: {
            total_tokens: session.totalTokens ?? 0,
            tool_uses: session.totalToolUseCount ?? 0,
            duration_ms: session.durationMs,
          },
        };
      },
      stopBackgroundAgent: (agentId) => sdkAgentExecutor?.stopAgent(agentId) ?? false,
    });

    const raw = await taskOutputTool.execute({
      task_id: taskId,
      block: options?.block ?? false,
      timeout: options?.timeout ?? 1000,
    }, { cwd, sessionId });

    if (typeof raw === 'string' && raw.startsWith('Error: No task found')) {
      return null;
    }

    return buildBackgroundTaskInspectionFromPayload(raw, taskId);
  };

  queryObj.stopTask = async (_taskId: string) => {
    const taskId = _taskId;
    const taskStopTool = createTaskStopTool({
      getBackgroundAgent: (agentId) => {
        if (!sdkAgentExecutor) return null;
        const session = sdkAgentExecutor.getAgent(agentId);
        if (!session) return null;
        return {
          status: session.state === 'running'
            ? 'running'
            : session.state === 'completed'
              ? 'completed'
              : session.state === 'shutdown'
                ? 'stopped'
                : 'failed',
          output_file: session.outputFile ?? '',
          result: session.result,
          summary: summarizePlainText(session.result ?? session.error),
          team_name: session.teamName,
          description: session.name ?? session.agentType,
          usage: {
            total_tokens: session.totalTokens ?? 0,
            tool_uses: session.totalToolUseCount ?? 0,
            duration_ms: session.durationMs,
          },
        };
      },
      stopBackgroundAgent: (agentId) => sdkAgentExecutor?.stopAgent(agentId) ?? false,
    });

    const raw = await taskStopTool.execute({ task_id: taskId }, { cwd, sessionId });
    if (typeof raw === 'string' && raw.startsWith('Error: No task found')) {
      touchSessionState({
        status: 'closed',
        activeTurn: false,
        idleReason: 'stopped',
      });
      abortQuery(false);
      cleanupQueryResources();
      finalizeGenerator();
      return;
    }
  };

  queryObj.close = () => {
    touchSessionState({
      status: 'closed',
      activeTurn: false,
      idleReason: 'closed',
    });
    abortQuery(false);
    cleanupQueryResources();
    finalizeGenerator();
  };

  // ── MCP dynamic management ────────────────────────────────────────────────

  queryObj.reconnectMcpServer = async (serverName: string) => {
    if (!hasConfiguredMcpServers) {
      throw new Error('No MCP manager configured for this query. Pass mcpServers in QueryOptions.');
    }
    await runtime.reconnectMcpServer(serverName);
    mcpReadyPromise = runtime.waitForMcpReady();
    refreshManagedSystemPrompt();
    syncLoopToolsFromRegistry();
    syncAppRuntimeControlPlane();
    const status = runtime.listMcpServerStatus().find((conn) => conn.name === serverName);
    if (!status) {
      throw new Error(`MCP server '${serverName}' not found after reconnect.`);
    }
    if (status.status !== 'connected') {
      const reason = status.error ?? status.status;
      throw new Error(`Failed to reconnect MCP server '${serverName}': ${reason}`);
    }
  };

  queryObj.toggleMcpServer = async (serverName: string, enabled: boolean) => {
    if (!hasConfiguredMcpServers) {
      throw new Error('No MCP manager configured for this query. Pass mcpServers in QueryOptions.');
    }
    await runtime.toggleMcpServer(serverName, enabled);
    mcpReadyPromise = runtime.waitForMcpReady();
    refreshManagedSystemPrompt();
    syncLoopToolsFromRegistry();
    syncAppRuntimeControlPlane();
    if (enabled) {
      const status = runtime.listMcpServerStatus().find((conn) => conn.name === serverName);
      if (!status) {
        throw new Error(`MCP server '${serverName}' not found after toggle.`);
      }
      if (status.status !== 'connected') {
        const reason = status.error ?? status.status;
        throw new Error(`Failed to enable MCP server '${serverName}': ${reason}`);
      }
    }
  };

  queryObj.setMcpServers = async (servers) => {
    hasConfiguredMcpServers = true;
    const result = await runtime.setMcpServers(servers);
    mcpReadyPromise = runtime.waitForMcpReady();
    refreshManagedSystemPrompt();
    syncLoopToolsFromRegistry();
    syncAppRuntimeControlPlane();
    return result;
  };

  // ── File checkpointing ────────────────────────────────────────────────────

  queryObj.rewindFiles = async (
    userMessageId: string,
    options?: { dryRun?: boolean },
  ): Promise<RewindFilesResult> => {
    if (!fileCheckpoint) {
      return {
        canRewind: false,
        error: 'File checkpointing is not enabled.',
      };
    }
    const requestedId = resolveRewindCheckpointId(
      fileCheckpoint.list(),
      sessionMgr,
      cwd,
      sessionId,
      userMessageId,
    );
    const targets = fileCheckpoint.getRewindTargets(requestedId);
    if (!targets) {
      return {
        canRewind: false,
        error: `Checkpoint not found: ${userMessageId}`,
      };
    }
    const uniqueTarget = targets.map((t) => t.filePath);
    const beforeSnapshots = new Map<string, string | null>();
    for (const target of targets) {
      beforeSnapshots.set(target.filePath, readFileMaybe(target.filePath));
    }
    if (options?.dryRun) {
      const previewStats = accumulateRewindStats(
        targets,
        beforeSnapshots,
        new Set(uniqueTarget),
      );
      return {
        canRewind: true,
        filesChanged: uniqueTarget,
        insertions: previewStats.insertions,
        deletions: previewStats.deletions,
        rewindCount: uniqueTarget.length,
      };
    }
    const { restored, errors } = fileCheckpoint.rewindTo(requestedId);
    const restoredSet = new Set(restored);
    const appliedStats = accumulateRewindStats(targets, beforeSnapshots, restoredSet);
    return {
      canRewind: errors.length === 0,
      filesChanged: [...new Set(restored)],
      insertions: appliedStats.insertions,
      deletions: appliedStats.deletions,
      rewindCount: restored.length,
      ...(errors.length > 0 ? { error: errors.join('\n') } : {}),
    };
  };

  // ── Mid-stream input ──────────────────────────────────────────────────────

  queryObj.streamInput = async (input: AsyncIterable<SDKUserMessage> | string): Promise<void> => {
    if (typeof prompt === 'string') {
      throw new Error('streamInput() requires async-iterable prompt mode.');
    }
    if (inputClosed || internalAbortController.signal.aborted) {
      throw new Error('streamInput() cannot be used after the query is closed or interrupted.');
    }
    if (typeof input === 'string') {
      pushQueuedInput({
        type: 'user',
        message: input,
        parent_tool_use_id: null,
        session_id: sessionId,
        uuid: randomUUID(),
      } as SDKUserMessage);
      return;
    }
    for await (const msg of input) {
      pushQueuedInput(msg);
    }
  };

  return queryObj;
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

type LoadedPluginRuntime = {
  loadedPlugins: LoadedPlugin[];
  plugins: RuntimePluginSummary[];
  hooks: RuntimeHookSummary[];
  diagnostics: RuntimeDiagnostic[];
  hookConfig: Partial<Record<HookEvent, any[]>>;
  commands: SlashCommand[];
  agents: Record<string, AgentDefinition>;
  mcpServers: Record<string, McpServerConfig>;
};

const VALID_HOOK_EVENT_NAMES = new Set<string>(HOOK_EVENTS);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isValidPluginAgentDefinition(definition: AgentDefinition): boolean {
  if (!definition || typeof definition !== 'object') return false;
  if (!isNonEmptyString(definition.prompt)) return false;
  if (definition.tools !== undefined && !isStringArray(definition.tools)) return false;
  if (definition.disallowedTools !== undefined && !isStringArray(definition.disallowedTools)) return false;
  return true;
}

function isValidPluginCommandDefinition(command: CommandDefinition | undefined): command is CommandDefinition {
  return Boolean(command)
    && isNonEmptyString(command?.name)
    && isNonEmptyString(command?.prompt);
}

function isValidPluginSkillDefinition(skill: SkillDefinition | undefined): skill is SkillDefinition {
  return Boolean(skill)
    && isNonEmptyString(skill?.name)
    && isNonEmptyString(skill?.prompt);
}

function isValidPluginHookDefinition(hook: HookConfig | undefined): hook is HookConfig {
  return Boolean(hook)
    && typeof hook === 'object'
    && isNonEmptyString(hook?.command)
    && (hook.timeout === undefined || typeof hook.timeout === 'number');
}

function sanitizePluginManifest(
  manifest: PluginManifest,
  diagnostics: RuntimeDiagnostic[],
): PluginManifest {
  const sanitizedHooks: Record<string, HookConfig[]> = {};
  for (const [event, entries] of Object.entries(manifest.hooks ?? {})) {
    if (!VALID_HOOK_EVENT_NAMES.has(event)) {
      diagnostics.push({
        code: 'plugin_invalid_hook_event',
        message: `Plugin "${manifest.name}" declares unsupported hook event "${event}".`,
        severity: 'warning',
        source: 'hook',
      });
      continue;
    }
    if (!Array.isArray(entries)) {
      diagnostics.push({
        code: 'plugin_invalid_hook_definition',
        message: `Plugin "${manifest.name}" hook event "${event}" must be an array of hook definitions.`,
        severity: 'warning',
        source: 'hook',
      });
      continue;
    }
    const validEntries = entries.filter((entry) => {
      const valid = isValidPluginHookDefinition(entry);
      if (!valid) {
        diagnostics.push({
          code: 'plugin_invalid_hook_definition',
          message: `Plugin "${manifest.name}" has an invalid hook definition under "${event}".`,
          severity: 'warning',
          source: 'hook',
        });
      }
      return valid;
    });
    if (validEntries.length > 0) {
      sanitizedHooks[event] = validEntries;
    }
  }

  const sanitizedAgents: Record<string, AgentDefinition> = {};
  for (const [name, definition] of Object.entries(manifest.agents ?? {})) {
    if (!isValidPluginAgentDefinition(definition)) {
      diagnostics.push({
        code: 'plugin_invalid_agent_definition',
        message: `Plugin "${manifest.name}" agent "${name}" is missing required schema fields.`,
        severity: 'warning',
        source: 'agent',
      });
      continue;
    }
    sanitizedAgents[name] = definition;
  }

  const sanitizedCommands = (manifest.commands ?? []).filter((command) => {
    const valid = isValidPluginCommandDefinition(command);
    if (!valid) {
      diagnostics.push({
        code: 'plugin_invalid_command_definition',
        message: `Plugin "${manifest.name}" contains a command with missing name or prompt.`,
        severity: 'warning',
        source: 'plugin',
      });
    }
    return valid;
  });

  const sanitizedSkills = (manifest.skills ?? []).filter((skill) => {
    const valid = isValidPluginSkillDefinition(skill);
    if (!valid) {
      diagnostics.push({
        code: 'plugin_invalid_skill_definition',
        message: `Plugin "${manifest.name}" contains a skill with missing name or prompt.`,
        severity: 'warning',
        source: 'plugin',
      });
    }
    return valid;
  });

  const sanitizedMcpServers = Object.fromEntries(
    Object.entries(manifest.mcpServers ?? {}).filter(([, config]) => {
      const valid = Boolean(config && typeof config === 'object');
      if (!valid) {
        diagnostics.push({
          code: 'plugin_invalid_mcp_definition',
          message: `Plugin "${manifest.name}" contains an invalid MCP server definition.`,
          severity: 'warning',
          source: 'plugin',
        });
      }
      return valid;
    }),
  );

  return {
    ...manifest,
    hooks: sanitizedHooks,
    agents: sanitizedAgents,
    commands: sanitizedCommands,
    skills: sanitizedSkills,
    mcpServers: sanitizedMcpServers,
  };
}

function loadConfiguredPlugins(
  cwd: string,
  pluginConfigs?: Array<{ type: 'local'; path: string }>,
): LoadedPluginRuntime {
  if (!Array.isArray(pluginConfigs) || pluginConfigs.length === 0) {
    return {
      loadedPlugins: [],
      plugins: [],
      hooks: [],
      diagnostics: [],
      hookConfig: {},
      commands: [],
      agents: {},
      mcpServers: {},
    };
  }

  const loader = new PluginLoader();
  const diagnostics: RuntimeDiagnostic[] = [];
  const hookSources = new Map<string, Set<string>>();
  const hookConfig: Partial<Record<HookEvent, any[]>> = {};
  const commands: SlashCommand[] = [];
  const agents: Record<string, AgentDefinition> = {};
  const mcpServers: Record<string, McpServerConfig> = {};
  const loadedPlugins: LoadedPlugin[] = [];
  const pluginSummaries: RuntimePluginSummary[] = [];
  const commandNames = new Set<string>();
  const skillNames = new Set<string>();

  for (const pluginConfig of pluginConfigs) {
    const plugin = loader.loadPlugin(resolvePluginPath(cwd, pluginConfig.path));
    if (!plugin) {
      diagnostics.push({
        code: 'plugin_load_failed',
        message: `Failed to load plugin from ${pluginConfig.path}`,
        severity: 'warning',
        source: 'plugin',
      });
      continue;
    }

    loadedPlugins.push(plugin);
    const manifest = sanitizePluginManifest(plugin.manifest, diagnostics);
    loadedPlugins[loadedPlugins.length - 1] = {
      ...plugin,
      manifest,
    };
    let hookCount = 0;
    for (const [event, entries] of Object.entries(manifest.hooks ?? {}) as [HookEvent, any[]][]) {
      if (!Array.isArray(entries) || entries.length === 0) continue;
      hookCount += entries.length;
      hookConfig[event] = [...(hookConfig[event] ?? []), ...entries];
      const sourceSet = hookSources.get(event) ?? new Set<string>();
      sourceSet.add(manifest.name);
      hookSources.set(event, sourceSet);
    }

    for (const [name, definition] of Object.entries(manifest.agents ?? {})) {
      if (agents[name]) {
        diagnostics.push({
          code: 'plugin_agent_collision',
          message: `Plugin agent "${name}" from ${manifest.name} overrides an earlier plugin agent definition.`,
          severity: 'warning',
          source: 'agent',
        });
      }
      agents[name] = definition;
    }

    for (const [name, config] of Object.entries(manifest.mcpServers ?? {})) {
      if (mcpServers[name]) {
        diagnostics.push({
          code: 'plugin_mcp_collision',
          message: `Plugin MCP server "${name}" from ${manifest.name} overrides an earlier plugin MCP configuration.`,
          severity: 'warning',
          source: 'plugin',
        });
      }
      mcpServers[name] = config;
    }

    for (const command of manifest.commands ?? []) {
      const slashName = command.name.startsWith('/') ? command.name : `/${command.name}`;
      if (commandNames.has(slashName)) {
        diagnostics.push({
          code: 'plugin_command_collision',
          message: `Plugin command "${slashName}" from ${manifest.name} duplicates an existing plugin command name.`,
          severity: 'warning',
          source: 'plugin',
        });
        continue;
      }
      commandNames.add(slashName);
      commands.push({
        name: slashName,
        description: command.description,
        argumentHint: command.argumentHint ?? '',
      });
    }

    for (const skill of manifest.skills ?? []) {
      if (skillNames.has(skill.name)) {
        diagnostics.push({
          code: 'plugin_skill_collision',
          message: `Plugin skill "${skill.name}" from ${manifest.name} overrides an earlier plugin skill definition.`,
          severity: 'warning',
          source: 'plugin',
        });
      }
      skillNames.add(skill.name);
    }

    pluginSummaries.push({
      name: manifest.name,
      path: plugin.path,
      version: manifest.version,
      enabled: plugin.enabled,
      agentCount: Object.keys(manifest.agents ?? {}).length,
      skillCount: manifest.skills?.length ?? 0,
      commandCount: manifest.commands?.length ?? 0,
      mcpServerCount: Object.keys(manifest.mcpServers ?? {}).length,
      hookEventCount: Object.keys(manifest.hooks ?? {}).length,
      hookCount,
    });
  }

  const hooks: RuntimeHookSummary[] = Object.entries(hookConfig).map(([event, entries]) => ({
    event,
    count: entries.length,
    sources: [...(hookSources.get(event as HookEvent) ?? new Set<string>())].sort(),
  }));

  return {
    loadedPlugins,
    plugins: pluginSummaries.sort((a, b) => a.name.localeCompare(b.name)),
    hooks: hooks.sort((a, b) => a.event.localeCompare(b.event)),
    diagnostics,
    hookConfig,
    commands,
    agents,
    mcpServers,
  };
}

function resolvePluginPath(cwd: string, pluginPath: string): string {
  if (pluginPath.startsWith('/')) {
    return pluginPath;
  }
  return join(cwd, pluginPath);
}

function registerConfiguredPluginSkills(
  runtime: OpenAgentRuntime,
  loadedPlugins: LoadedPlugin[],
  includePluginSkills: boolean | undefined,
): void {
  if (includePluginSkills === false) return;

  for (const plugin of loadedPlugins) {
    for (const skill of plugin.manifest.skills ?? []) {
      runtime.skillRegistry.register({
        name: skill.name,
        description: skill.description,
        prompt: skill.prompt,
        source: 'plugin',
        sourceLabel: `plugin:${plugin.manifest.name}`,
        allowedTools: skill.allowedTools,
        activationKeywords: skill.activationKeywords,
      });
    }
  }
}

function mergeHookConfigs(
  ...configs: Array<Partial<Record<HookEvent, any[]>> | undefined>
): Partial<Record<HookEvent, any[]>> {
  const merged: Partial<Record<HookEvent, any[]>> = {};
  for (const config of configs) {
    if (!config) continue;
    for (const [event, hooks] of Object.entries(config) as [HookEvent, any[]][]) {
      if (!Array.isArray(hooks) || hooks.length === 0) continue;
      merged[event] = [...(merged[event] ?? []), ...hooks];
    }
  }
  return merged;
}

function mergeMcpServerConfigs(
  ...configs: Array<Record<string, McpServerConfig> | undefined>
): Record<string, McpServerConfig> {
  return Object.assign({}, ...configs.filter((config): config is Record<string, McpServerConfig> => Boolean(config)));
}

function mapAgentLoaderDiagnostics(
  diagnostics: AgentLoaderDiagnostic[],
): RuntimeDiagnostic[] {
  return diagnostics.map((entry) => ({
    code: entry.code,
    message: entry.message,
    severity: entry.severity,
    source: entry.source,
  }));
}

function loadAvailableAgents(
  cwd: string,
  overrides?: Record<string, AgentDefinition>,
): {
  availableAgents: Map<string, AgentDefinition>;
  diagnostics: RuntimeDiagnostic[];
} {
  const loader = new AgentLoader();
  loader.loadDefaults(cwd);
  if (overrides) {
    for (const [name, definition] of Object.entries(overrides)) {
      loader.register(name, definition);
    }
  }
  return {
    availableAgents: new Map(loader.list()),
    diagnostics: mapAgentLoaderDiagnostics(loader.getDiagnostics()),
  };
}

function resolveSelectedAgent(
  requested: string | undefined,
  availableAgents: Map<string, AgentDefinition>,
): AgentDefinition | undefined {
  if (!requested) return undefined;
  const exact = availableAgents.get(requested);
  if (exact) return exact;

  const lowered = requested.toLowerCase();
  for (const [name, definition] of availableAgents.entries()) {
    if (name.toLowerCase() === lowered) {
      return definition;
    }
  }
  throw new Error(`Agent "${requested}" not found.`);
}

function buildAgentInfoList(availableAgents: Map<string, AgentDefinition>): AgentInfo[] {
  return [...availableAgents.entries()].map(([name, definition]) => {
    const model = resolveAgentModel(definition.model);
    return {
      name,
      description: definition?.description ?? '',
      ...(model ? { model } : {}),
    };
  });
}

function resolveAgentModel(
  model: AgentDefinition['model'] | undefined,
): string | undefined {
  switch (model) {
    case undefined:
    case 'inherit':
      return undefined;
    case 'sonnet':
      return 'claude-sonnet-4-6';
    case 'opus':
      return 'claude-opus-4-6';
    case 'haiku':
      return 'claude-haiku-4-5-20251001';
    default:
      return String(model);
  }
}

function applyUpdatedInput(
  targetInput: unknown,
  updatedInput: unknown,
): void {
  if (!targetInput || typeof targetInput !== 'object') return;
  if (!updatedInput || typeof updatedInput !== 'object') return;
  Object.assign(targetInput as Record<string, unknown>, updatedInput as Record<string, unknown>);
}

export function __internal_extractUserMessagePrompt(
  userMsg: SDKUserMessage,
): string | Message['content'] | undefined {
  const msg = userMsg.message;
  if (typeof msg === 'string') return msg;
  if (msg && typeof msg === 'object') {
    // { role, content: string | ContentBlock[] }
    const content = (msg as Record<string, unknown>).content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content.length > 0 ? (content as Message['content']) : undefined;
    }
  }
  return undefined;
}

/**
 * Heuristic: decide if an error looks like a model-level failure (e.g. model
 * not found, overloaded) where switching to a fallback model might help.
 * Handles both English and Chinese error messages from various providers.
 */
function isModelError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  const msgOriginal = err instanceof Error ? err.message : String(err);
  return (
    // English keywords
    msg.includes('model') ||
    msg.includes('not found') ||
    msg.includes('overloaded') ||
    msg.includes('capacity') ||
    msg.includes('unavailable') ||
    msg.includes('529') || // Anthropic overloaded HTTP status
    // Chinese keywords (e.g. zhipu/bigmodel API)
    msgOriginal.includes('模型') ||
    msgOriginal.includes('不存在') ||
    msgOriginal.includes('过载') ||
    msgOriginal.includes('不可用')
  );
}

function mapMcpStatus(
  status: 'connected' | 'connecting' | 'failed' | 'needs-auth' | 'error' | 'pending' | 'disabled' | 'disconnected',
): 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled' {
  if (status === 'connected') return 'connected';
  if (status === 'needs-auth') return 'needs-auth';
  if (status === 'disabled') return 'disabled';
  if (status === 'connecting' || status === 'pending') return 'pending';
  return 'failed';
}

function sanitizeMcpStatusConfig(config: unknown): McpServerStatusConfig | undefined {
  if (!config || typeof config !== 'object') return undefined;
  const c = config as Record<string, unknown>;
  if ((c.type === undefined || c.type === 'stdio') && typeof c.command === 'string') {
    const env = c.env && typeof c.env === 'object'
      ? Object.fromEntries(
          Object.entries(c.env as Record<string, unknown>)
            .filter(([k, v]) => typeof k === 'string' && typeof v === 'string'),
        )
      : undefined;
    return {
      type: 'stdio',
      command: c.command,
      ...(Array.isArray(c.args) ? { args: c.args } : {}),
      ...(env ? { env } : {}),
    } as McpServerStatusConfig;
  }
  if (c.type === 'sse' || c.type === 'http') {
    const headers = c.headers && typeof c.headers === 'object'
      ? Object.fromEntries(
          Object.entries(c.headers as Record<string, unknown>)
            .filter(([k, v]) => typeof k === 'string' && typeof v === 'string'),
        )
      : undefined;
    return {
      type: c.type,
      url: c.url,
      ...(headers ? { headers } : {}),
    } as McpServerStatusConfig;
  }
  if (c.type === 'sdk') {
    return {
      type: 'sdk',
      name: c.name,
    } as McpServerStatusConfig;
  }
  if (c.type === 'claudeai-proxy') {
    return {
      type: 'claudeai-proxy',
      url: c.url,
      id: c.id,
    } as McpServerStatusConfig;
  }
  return undefined;
}

function resolveRewindCheckpointId(
  checkpoints: Array<{ toolUseId: string }>,
  sessionManager: SessionManager | null,
  cwd: string,
  sessionId: string,
  userMessageId: string,
): string {
  if (checkpoints.some((c) => c.toolUseId === userMessageId)) {
    return userMessageId;
  }
  if (!sessionManager) return userMessageId;

  let transcript: unknown[] = [];
  try {
    transcript = sessionManager.readTranscript(cwd, sessionId);
  } catch {
    return userMessageId;
  }

  const start = transcript.findIndex((entry) => {
    const e = entry as Record<string, unknown>;
    return e.type === 'user' && e.uuid === userMessageId;
  });
  if (start === -1) return userMessageId;

  for (let i = start + 1; i < transcript.length; i++) {
    const e = transcript[i] as Record<string, unknown>;
    if (e.type === 'user') break;
    if (e.type === 'tool_result' && typeof e.tool_use_id === 'string') {
      return e.tool_use_id;
    }
  }
  return userMessageId;
}

interface PromptSuggestionObservation {
  toolNames: Set<string>;
  sawTask: boolean;
  sawSubagent: boolean;
  sawTaskCompletion: boolean;
  sawTaskFailure: boolean;
  sawTaskStopped: boolean;
  sawEdit: boolean;
  sawWrite: boolean;
  sawBash: boolean;
  sawGit: boolean;
  sawTesting: boolean;
  sawResearch: boolean;
  sawFailure: boolean;
  sawResultError: boolean;
  lastTaskId?: string;
  lastTaskStatus?: SDKTaskNotificationMessage['status'];
  lastTaskTeamName?: string;
  lastTaskDescription?: string;
  lastTaskTemplates?: SDKTaskNotificationMessage['orchestration_templates'];
}

function createPromptSuggestionObservation(): PromptSuggestionObservation {
  return {
    toolNames: new Set<string>(),
    sawTask: false,
    sawSubagent: false,
    sawTaskCompletion: false,
    sawTaskFailure: false,
    sawTaskStopped: false,
    sawEdit: false,
    sawWrite: false,
    sawBash: false,
    sawGit: false,
    sawTesting: false,
    sawResearch: false,
    sawFailure: false,
    sawResultError: false,
  };
}

function recordTaskNotificationObservation(
  observation: PromptSuggestionObservation,
  message: Pick<SDKTaskNotificationMessage, 'task_id' | 'status' | 'team_name' | 'description' | 'orchestration_templates'>,
): void {
  observation.sawTask = true;
  observation.sawSubagent = true;
  observation.lastTaskId = normalizeOptionalString(message.task_id) ?? observation.lastTaskId;
  observation.lastTaskStatus = message.status;
  observation.lastTaskTeamName = normalizeOptionalString(message.team_name) ?? observation.lastTaskTeamName;
  observation.lastTaskDescription = normalizeOptionalString(message.description) ?? observation.lastTaskDescription;
  observation.lastTaskTemplates = message.orchestration_templates ?? observation.lastTaskTemplates;

  if (message.status === 'completed') {
    observation.sawTaskCompletion = true;
    return;
  }
  if (message.status === 'failed') {
    observation.sawTaskFailure = true;
    return;
  }
  observation.sawTaskStopped = true;
}

function decodeTaskNotificationXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function extractTaskNotificationTag(block: string, tag: string): string | undefined {
  const match = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i'));
  if (!match) return undefined;
  return normalizeOptionalString(decodeTaskNotificationXml(match[1] ?? ''));
}

function extractTaskNotificationsFromText(
  text: string,
): Array<Pick<SDKTaskNotificationMessage, 'task_id' | 'status' | 'team_name' | 'description' | 'orchestration_templates'>> {
  const notifications: Array<Pick<SDKTaskNotificationMessage, 'task_id' | 'status' | 'team_name' | 'description' | 'orchestration_templates'>> = [];
  const matches = text.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/gi);

  for (const match of matches) {
    const block = match[1] ?? '';
    const taskId = extractTaskNotificationTag(block, 'task-id');
    const status = extractTaskNotificationTag(block, 'status');
    const teamName = extractTaskNotificationTag(block, 'team-name');
    const description = extractTaskNotificationTag(block, 'description');
    if (!taskId || !status) continue;
    if (status !== 'completed' && status !== 'failed' && status !== 'stopped') continue;
    const orchestrationBlockMatch = block.match(/<orchestration-templates>([\s\S]*?)<\/orchestration-templates>/i);
    const orchestrationBlock = orchestrationBlockMatch?.[1] ?? '';
    const resumePromptTemplate = orchestrationBlock
      ? extractTaskNotificationTag(orchestrationBlock, 'resume-prompt-template')
      : undefined;
    const verificationPromptTemplate = orchestrationBlock
      ? extractTaskNotificationTag(orchestrationBlock, 'verification-prompt-template')
      : undefined;
    const retryPromptTemplate = orchestrationBlock
      ? extractTaskNotificationTag(orchestrationBlock, 'retry-prompt-template')
      : undefined;
    notifications.push({
      task_id: taskId,
      status,
      ...(teamName ? { team_name: teamName } : {}),
      ...(description ? { description } : {}),
      ...(
        resumePromptTemplate || verificationPromptTemplate || retryPromptTemplate
          ? {
              orchestration_templates: {
                ...(resumePromptTemplate ? { resume_prompt_template: resumePromptTemplate } : {}),
                ...(verificationPromptTemplate ? { verification_prompt_template: verificationPromptTemplate } : {}),
                ...(retryPromptTemplate ? { retry_prompt_template: retryPromptTemplate } : {}),
              },
            }
          : {}
      ),
    });
  }

  return notifications;
}

function extractTaskNotificationsFromConversationMessage(
  message: Message,
): Array<Pick<SDKTaskNotificationMessage, 'task_id' | 'status' | 'team_name' | 'description' | 'orchestration_templates'>> {
  const content = (message as any)?.content;
  if (typeof content === 'string') {
    return extractTaskNotificationsFromText(content);
  }
  if (!Array.isArray(content)) {
    return [];
  }

  const notifications: Array<Pick<SDKTaskNotificationMessage, 'task_id' | 'status' | 'team_name' | 'description' | 'orchestration_templates'>> = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type !== 'text' || typeof block.text !== 'string') continue;
    notifications.push(...extractTaskNotificationsFromText(block.text));
  }
  return notifications;
}

export function __internal_collectTrailingTaskNotifications(
  messages: Message[],
): Array<Pick<SDKTaskNotificationMessage, 'task_id' | 'status' | 'team_name' | 'description' | 'orchestration_templates'>> {
  const trailing: Array<Pick<SDKTaskNotificationMessage, 'task_id' | 'status' | 'team_name' | 'description' | 'orchestration_templates'>> = [];

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const notifications = extractTaskNotificationsFromConversationMessage(messages[index]!);
    if (notifications.length === 0) break;
    trailing.unshift(...notifications);
  }

  return trailing;
}

function recordPromptSuggestionObservation(
  observation: PromptSuggestionObservation,
  message: SDKMessage,
): void {
  if (message.type === 'assistant') {
    const content = (message as any).message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== 'object' || block.type !== 'tool_use') continue;
        const toolName = typeof block.name === 'string' ? block.name : undefined;
        if (!toolName) continue;
        observation.toolNames.add(toolName);

        if (toolName === 'Task' || toolName === 'TaskOutput' || toolName === 'TaskStop') {
          observation.sawTask = true;
        }
        if (toolName === 'Edit' || toolName === 'NotebookEdit') {
          observation.sawEdit = true;
        }
        if (toolName === 'Write') {
          observation.sawWrite = true;
        }
        if (toolName === 'Bash') {
          observation.sawBash = true;
          const command = typeof block.input?.command === 'string' ? block.input.command : '';
          if (/\bgit\b/i.test(command)) observation.sawGit = true;
          if (/\b(test|tests|pytest|vitest|jest|bun test|npm test|pnpm test|yarn test|cargo test|go test)\b/i.test(command)) {
            observation.sawTesting = true;
          }
        }
        if ([
          'Read',
          'Glob',
          'Grep',
          'WebSearch',
          'WebFetch',
          'ToolSearch',
          'Skill',
          'ListMcpResourcesTool',
          'ReadMcpResourceTool',
        ].includes(toolName)) {
          observation.sawResearch = true;
        }
      }
    }
    return;
  }

  if (message.type === 'tool_result') {
    if ((message as any).is_error === true) {
      observation.sawFailure = true;
    }
    return;
  }

  if (message.type === 'system') {
    const subtype = (message as any).subtype;
    if (subtype === 'task_notification') {
      recordTaskNotificationObservation(observation, message as SDKTaskNotificationMessage);
      return;
    }
    if (subtype === 'task_started' || subtype === 'task_progress') {
      observation.sawTask = true;
      observation.sawSubagent = true;
    }
    return;
  }

  if (message.type === 'result' && message.is_error === true) {
    observation.sawResultError = true;
  }
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asUnknownRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function getTaskStringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  if (!record) return undefined;
  return normalizeOptionalString(record[key]);
}

function getTaskNumberField(record: Record<string, unknown> | undefined, key: string): number | undefined {
  if (!record) return undefined;
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function getTaskContentText(content: unknown): string | undefined {
  if (!Array.isArray(content) || content.length === 0) return undefined;
  const first = asUnknownRecord(content[0]);
  return getTaskStringField(first, 'text');
}

function buildBackgroundTaskInspectionFromPayload(
  payload: string | Record<string, unknown>,
  fallbackTaskId: string,
): BackgroundTaskInspection | null {
  const payloadRecord = typeof payload === 'string'
    ? (() => {
      const raw = payload.trim();
      if (!raw || raw.startsWith('Error: No task found')) return undefined;
      try {
        return JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return {
          task_id: fallbackTaskId,
          type: 'unknown',
          status: 'unknown',
          summary: summarizePlainText(raw),
          output_preview: truncateText(raw, 1200),
        } as Record<string, unknown>;
      }
    })()
    : payload;

  const record = asUnknownRecord(payloadRecord);
  if (!record) return null;

  const metadata = asUnknownRecord(record.metadata);
  const usage = asUnknownRecord(record.usage);
  const typeValue = getTaskStringField(record, 'type');
  const output = getTaskStringField(record, 'output')
    ?? getTaskStringField(record, 'result')
    ?? getTaskContentText(record.content);
  const outputPreview = output ? truncateText(output, 1200) : undefined;
  const summary = getTaskStringField(metadata, 'summary')
    ?? getTaskStringField(record, 'summary')
    ?? summarizePlainText(output);
  const startedAt = getTaskNumberField(metadata, 'start_time')
    ?? getTaskNumberField(record, 'started_at');
  const durationMs = getTaskNumberField(record, 'durationMs')
    ?? getTaskNumberField(record, 'duration_ms')
    ?? getTaskNumberField(usage, 'duration_ms');

  return {
    task_id: getTaskStringField(record, 'task_id') ?? fallbackTaskId,
    type: typeValue === 'bash' || typeValue === 'agent' ? typeValue : 'unknown',
    status: getTaskStringField(record, 'status') ?? getTaskStringField(record, 'state') ?? 'unknown',
    ...(getTaskStringField(record, 'state') ? { state: getTaskStringField(record, 'state') } : {}),
    summary,
    ...(outputPreview ? { output_preview: outputPreview } : {}),
    ...(getTaskStringField(record, 'output_file') ? { output_file: getTaskStringField(record, 'output_file') } : {}),
    ...(getTaskStringField(metadata, 'session_id') ?? getTaskStringField(record, 'session_id')
      ? { session_id: getTaskStringField(metadata, 'session_id') ?? getTaskStringField(record, 'session_id') }
      : {}),
    ...(getTaskStringField(metadata, 'command') ?? getTaskStringField(record, 'command')
      ? { command: getTaskStringField(metadata, 'command') ?? getTaskStringField(record, 'command') }
      : {}),
    ...(typeof startedAt === 'number' ? { started_at: startedAt } : {}),
    ...(typeof durationMs === 'number' ? { duration_ms: durationMs } : {}),
  };
}

function truncateText(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function summarizePlainText(text?: string): string {
  const normalized = normalizeOptionalString(text);
  if (!normalized) return 'No summary available.';
  return truncateText(normalized.replace(/\s+/g, ' '), 200);
}

function buildPromptSessionMetadata(
  promptText?: string,
  explicitTitle?: string,
): {
  title?: string;
  summary?: string;
  createdFromPrompt?: string;
} {
  const normalizedPrompt = normalizeOptionalString(promptText);
  const normalizedTitle = normalizeOptionalString(explicitTitle);

  if (!normalizedPrompt && !normalizedTitle) {
    return {};
  }

  const fallbackTitle = normalizedPrompt
    ? truncateText(normalizedPrompt.split('\n')[0].replace(/\s+/g, ' '), 80)
    : undefined;
  const title = normalizedTitle ?? fallbackTitle;

  return {
    ...(title ? { title } : {}),
    ...(normalizedPrompt ? {
      summary: truncateText(normalizedPrompt.replace(/\s+/g, ' '), 200),
      createdFromPrompt: truncateText(normalizedPrompt, 4000),
    } : normalizedTitle ? { summary: normalizedTitle } : {}),
  };
}

function buildResultSessionMetadata(
  sessionInfo: Awaited<ReturnType<SessionManager['getSession']>>,
  resultMessage: SDKMessage,
): {
  summary?: string;
} {
  if (resultMessage.type !== 'result') {
    return {};
  }

  const prefix = sessionInfo?.title ? `${sessionInfo.title} — ` : '';
  if (resultMessage.is_error) {
    const errorText = Array.isArray((resultMessage as any).errors)
      ? (resultMessage as any).errors.join(' ')
      : 'Execution failed.';
    return {
      summary: truncateText(`${prefix}Failed: ${summarizePlainText(errorText)}`, 200),
    };
  }

  const resultText = typeof (resultMessage as any).result === 'string'
    ? (resultMessage as any).result
    : '';
  return {
    summary: truncateText(`${prefix}${summarizePlainText(resultText)}`, 200),
  };
}

function buildResumeMetadata(
  options: QueryOptions,
  effectiveResumeSessionId?: string,
): {
  resumeSource?: 'new' | 'continue' | 'resume' | 'resume_at' | 'fork';
  parentSessionId?: string;
  forkedFromSessionId?: string;
} {
  if (options.forkSession && effectiveResumeSessionId) {
    return {
      resumeSource: 'fork',
      parentSessionId: effectiveResumeSessionId,
      forkedFromSessionId: effectiveResumeSessionId,
    };
  }
  if (options.resumeSessionAt) {
    return { resumeSource: 'resume_at' };
  }
  if (options.resume) {
    return { resumeSource: 'resume' };
  }
  if (options.continue && effectiveResumeSessionId) {
    return { resumeSource: 'continue' };
  }
  return { resumeSource: 'new' };
}

function extractUserPromptText(message: SDKMessage): string | undefined {
  if (message.type !== 'user') return undefined;
  const content = (message as SDKUserMessage).message?.content;
  if (typeof content === 'string') {
    return normalizeOptionalString(content);
  }
  if (Array.isArray(content)) {
    const text = content
      .filter((block): block is { type: string; text?: string } =>
        block !== null && typeof block === 'object' && (block as any).type === 'text',
      )
      .map((block) => block.text ?? '')
      .join('\n')
      .trim();
    return normalizeOptionalString(text);
  }
  return undefined;
}

function convertSubagentEventToSdkMessages(
  parentToolUseId: string | null | undefined,
  sessionId: string,
  event: SubagentStreamEvent,
): SDKMessage[] {
  const taskId = event.taskId ?? event.agentId;
  if (!taskId) return [];

  if (event.type === 'launched') {
    return [{
      type: 'system',
      subtype: 'task_started',
      task_id: taskId,
      ...(parentToolUseId ? { tool_use_id: parentToolUseId } : {}),
      description: event.description ?? 'Subagent task started.',
      task_type: 'agent',
      uuid: randomUUID(),
      session_id: sessionId,
    }];
  }

  if (event.type === 'tool_result' && event.usage) {
    return [{
      type: 'system',
      subtype: 'task_progress',
      task_id: taskId,
      ...(parentToolUseId ? { tool_use_id: parentToolUseId } : {}),
      description: event.description ?? `Subagent used ${event.toolName ?? 'a tool'}.`,
      usage: event.usage,
      ...(event.lastToolName ?? event.toolName
        ? { last_tool_name: event.lastToolName ?? event.toolName }
        : {}),
      uuid: randomUUID(),
      session_id: sessionId,
    }];
  }

  if (event.type === 'completed' || event.type === 'failed' || event.type === 'shutdown') {
    const status = event.type === 'shutdown'
      ? 'stopped'
      : (event.status ?? (event.type === 'completed' ? 'completed' : 'failed'));
    const orchestrationTemplates = buildTaskOrchestrationTemplates({
      taskId,
      status,
      description: event.description,
      summary: event.summary,
      result: event.output ?? event.error,
    });
    return [{
      type: 'system',
      subtype: 'task_notification',
      task_id: taskId,
      ...(parentToolUseId ? { tool_use_id: parentToolUseId } : {}),
      ...(event.teamName ? { team_name: event.teamName } : {}),
      ...(event.description ? { description: event.description } : {}),
      status,
      ...(event.completedAt ? { completed_at: event.completedAt } : {}),
      output_file: event.outputFile ?? '',
      summary: event.summary ?? summarizePlainText(event.output ?? event.error),
      ...(event.output ? { result: event.output } : {}),
      orchestration_templates: orchestrationTemplates,
      ...(event.usage ? { usage: event.usage } : {}),
      uuid: randomUUID(),
      session_id: sessionId,
    }];
  }

  return [];
}

function convertSubagentEventToOrchestrationEvent(
  parentToolCallId: string | null | undefined,
  sessionId: string,
  event: SubagentStreamEvent,
): SDKOrchestrationEvent | null {
  const kind = classifySubagentEvent(event);
  if (!kind) return null;
  const lifecycle = kind === 'worker_lifecycle'
    && (event.type === 'launched' || event.type === 'completed' || event.type === 'failed' || event.type === 'shutdown')
    ? event.type
    : undefined;
  return {
    kind,
    sessionId,
    parentToolCallId: parentToolCallId ?? event.agentId ?? event.taskId ?? 'sdk-control-plane',
    ...(event.agentId || event.taskId ? { workerId: event.agentId ?? event.taskId } : {}),
    ...(event.teamName ? { teamName: event.teamName } : {}),
    ...(lifecycle ? { lifecycle } : {}),
    raw: cloneSubagentEvent(event),
  };
}

function classifySubagentEvent(event: SubagentStreamEvent): SDKOrchestrationEvent['kind'] | null {
  if (event.type === 'tool_start' || event.type === 'tool_result') {
    return 'worker_tool';
  }
  if (event.type === 'launched' || event.type === 'completed' || event.type === 'failed' || event.type === 'shutdown') {
    return 'worker_lifecycle';
  }
  return null;
}

function cloneSubagentEvent(event: SubagentStreamEvent): SubagentStreamEvent {
  return JSON.parse(JSON.stringify(event));
}

function cloneOrchestrationEvent(event: SDKOrchestrationEvent): SDKOrchestrationEvent {
  return JSON.parse(JSON.stringify(event));
}

function cloneTimelineItem(item: SDKTimelineItem): SDKTimelineItem {
  return JSON.parse(JSON.stringify(item));
}

function cloneTaskNotificationMessage(message: SDKTaskNotificationMessage): SDKTaskNotificationMessage {
  return JSON.parse(JSON.stringify(message));
}

function buildTimelineTaskNotificationRecord(
  message: SDKTaskNotificationMessage,
  language?: string,
) {
  return {
    taskId: message.task_id,
    status: message.status,
    ...(message.team_name ? { teamName: message.team_name } : {}),
    ...(message.description ? { description: message.description } : {}),
    ...(message.completed_at ? { completedAt: message.completed_at } : {}),
    ...(message.output_file ? { outputFile: message.output_file } : {}),
    summary: message.summary ?? summarizePlainText(message.result),
    ...(message.result ? { result: message.result } : {}),
    ...(message.usage ? { usage: JSON.parse(JSON.stringify(message.usage)) } : {}),
    ...(message.orchestration_templates
      ? { orchestrationTemplates: JSON.parse(JSON.stringify(message.orchestration_templates)) }
      : {}),
    followUps: buildTimelineTaskNotificationFollowUps(message, language),
  };
}

function buildTimelineTaskNotificationFollowUps(
  message: SDKTaskNotificationMessage,
  language?: string,
): WorkerFollowUpSuggestion[] {
  const observation = createPromptSuggestionObservation();
  observation.sawTask = true;
  observation.sawSubagent = true;
  observation.lastTaskId = message.task_id;
  observation.lastTaskStatus = message.status;
  observation.lastTaskTeamName = normalizeOptionalString(message.team_name) ?? observation.lastTaskTeamName;
  observation.lastTaskDescription = normalizeOptionalString(message.description) ?? observation.lastTaskDescription;
  observation.lastTaskTemplates = message.orchestration_templates;

  const resultMessage: SDKResultMessage = {
    type: 'result',
    subtype: message.status === 'failed' ? 'error_max_turns' : 'success',
    duration_ms: message.usage?.duration_ms ?? 0,
    duration_api_ms: 0,
    is_error: message.status === 'failed',
    num_turns: 0,
    result: message.result ?? message.summary ?? '',
    stop_reason: 'end_turn',
    total_cost_usd: 0,
    usage: {
      input_tokens: 0,
      output_tokens: message.usage?.total_tokens ?? 0,
    },
    modelUsage: {},
    permission_denials: [],
    uuid: message.uuid ?? randomUUID(),
    session_id: message.session_id,
  };

  return __internal_buildPromptSuggestions({
    result: resultMessage,
    observation,
    language,
  })
    .filter((item): item is WorkerFollowUpSuggestion => Boolean(item.scaffold))
    .map((item) => ({
      suggestion: item.suggestion,
      scaffold: item.scaffold!,
    }));
}

function resolveFollowUpScaffold(
  followUp: FollowUpExecutable,
): NonNullable<SDKPromptSuggestionMessage['scaffold']> {
  if ('scaffold' in followUp) {
    return followUp.scaffold;
  }
  return followUp;
}

function normalizeIntegerField(value: unknown): number | undefined {
  return Number.isInteger(value) ? value as number : undefined;
}

function normalizeTimelineMessageType(
  value: unknown,
): TeamMessageRecord['type'] | undefined {
  if (
    value === 'message'
    || value === 'broadcast'
    || value === 'shutdown_request'
    || value === 'shutdown_response'
    || value === 'plan_approval_response'
    || value === 'idle_notification'
    || value === 'plan_approval_request'
  ) {
    return value;
  }
  return undefined;
}

function extractTimelineTimestamp(event: SDKOrchestrationEvent): string {
  const raw = event.raw as Record<string, unknown>;
  const completedAt = typeof raw.completedAt === 'string' ? raw.completedAt : undefined;
  const timestamp = typeof raw.timestamp === 'string' ? raw.timestamp : undefined;
  return completedAt ?? timestamp ?? new Date().toISOString();
}

function compareTimelineTimestamps(left?: string, right?: string): number {
  const leftMs = left ? new Date(left).getTime() : 0;
  const rightMs = right ? new Date(right).getTime() : 0;
  return leftMs - rightMs;
}

function buildTimelineTeamMessageFingerprint(message: TeamMessageRecord): string {
  return JSON.stringify([
    message.teamName,
    message.type,
    message.from,
    message.to ?? '',
    message.timestamp,
    message.requestId ?? '',
    message.summary ?? '',
    message.content,
  ]);
}

function extractTimelineDispatcherEventsFromTranscriptEntries(
  entries: unknown[],
  orchestrationTypes?: SDKOrchestrationEventKind[],
): SDKOrchestrationEvent[] {
  const allowDispatcher = !orchestrationTypes || orchestrationTypes.includes('task_dispatcher');
  if (!allowDispatcher) {
    return [];
  }

  const events: SDKOrchestrationEvent[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    if (record.type !== 'system' || record.subtype !== 'task_dispatcher_event') continue;

    const dispatcherId = normalizeOptionalString(record.dispatcher_id);
    const sessionId = normalizeOptionalString(record.session_id);
    const teamName = normalizeOptionalString(record.team_name);
    const timestamp = normalizeOptionalString(record.timestamp);
    const rawEvent = record.event;
    if (!dispatcherId || !sessionId || !teamName || !timestamp || !rawEvent || typeof rawEvent !== 'object') {
      continue;
    }

    const dispatcherEvent = JSON.parse(JSON.stringify(rawEvent)) as SDKTaskDispatcherEvent;
    const fallbackActiveAssignments = Array.isArray(dispatcherEvent.activeAssignments)
      ? dispatcherEvent.activeAssignments
      : (Array.isArray(dispatcherEvent.activeTaskIds) ? dispatcherEvent.activeTaskIds : []).map((taskId, index) => ({
          taskId,
          workerId: Array.isArray(dispatcherEvent.activeWorkerIds)
            ? (dispatcherEvent.activeWorkerIds[index] ?? `unknown-worker-${index}`)
            : `unknown-worker-${index}`,
        }));
    const normalizedDispatcherEvent = {
      ...dispatcherEvent,
      source: dispatcherEvent.source === 'transcript' ? 'transcript' : 'live',
      activeAssignments: fallbackActiveAssignments,
      startedAt: dispatcherEvent.startedAt ?? dispatcherEvent.timestamp,
      updatedAt: dispatcherEvent.updatedAt ?? dispatcherEvent.timestamp,
      followUps: Array.isArray(dispatcherEvent.followUps)
        ? dispatcherEvent.followUps
        : buildTaskDispatcherFollowUps({
            ...(dispatcherEvent as Omit<SDKTaskDispatcherEvent, 'followUps'>),
            source: dispatcherEvent.source === 'transcript' ? 'transcript' : 'live',
            activeAssignments: fallbackActiveAssignments,
            startedAt: dispatcherEvent.startedAt ?? dispatcherEvent.timestamp,
            updatedAt: dispatcherEvent.updatedAt ?? dispatcherEvent.timestamp,
          }),
    };
    events.push({
      kind: 'task_dispatcher',
      sessionId,
      parentToolCallId: `sdk-dispatcher:${dispatcherId}`,
      dispatcherId,
      teamName,
      ...(normalizeOptionalString((normalizedDispatcherEvent as Record<string, unknown>).workerId)
        ? { workerId: normalizeOptionalString((normalizedDispatcherEvent as Record<string, unknown>).workerId) }
        : {}),
      ...(normalizeOptionalString((normalizedDispatcherEvent as Record<string, unknown>).taskId)
        ? { taskId: normalizeOptionalString((normalizedDispatcherEvent as Record<string, unknown>).taskId) }
        : {}),
      dispatcherEvent: normalizedDispatcherEvent,
      raw: normalizedDispatcherEvent,
    });
  }

  return events;
}

function extractTimelineTaskNotificationsFromTranscriptEntries(
  entries: unknown[],
): SDKTaskNotificationMessage[] {
  const notifications: SDKTaskNotificationMessage[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    if (record.type !== 'system' || record.subtype !== 'task_notification') continue;
    notifications.push(cloneTaskNotificationMessage(record as SDKTaskNotificationMessage));
  }
  return notifications;
}

function buildTimelineTaskNotificationFromOrchestrationEvent(
  event: SDKOrchestrationEvent,
  language?: string,
): SDKTimelineItem | null {
  if (event.kind !== 'worker_lifecycle') {
    return null;
  }
  const taskNotification = convertSubagentEventToSdkMessages(
    event.parentToolCallId,
    event.sessionId,
    event.raw as SubagentStreamEvent,
  ).find((message): message is SDKTaskNotificationMessage =>
    message.type === 'system' && message.subtype === 'task_notification',
  );
  return taskNotification ? {
    kind: 'task_notification',
    ...(buildTaskNotificationFingerprint(taskNotification)
      ? {
          timelineId: buildTaskNotificationFingerprint(taskNotification)!,
          cursor: buildTaskNotificationFingerprint(taskNotification)!,
        }
      : {}),
    sessionId: taskNotification.session_id,
    timestamp: taskNotification.completed_at ?? extractTimelineTimestamp(event),
    ...(taskNotification.team_name ? { teamName: taskNotification.team_name } : {}),
    workerId: taskNotification.task_id,
    ...(taskNotification.tool_use_id ? { parentToolCallId: taskNotification.tool_use_id } : {}),
    taskNotification: buildTimelineTaskNotificationRecord(taskNotification, language),
  } : null;
}

function sortTimelineItems(items: SDKTimelineItem[]): SDKTimelineItem[] {
  return [...items].sort((left, right) => compareTimelineTimestamps(left.timestamp, right.timestamp));
}

function dedupeTimelineItems(items: SDKTimelineItem[]): SDKTimelineItem[] {
  const deduped = new Map<string, SDKTimelineItem>();
  for (const item of items) {
    const key = item.cursor
      ?? item.timelineId
      ?? `${item.kind}:${item.timestamp}:${item.sessionId}:${item.teamName ?? ''}:${item.workerId ?? ''}`;
    deduped.set(key, item);
  }
  return [...deduped.values()];
}

function buildTaskNotificationFingerprint(input: {
  task_id?: unknown;
  status?: unknown;
  completed_at?: unknown;
}): string | null {
  if (typeof input.task_id !== 'string' || typeof input.status !== 'string') {
    return null;
  }
  const completedAt = typeof input.completed_at === 'string' ? input.completed_at : '';
  return `${input.task_id}::${input.status}::${completedAt}`;
}

function mapAgentStateToTaskStatus(
  state: AgentSession['state'],
): SDKTaskNotificationMessage['status'] | null {
  if (state === 'completed') return 'completed';
  if (state === 'failed') return 'failed';
  if (state === 'shutdown') return 'stopped';
  return null;
}

type PendingTaskNotificationSession = Pick<
  AgentSession,
  | 'agentId'
  | 'agentType'
  | 'name'
  | 'teamName'
  | 'state'
  | 'parentSessionId'
  | 'completedAt'
  | 'result'
  | 'error'
  | 'outputFile'
  | 'totalTokens'
  | 'totalToolUseCount'
  | 'durationMs'
>;

interface PersistedTaskDispatcherEventMessage {
  type: 'system';
  subtype: 'task_dispatcher_event';
  session_id: string;
  dispatcher_id: string;
  team_name: string;
  timestamp: string;
  event: SDKTaskDispatcherEvent;
}

interface PersistedOrchestrationTimelineLedgerFile {
  version: 1;
  items: SDKTimelineItem[];
}

interface PersistedOrchestrationLedgerFile {
  version: 1;
  tasks: TaskRecord[];
  workers: WorkerRecord[];
  dispatchers: TaskDispatcherRecord[];
  timelineItems: SDKTimelineItem[];
  dispatcherDiagnoses: TaskDispatcherHealthReport[];
  scheduler: SchedulerControlPlaneSnapshot;
}

interface PersistedTaskDispatcherLedgerFile {
  version: 1;
  dispatchers: TaskDispatcherRecord[];
}

interface PersistedTaskLedgerFile {
  version: 1;
  tasks: TaskRecord[];
}

interface PersistedWorkerLedgerFile {
  version: 1;
  workers: WorkerRecord[];
}

interface PersistedTaskDispatcherDiagnosisFile {
  version: 1;
  diagnoses: TaskDispatcherHealthReport[];
}

export function __internal_collectPendingTaskNotifications(params: {
  sessionId: string;
  transcriptEntries: unknown[];
  childSessions: PendingTaskNotificationSession[];
}): SDKTaskNotificationMessage[] {
  const seen = new Set<string>();

  for (const entry of params.transcriptEntries) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    if (record.type !== 'system' || record.subtype !== 'task_notification') continue;
    const fingerprint = buildTaskNotificationFingerprint(record);
    if (fingerprint) {
      seen.add(fingerprint);
    }
  }

  return params.childSessions
    .filter((session) => session.parentSessionId === params.sessionId)
    .filter((session) => mapAgentStateToTaskStatus(session.state) !== null)
    .filter((session) => typeof session.completedAt === 'string' && session.completedAt.length > 0)
    .sort((left, right) => new Date(left.completedAt ?? 0).getTime() - new Date(right.completedAt ?? 0).getTime())
    .filter((session) => {
      const fingerprint = buildTaskNotificationFingerprint({
        task_id: session.agentId,
        status: mapAgentStateToTaskStatus(session.state),
        completed_at: session.completedAt,
      });
      return fingerprint ? !seen.has(fingerprint) : false;
    })
    .map((session) => {
      const status = mapAgentStateToTaskStatus(session.state)!;
      return {
        type: 'system' as const,
        subtype: 'task_notification' as const,
        task_id: session.agentId,
        status,
        ...(session.teamName ? { team_name: session.teamName } : {}),
        completed_at: session.completedAt,
        output_file: session.outputFile ?? '',
        summary: summarizePlainText(session.result ?? session.error),
        ...(session.result ?? session.error ? { result: session.result ?? session.error } : {}),
        ...(session.name ?? session.agentType ? { description: session.name ?? session.agentType } : {}),
        orchestration_templates: buildTaskOrchestrationTemplates({
          taskId: session.agentId,
          status,
          description: session.name ?? session.agentType,
          summary: summarizePlainText(session.result ?? session.error),
          result: session.result ?? session.error,
        }),
        ...(session.totalTokens !== undefined || session.totalToolUseCount !== undefined || session.durationMs !== undefined
          ? {
              usage: {
                total_tokens: session.totalTokens ?? 0,
                tool_uses: session.totalToolUseCount ?? 0,
                duration_ms: session.durationMs ?? 0,
              },
            }
          : {}),
        uuid: randomUUID(),
        session_id: params.sessionId,
      };
    });
}

function assertUnsupportedOptions(options: QueryOptions): void {
  const unsupportedKeys: Array<keyof QueryOptions> = [
    'betas',
    'onElicitation',
    'debugFile',
    'spawnClaudeCodeProcess',
  ];
  for (const key of unsupportedKeys) {
    if ((options as Record<string, unknown>)[key] !== undefined) {
      throw new Error(`Option "${String(key)}" is not supported yet in open-agent/sdk.`);
    }
  }
}

function parseSandboxConfig(config: unknown): SandboxConfig | undefined {
  if (!config || typeof config !== 'object') return undefined;
  const candidate = config as Record<string, unknown>;
  if (typeof candidate.enabled !== 'boolean') return undefined;
  return config as SandboxConfig;
}

function isValidUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function __internal_isToolAllowedByPolicies(
  toolName: string,
  policy: {
    agentAllowedTools?: string[];
    agentDisallowedTools?: string[];
    toolsBaseline?: string[];
    allowedTools?: string[];
    disallowedTools?: string[];
  },
): boolean {
  const denyLists = [policy.agentDisallowedTools, policy.disallowedTools]
    .filter((list): list is string[] => Array.isArray(list))
    .flat();
  if (denyLists.includes(toolName)) return false;

  const allowLists = [
    policy.agentAllowedTools,
    policy.toolsBaseline,
    policy.allowedTools,
  ].filter((list): list is string[] => Array.isArray(list) && list.length > 0);

  for (const allowList of allowLists) {
    if (!allowList.includes(toolName)) {
      return false;
    }
  }
  return true;
}

export function __internal_buildPromptSuggestions(params: {
  result: SDKMessage;
  observation: PromptSuggestionObservation;
  language?: string;
}): SDKPromptSuggestionMessage[] {
  if (params.result.type !== 'result') return [];

  const isChinese = /中文|chinese|zh/i.test(params.language ?? '');
  const build = (zh: string, en: string) => (isChinese ? zh : en);
  const normalizeTeammateName = (value?: string): string | undefined => {
    const normalized = normalizeOptionalString(value);
    if (!normalized) return undefined;
    const generic = new Set([
      'worker',
      'verifier',
      'general-purpose',
      'code-writer',
      'architecture-logic-reviewer',
      'explore',
      'plan',
      'bash',
    ]);
    return generic.has(normalized.toLowerCase()) ? undefined : normalized;
  };
  const buildTaskAction = (input: {
    description: string;
    prompt: string;
    subagentType: 'worker' | 'verifier';
    resume?: string;
  }): NonNullable<NonNullable<SDKPromptSuggestionMessage['scaffold']>['action']> => ({
    tool: 'Task',
    arguments: {
      description: input.description,
      prompt: input.prompt,
      subagent_type: input.subagentType,
      ...(input.resume ? { resume: input.resume } : {}),
    },
  });
  const buildSendMessageAction = (input: {
    recipient: string;
    content: string;
    summary: string;
  }): NonNullable<NonNullable<SDKPromptSuggestionMessage['scaffold']>['action']> => ({
    tool: 'SendMessage',
    arguments: {
      type: 'message',
      recipient: input.recipient,
      summary: input.summary,
      content: input.content,
    },
  });
  const out: SDKPromptSuggestionMessage[] = [];
  const seen = new Set<string>();
  const pushSuggestion = (
    suggestion: string,
    scaffold?: SDKPromptSuggestionMessage['scaffold'],
  ): void => {
    if (seen.has(suggestion)) return;
    seen.add(suggestion);
    out.push({
      type: 'prompt_suggestion',
      suggestion,
      ...(scaffold ? { scaffold } : {}),
      uuid: '',
      session_id: '',
    });
  };

  if (params.result.is_error) {
    pushSuggestion(build('继续定位这次失败的根因并给出修复方案', 'Continue debugging this failure and propose a fix'));
    pushSuggestion(build('把关键错误链路和日志整理成摘要', 'Summarize the key error path and logs'));
    pushSuggestion(build('换一个更小范围的修复路径再试一次', 'Try a smaller-scope fix path and rerun'));
    return out.slice(0, 3);
  }

  const { observation } = params;
  const changedCode = observation.sawEdit || observation.sawWrite;
  const workerRef = observation.lastTaskId
    ? `worker \`${observation.lastTaskId}\``
    : build('同一个 worker', 'the same worker');
  const recentWorkerRef = observation.lastTaskId
    ? `worker \`${observation.lastTaskId}\``
    : build('刚才的 worker', 'the worker that just finished');
  const teammateRecipient = observation.lastTaskTeamName
    ? normalizeTeammateName(observation.lastTaskDescription)
    : undefined;
  const templates = observation.lastTaskTemplates;

  if (observation.lastTaskStatus === 'completed') {
    pushSuggestion(
      build(
        `继续复用 ${workerRef} 做定向收尾或小范围扩展`,
        `Resume ${workerRef} for targeted follow-up or a small scoped extension`,
      ),
      templates?.resume_prompt_template
        ? {
            kind: 'resume_worker',
            title: build('复用原 worker 模板', 'Resume worker template'),
            agent_type: 'worker',
            prompt: templates.resume_prompt_template,
            source_task_id: observation.lastTaskId,
            resume_task_id: observation.lastTaskId,
            task_status: observation.lastTaskStatus,
            action: teammateRecipient
              ? buildSendMessageAction({
                  recipient: teammateRecipient,
                  summary: build(`继续 ${teammateRecipient}`, `Continue ${teammateRecipient}`),
                  content: templates.resume_prompt_template,
                })
              : buildTaskAction({
                  description: build('继续原 worker', 'Resume existing worker'),
                  prompt: templates.resume_prompt_template,
                  subagentType: 'worker',
                  resume: observation.lastTaskId,
                }),
          }
        : undefined,
    );
    pushSuggestion(
      build(
        `新开一个 \`verifier\`，独立验证 ${recentWorkerRef} 的结果`,
        `Launch a fresh \`verifier\` to independently validate the result from ${recentWorkerRef}`,
      ),
      templates?.verification_prompt_template
        ? {
            kind: 'launch_verifier',
            title: build('Verifier 验证模板', 'Verifier validation template'),
            agent_type: 'verifier',
            prompt: templates.verification_prompt_template,
            source_task_id: observation.lastTaskId,
            task_status: observation.lastTaskStatus,
            action: buildTaskAction({
              description: build('独立验证结果', 'Verify worker result'),
              prompt: templates.verification_prompt_template,
              subagentType: 'verifier',
            }),
          }
        : undefined,
    );
    pushSuggestion(build(
      `把 ${recentWorkerRef} 的产出整合成主线补丁、测试和风险清单`,
      `Turn the output from ${recentWorkerRef} into a concrete patch, test, and risk checklist`,
    ));
  } else if (observation.lastTaskStatus === 'failed') {
    pushSuggestion(
      build(
        `继续复用 ${workerRef}，沿用上下文定位失败根因并重试`,
        `Resume ${workerRef} and keep debugging the failure with its current context`,
      ),
      templates?.retry_prompt_template
        ? {
            kind: 'retry_worker',
            title: build('失败重试模板', 'Failure retry template'),
            agent_type: 'worker',
            prompt: templates.retry_prompt_template,
            source_task_id: observation.lastTaskId,
            resume_task_id: observation.lastTaskId,
            task_status: observation.lastTaskStatus,
            action: teammateRecipient
              ? buildSendMessageAction({
                  recipient: teammateRecipient,
                  summary: build(`重试 ${teammateRecipient}`, `Retry ${teammateRecipient}`),
                  content: templates.retry_prompt_template,
                })
              : buildTaskAction({
                  description: build('沿原上下文重试', 'Retry with existing worker context'),
                  prompt: templates.retry_prompt_template,
                  subagentType: 'worker',
                  resume: observation.lastTaskId,
                }),
          }
        : undefined,
    );
    pushSuggestion(build(
      `把这次失败拆成更小的修复步骤后，继续交给 ${workerRef}`,
      `Break the failure into a smaller fix plan and hand it back to ${workerRef}`,
    ));
    pushSuggestion(build(
      `总结 ${recentWorkerRef} 失败的关键阻塞，并明确下一次重试条件`,
      `Summarize the key blockers from ${recentWorkerRef} and define the next retry conditions`,
    ));
  } else if (observation.lastTaskStatus === 'stopped') {
    pushSuggestion(
      build(
        `继续复用 ${workerRef} 从中断点推进剩余工作`,
        `Resume ${workerRef} from the interruption point and finish the remaining work`,
      ),
      templates?.resume_prompt_template
        ? {
            kind: 'stopped_worker_followup',
            title: build('中断恢复模板', 'Stopped worker resume template'),
            agent_type: 'worker',
            prompt: templates.resume_prompt_template,
            source_task_id: observation.lastTaskId,
            resume_task_id: observation.lastTaskId,
            task_status: observation.lastTaskStatus,
            action: teammateRecipient
              ? buildSendMessageAction({
                  recipient: teammateRecipient,
                  summary: build(`恢复 ${teammateRecipient}`, `Resume ${teammateRecipient}`),
                  content: templates.resume_prompt_template,
                })
              : buildTaskAction({
                  description: build('恢复中断 worker', 'Resume interrupted worker'),
                  prompt: templates.resume_prompt_template,
                  subagentType: 'worker',
                  resume: observation.lastTaskId,
                }),
          }
        : undefined,
    );
    pushSuggestion(build(
      `先整理 ${recentWorkerRef} 中断前已完成的内容，再决定是否新开 \`verifier\``,
      `Summarize what ${recentWorkerRef} finished before the interruption, then decide whether to launch a fresh \`verifier\``,
    ));
    pushSuggestion(build(
      '把剩余未完成事项整理成明确的执行清单',
      'Turn the unfinished work into a concrete execution checklist',
    ));
  }

  if (changedCode) {
    pushSuggestion(build('继续运行针对性测试并修复失败项', 'Run targeted tests next and fix any failures'));
    pushSuggestion(build('帮我检查这次改动的 git diff 并总结风险点', 'Review this git diff and summarize any risks'));
    pushSuggestion(build('把这次改动整理成 commit message 或 PR 摘要', 'Turn these changes into a commit message or PR summary'));
  }

  if (observation.sawResearch && !changedCode) {
    pushSuggestion(build('基于这些发现继续落地实现', 'Implement the next step based on these findings'));
    pushSuggestion(build('把关键结论整理成执行计划', 'Turn the findings into an execution plan'));
    pushSuggestion(build('对比两个可行方案并推荐一个', 'Compare the viable approaches and recommend one'));
  }

  if ((observation.sawTask || observation.sawSubagent) && observation.lastTaskStatus === undefined) {
    pushSuggestion(build('继续把子任务结果整合成下一步执行方案', 'Integrate the subtask outputs into the next execution plan'));
  }

  if (observation.sawBash && !observation.sawTesting) {
    pushSuggestion(build('把刚才的命令结果整理成结论和后续动作', 'Turn the command output into conclusions and next steps'));
  }

  if (observation.sawGit) {
    pushSuggestion(build('继续检查变更范围并准备提交', 'Inspect the change scope and prepare a commit'));
  }

  if (out.length === 0) {
    pushSuggestion(build('继续把结果展开成可执行的下一步', 'Expand this result into the next actionable step'));
    pushSuggestion(build('把当前结论整理成简短摘要', 'Condense the current outcome into a short summary'));
    pushSuggestion(build('继续推进下一个最有收益的改动', 'Proceed to the next highest-leverage improvement'));
  }

  return out.slice(0, 3);
}

function readFileMaybe(filePath: string): string | null {
  try {
    return existsSync(filePath) ? readFileSync(filePath, 'utf-8') : null;
  } catch {
    return null;
  }
}

function toLines(content: string | null): string[] {
  if (content === null || content.length === 0) return [];
  return content.split(/\r?\n/);
}

function diffLineStats(
  fromContent: string | null,
  toContent: string | null,
): { insertions: number; deletions: number } {
  if (fromContent === toContent) {
    return { insertions: 0, deletions: 0 };
  }
  if (fromContent === null) {
    return { insertions: toLines(toContent).length, deletions: 0 };
  }
  if (toContent === null) {
    return { insertions: 0, deletions: toLines(fromContent).length };
  }
  const a = toLines(fromContent);
  const b = toLines(toContent);
  if (a.length === 0 && b.length === 0) return { insertions: 0, deletions: 0 };
  if (a.length === 0) return { insertions: b.length, deletions: 0 };
  if (b.length === 0) return { insertions: 0, deletions: a.length };

  const prev = new Uint32Array(b.length + 1);
  const curr = new Uint32Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = 0;
    for (let j = 1; j <= b.length; j++) {
      curr[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1] + 1
        : Math.max(prev[j], curr[j - 1]);
    }
    prev.set(curr);
  }

  const lcs = prev[b.length];
  return {
    insertions: b.length - lcs,
    deletions: a.length - lcs,
  };
}

function accumulateRewindStats(
  targets: Array<{ filePath: string; originalContent: string | null }>,
  beforeSnapshots: Map<string, string | null>,
  includeFiles: Set<string>,
): { insertions: number; deletions: number } {
  let insertions = 0;
  let deletions = 0;
  for (const target of targets) {
    if (!includeFiles.has(target.filePath)) continue;
    const before = beforeSnapshots.get(target.filePath) ?? null;
    const stats = diffLineStats(before, target.originalContent);
    insertions += stats.insertions;
    deletions += stats.deletions;
  }
  return { insertions, deletions };
}

/**
 * Infer the provider backend from well-known model name prefixes.
 * Returns `null` when the model is unknown (caller falls back to auto-detect).
 */
function guessProviderFromModel(
  model?: string,
): 'anthropic' | 'openai' | 'ollama' | null {
  if (!model) return null;
  if (model.startsWith('claude')) return 'anthropic';
  if (
    model.startsWith('gpt') ||
    model.startsWith('o1') ||
    model.startsWith('o3') ||
    model.startsWith('o4')
  ) {
    return 'openai';
  }
  return null;
}

/**
 * Returns the standard slash commands supported by the open-agent REPL.
 * Defined inline to keep the SDK self-contained (no dependency on @open-agent/cli).
 */
function getDefaultSlashCommands(extraCommands: SlashCommand[] = []): SlashCommand[] {
  const defaults: SlashCommand[] = [
    { name: '/help', description: 'Show available commands', argumentHint: '' },
    { name: '/model', description: 'Show or change the current model', argumentHint: '[model_name]' },
    { name: '/compact', description: 'Compact conversation history', argumentHint: '' },
    { name: '/status', description: 'Show session status', argumentHint: '' },
    { name: '/cost', description: 'Show session cost', argumentHint: '' },
    { name: '/tools', description: 'List registered tools', argumentHint: '' },
    { name: '/memory', description: 'Show auto-memory status', argumentHint: '' },
    { name: '/permissions', description: 'Show permission mode and rules', argumentHint: '' },
    { name: '/thinking', description: 'Show or change thinking mode', argumentHint: '[adaptive|enabled|disabled]' },
    { name: '/effort', description: 'Show or change effort level', argumentHint: '[low|medium|high|max]' },
    { name: '/config', description: 'Show current configuration', argumentHint: '' },
    { name: '/agents', description: 'List available agent types', argumentHint: '' },
    { name: '/skills', description: 'List available skills', argumentHint: '' },
    { name: '/mcp', description: 'Show MCP server status', argumentHint: '' },
    { name: '/sessions', description: 'List recent sessions', argumentHint: '' },
    { name: '/commit', description: 'Create a git commit with AI message', argumentHint: '' },
    { name: '/review', description: 'Review current git diff', argumentHint: '' },
    { name: '/init', description: 'Create AGENT.md for this project', argumentHint: '' },
    { name: '/doctor', description: 'Diagnose environment issues', argumentHint: '' },
    { name: '/rewind', description: 'List or restore file checkpoints', argumentHint: '[number]' },
    { name: '/clear', description: 'Clear the terminal', argumentHint: '' },
    { name: '/exit', description: 'Exit the REPL', argumentHint: '' },
    { name: '/quit', description: 'Exit the REPL', argumentHint: '' },
  ];
  if (extraCommands.length === 0) {
    return defaults;
  }
  const seen = new Set(defaults.map((command) => command.name));
  return [
    ...defaults,
    ...extraCommands.filter((command) => {
      if (seen.has(command.name)) return false;
      seen.add(command.name);
      return true;
    }),
  ];
}
