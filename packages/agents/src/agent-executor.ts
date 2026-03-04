import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, writeFileSync, readFileSync, appendFileSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';
import type { AgentDefinition } from '@open-agent/core';
import { execSync } from '@open-agent/core';
import type { LLMProvider } from '@open-agent/providers';
import type { ToolDefinition } from '@open-agent/tools';
import type { SubagentStreamEvent } from './agent-runner.js';
import { TeamManager } from './team-manager.js';

export type AgentState = 'spawning' | 'running' | 'idle' | 'completed' | 'failed' | 'shutdown';

export interface AgentSession {
  agentId: string;
  agentType: string;
  name?: string;
  state: AgentState;
  startedAt: string;
  completedAt?: string;
  model: string;
  mode?: string;
  teamName?: string;
  outputFile?: string;
  worktreePath?: string;
  worktreeBranch?: string;
  numTurns: number;
  durationMs: number;
  totalToolUseCount?: number;
  totalTokens?: number;
  usage?: import('./agent-runner.js').AgentUsage;
  result?: string;
  error?: string;
}

export interface ExecuteOptions {
  definition: AgentDefinition;
  provider: LLMProvider;
  tools: Map<string, ToolDefinition>;
  prompt: string;
  cwd: string;
  name?: string;
  model?: string;
  maxTurns?: number;
  mode?: string;
  teamName?: string;
  isolation?: string;
  runInBackground?: boolean;
  resume?: string;
  /** Pre-created worktree path — when set, agent runs inside this worktree */
  worktreePath?: string;
  /** Callback to clean up the worktree after background agent completes */
  onWorktreeCleanup?: (worktreePath: string, hasChanges: boolean) => Promise<void>;
  /** Callback to stream tool events to the parent for real-time visibility. */
  onEvent?: (event: SubagentStreamEvent) => void;
}

/**
 * Minimal interface for hook execution — matches LoopHookExecutor from @open-agent/core
 * and is satisfied by HookExecutor from @open-agent/hooks.
 */
export interface AgentHookExecutor {
  execute(
    event: string,
    input: Record<string, unknown>,
    toolUseId?: string,
  ): Promise<{
    continue?: boolean;
    suppressOutput?: boolean;
    updatedInput?: Record<string, unknown>;
    additionalContext?: string;
    decision?: string;
  }>;
}

export class AgentExecutor {
  static readonly MAX_CONCURRENT_BACKGROUND = 10;
  private agents = new Map<string, AgentSession>();
  /** Abort controllers per agent — used to signal background agents to stop */
  private agentAbortControllers = new Map<string, AbortController>();
  /** Lifecycle event callbacks for background agents (used by stopAgent). */
  private backgroundEventCallbacks = new Map<string, (event: SubagentStreamEvent) => void>();
  private baseDir: string;
  private outputDir: string;
  private hookExecutor?: AgentHookExecutor;

  constructor(hookExecutor?: AgentHookExecutor) {
    this.baseDir = join(homedir(), '.open-agent', 'agent-sessions');
    this.outputDir = join(tmpdir(), 'open-agent', 'agents');
    if (!existsSync(this.baseDir)) mkdirSync(this.baseDir, { recursive: true });
    if (!existsSync(this.outputDir)) mkdirSync(this.outputDir, { recursive: true });
    this.hookExecutor = hookExecutor;
  }

  /**
   * Execute an agent in the foreground. Blocks until completion.
   * Returns the agent's text result.
   */
  async execute(options: ExecuteOptions): Promise<{ agentId: string; result: string; session: AgentSession }> {
    const agentId = options.resume || `agent-${randomUUID()}`;
    const agentType = options.definition.name ?? options.definition.description ?? 'unknown';
    const session: AgentSession = {
      agentId,
      agentType,
      name: options.name,
      state: 'spawning',
      startedAt: new Date().toISOString(),
      model: options.model ?? 'default',
      mode: options.mode,
      teamName: options.teamName,
      numTurns: 0,
      durationMs: 0,
    };

    this.agents.set(agentId, session);
    this.saveSession(session);

    session.state = 'running';
    const startTime = Date.now();

    // Fire SubagentStart hook
    await this.fireSubagentStart(agentId, agentType, options.cwd);

    // Emit launched event
    try { options.onEvent?.({ type: 'launched', agentId, description: options.name }); } catch { /* non-fatal */ }

    try {
      // Import AgentRunner dynamically to avoid circular deps
      const { AgentRunner } = await import('./agent-runner.js');

      // Load previous messages if resuming
      let initialMessages: import('@open-agent/providers').Message[] | undefined;
      if (options.resume) {
        initialMessages = this.loadTranscript(options.resume);
      }

      // Prepare transcript file for persisting messages
      const transcriptDir = this.getSessionDir(agentId);
      const transcriptPath = join(transcriptDir, 'transcript.jsonl');

      const runner = new AgentRunner({
        definition: options.definition,
        provider: options.provider,
        tools: options.tools,
        cwd: options.cwd,
        maxTurns: options.maxTurns,
        mode: options.mode,
        model: options.model,
        initialMessages,
        worktreePath: options.worktreePath,
        teamName: options.teamName,
        agentName: options.name,
        onMessage: (msg) => {
          try { appendFileSync(transcriptPath, JSON.stringify(msg) + '\n'); } catch { /* non-fatal */ }
        },
        onEvent: options.onEvent,
      });

      const agentResult = await runner.run(options.prompt);

      session.state = agentResult.isError ? 'failed' : 'completed';
      session.completedAt = new Date().toISOString();
      session.durationMs = Date.now() - startTime;
      session.numTurns = agentResult.numTurns;
      session.totalToolUseCount = agentResult.totalToolUseCount;
      session.totalTokens = agentResult.totalTokens;
      session.usage = agentResult.usage;
      session.result = agentResult.result;
      if (options.worktreePath) {
        session.worktreePath = options.worktreePath;
      }
      this.saveSession(session);

      // Fire SubagentStop hook
      await this.fireSubagentStop(agentId, agentType, agentResult.result, options.cwd);

      if (agentResult.isError) {
        // Emit failed event
        try { options.onEvent?.({ type: 'failed', agentId, error: agentResult.result, durationMs: session.durationMs }); } catch { /* non-fatal */ }
        const err = new Error(agentResult.result || 'Agent execution failed');
        (err as any).__lifecycleEmitted = true;
        throw err;
      }

      // Emit completed event
      try { options.onEvent?.({ type: 'completed', agentId, durationMs: session.durationMs, totalToolUseCount: agentResult.totalToolUseCount }); } catch { /* non-fatal */ }

      // Notify team lead that this agent is now idle (if running in a team).
      if (options.teamName && options.name) {
        try {
          const tm = new TeamManager();
          tm.notifyIdle(options.teamName, options.name);
        } catch { /* non-fatal */ }
      }

      return { agentId, result: agentResult.result, session };
    } catch (error: unknown) {
      session.state = 'failed';
      session.completedAt = new Date().toISOString();
      session.durationMs = Date.now() - startTime;
      session.error = error instanceof Error ? error.message : String(error);
      this.saveSession(session);

      // Fire SubagentStop hook on failure too
      await this.fireSubagentStop(agentId, agentType, session.error, options.cwd);

      // Emit failed event only if not already emitted (isError case already emitted above)
      if (!(error as any).__lifecycleEmitted) {
        try { options.onEvent?.({ type: 'failed', agentId, error: session.error, durationMs: session.durationMs }); } catch { /* non-fatal */ }
      }

      throw error;
    }
  }

  /**
   * Execute an agent in the background. Returns immediately with agent ID and output file.
   * The agent writes its output to the file as it runs.
   */
  async executeInBackground(options: ExecuteOptions): Promise<{ agentId: string; outputFile: string }> {
    const agentId = options.resume || `agent-${randomUUID()}`;
    const agentType = options.definition.name ?? options.definition.description ?? 'unknown';
    const outputFile = join(this.outputDir, `${agentId}.output`);

    const session: AgentSession = {
      agentId,
      agentType,
      name: options.name,
      state: 'spawning',
      startedAt: new Date().toISOString(),
      model: options.model ?? 'default',
      mode: options.mode,
      teamName: options.teamName,
      outputFile,
      numTurns: 0,
      durationMs: 0,
    };

    const runningCount = [...this.agents.values()].filter(
      (a) => a.state === 'running' || a.state === 'spawning',
    ).length;
    if (runningCount >= AgentExecutor.MAX_CONCURRENT_BACKGROUND) {
      throw new Error(
        `Maximum concurrent background agents (${AgentExecutor.MAX_CONCURRENT_BACKGROUND}) reached. ` +
        'Wait for existing agents to complete or stop them with TaskStop.',
      );
    }

    this.agents.set(agentId, session);
    writeFileSync(outputFile, ''); // Create empty output file
    this.saveSession(session);
    if (options.onEvent) this.backgroundEventCallbacks.set(agentId, options.onEvent);

    // Fire SubagentStart hook before launching background task
    await this.fireSubagentStart(agentId, agentType, options.cwd);

    // Create an abort controller for this background agent so stopAgent() can
    // signal it to terminate.
    const abortController = new AbortController();
    this.agentAbortControllers.set(agentId, abortController);

    // Emit launched event
    try { options.onEvent?.({ type: 'launched', agentId, description: options.name }); } catch { /* non-fatal */ }

    // Fire and forget — run in background
    (async () => {
      session.state = 'running';
      const startTime = Date.now();
      try {
        const { AgentRunner } = await import('./agent-runner.js');

        let initialMessages: import('@open-agent/providers').Message[] | undefined;
        if (options.resume) {
          initialMessages = this.loadTranscript(options.resume);
        }

        const bgTranscriptDir = this.getSessionDir(agentId);
        const bgTranscriptPath = join(bgTranscriptDir, 'transcript.jsonl');

        const runner = new AgentRunner({
          definition: options.definition,
          provider: options.provider,
          tools: options.tools,
          cwd: options.cwd,
          maxTurns: options.maxTurns,
          mode: options.mode,
          model: options.model,
          initialMessages,
          worktreePath: options.worktreePath,
          teamName: options.teamName,
          agentName: options.name,
          onMessage: (msg) => {
            try { appendFileSync(bgTranscriptPath, JSON.stringify(msg) + '\n'); } catch { /* non-fatal */ }
          },
          onEvent: options.onEvent,
        });

        const agentResult = await runner.run(options.prompt);

        const wasShutdown = this.agents.get(agentId)?.state === 'shutdown';
        if (wasShutdown) {
          session.completedAt = session.completedAt || new Date().toISOString();
          session.durationMs = Date.now() - startTime;
          appendFileSync(outputFile, '\n--- Agent stopped ---\n');
          this.saveSession(session);
          return;
        }

        session.state = agentResult.isError ? 'failed' : 'completed';
        session.completedAt = new Date().toISOString();
        session.durationMs = Date.now() - startTime;
        session.numTurns = agentResult.numTurns;
        session.totalToolUseCount = agentResult.totalToolUseCount;
        session.totalTokens = agentResult.totalTokens;
        session.usage = agentResult.usage;
        session.result = agentResult.result;
        if (options.worktreePath) {
          session.worktreePath = options.worktreePath;
        }

        // Fire SubagentStop hook
        await this.fireSubagentStop(agentId, agentType, agentResult.result, options.cwd);

        if (agentResult.isError) {
          appendFileSync(outputFile, `\n--- Agent failed ---\n${agentResult.result}\n`);
          try { options.onEvent?.({ type: 'failed', agentId, error: agentResult.result, durationMs: session.durationMs }); } catch { /* non-fatal */ }
        } else {
          appendFileSync(outputFile, `\n--- Agent completed ---\n${agentResult.result}\n`);
          try { options.onEvent?.({ type: 'completed', agentId, durationMs: session.durationMs, totalToolUseCount: agentResult.totalToolUseCount }); } catch { /* non-fatal */ }
          // Notify team lead that this background agent is now idle.
          if (options.teamName && options.name) {
            try {
              const tm = new TeamManager();
              tm.notifyIdle(options.teamName, options.name);
            } catch { /* non-fatal */ }
          }
        }
      } catch (error: unknown) {
        const wasShutdown = this.agents.get(agentId)?.state === 'shutdown';
        if (wasShutdown) {
          session.completedAt = session.completedAt || new Date().toISOString();
          session.durationMs = Date.now() - startTime;
          this.saveSession(session);
          return;
        }
        session.state = 'failed';
        session.completedAt = new Date().toISOString();
        session.durationMs = Date.now() - startTime;
        session.error = error instanceof Error ? error.message : String(error);
        appendFileSync(outputFile, `\n--- Agent failed ---\n${session.error}\n`);

        // Fire SubagentStop hook on failure
        await this.fireSubagentStop(agentId, agentType, session.error, options.cwd);

        try { options.onEvent?.({ type: 'failed', agentId, error: session.error, durationMs: session.durationMs }); } catch { /* non-fatal */ }
      }

      // Clean up abort controller entry for this agent
      this.agentAbortControllers.delete(agentId);
      this.backgroundEventCallbacks.delete(agentId);
      if (this.agentAbortControllers.size > 200) {
        console.warn(`[AgentExecutor] agentAbortControllers Map has ${this.agentAbortControllers.size} entries — possible leak`);
      }

      // Clean up worktree for background agents
      if (options.worktreePath && options.onWorktreeCleanup) {
        try {
          // Determine if worktree has changes (conservatively assume yes on error)
          let hasChanges = true;
          try {
            const result = execSync(['git', 'status', '--porcelain'], { cwd: options.worktreePath });
            hasChanges = result.stdout.trim().length > 0;
          } catch { /* assume changes */ }
          await options.onWorktreeCleanup(options.worktreePath, hasChanges);
        } catch {
          // Non-fatal — worktree cleanup failure shouldn't crash the agent
        }
      }

      this.saveSession(session);
    })();

    return { agentId, outputFile };
  }

  /** Get a background agent's current state */
  getAgent(agentId: string): AgentSession | null {
    return this.agents.get(agentId) ?? this.loadSession(agentId);
  }

  /** List all tracked agents */
  listAgents(): AgentSession[] {
    return Array.from(this.agents.values());
  }

  /** Stop a background agent by sending an abort signal */
  stopAgent(agentId: string): boolean {
    const session = this.agents.get(agentId);
    if (!session || session.state !== 'running') return false;

    // Signal the agent's runner to abort via its AbortController
    const controller = this.agentAbortControllers.get(agentId);
    if (controller) {
      controller.abort();
      this.agentAbortControllers.delete(agentId);
    }

    session.state = 'shutdown';
    session.completedAt = new Date().toISOString();
    session.durationMs = Math.max(0, Date.now() - new Date(session.startedAt).getTime());
    try {
      const cb = this.backgroundEventCallbacks.get(agentId);
      cb?.({ type: 'shutdown', agentId, durationMs: session.durationMs });
    } catch {
      // non-fatal
    }
    this.backgroundEventCallbacks.delete(agentId);
    this.saveSession(session);
    return true;
  }

  // --- Hook helpers ---

  private async fireSubagentStart(agentId: string, agentType: string, cwd: string): Promise<void> {
    if (!this.hookExecutor) return;
    try {
      await this.hookExecutor.execute('SubagentStart', {
        hook_event_name: 'SubagentStart',
        agent_id: agentId,
        agent_type: agentType,
        session_id: agentId,
        transcript_path: join(this.getSessionDir(agentId), 'transcript.jsonl'),
        cwd,
      });
    } catch {
      // Hooks are non-fatal
    }
  }

  private async fireSubagentStop(
    agentId: string,
    agentType: string,
    lastMessage: string,
    cwd: string,
  ): Promise<void> {
    if (!this.hookExecutor) return;
    try {
      await this.hookExecutor.execute('SubagentStop', {
        hook_event_name: 'SubagentStop',
        stop_hook_active: false,
        agent_id: agentId,
        agent_transcript_path: join(this.getSessionDir(agentId), 'transcript.jsonl'),
        agent_type: agentType,
        last_assistant_message: lastMessage,
        session_id: agentId,
        transcript_path: join(this.getSessionDir(agentId), 'transcript.jsonl'),
        cwd,
      });
    } catch {
      // Hooks are non-fatal
    }
  }

  // --- Persistence ---

  private getSessionDir(agentId: string): string {
    return join(this.baseDir, agentId);
  }

  private saveSession(session: AgentSession): void {
    const dir = this.getSessionDir(session.agentId);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'state.json'), JSON.stringify(session, null, 2));
  }

  private loadSession(agentId: string): AgentSession | null {
    const path = join(this.getSessionDir(agentId), 'state.json');
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, 'utf-8'));
    } catch {
      return null;
    }
  }

  private loadTranscript(agentId: string): import('@open-agent/providers').Message[] {
    const path = join(this.getSessionDir(agentId), 'transcript.jsonl');
    if (!existsSync(path)) return [];
    try {
      const entries = readFileSync(path, 'utf-8')
        .split('\n')
        .filter(line => line.trim())
        .map(line => JSON.parse(line));

      const messages: import('@open-agent/providers').Message[] = [];
      // Accumulate tool_result blocks to group them into a single user message
      let pendingToolResults: any[] = [];

      const flushToolResults = () => {
        if (pendingToolResults.length > 0) {
          messages.push({ role: 'user', content: pendingToolResults });
          pendingToolResults = [];
        }
      };

      for (const entry of entries) {
        if (entry.type === 'user') {
          flushToolResults();
          messages.push(entry.message);
        } else if (entry.type === 'assistant') {
          flushToolResults();
          messages.push(entry.message);
        } else if (entry.type === 'tool_result') {
          const result = (entry as any)._fullResult ?? (entry as any).result ?? '';
          pendingToolResults.push({
            type: 'tool_result',
            tool_use_id: entry.tool_use_id,
            content: result,
            is_error: entry.is_error ?? false,
          });
        }
      }
      flushToolResults();
      return messages;
    } catch {
      return [];
    }
  }
}
