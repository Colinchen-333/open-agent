import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, writeFileSync, readFileSync, appendFileSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';
import type { AgentDefinition } from '@open-agent/core';
import type { LLMProvider } from '@open-agent/providers';
import type { ToolDefinition } from '@open-agent/tools';

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
  private agents = new Map<string, AgentSession>();
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
    const agentId = options.resume || `agent-${randomUUID().slice(0, 12)}`;
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

    try {
      // Import AgentRunner dynamically to avoid circular deps
      const { AgentRunner } = await import('./agent-runner.js');

      // Load previous messages if resuming
      let initialMessages: import('@open-agent/providers').Message[] | undefined;
      if (options.resume) {
        initialMessages = this.loadTranscript(options.resume);
      }

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
      });

      const agentResult = await runner.run(options.prompt);

      session.state = agentResult.isError ? 'failed' : 'completed';
      session.completedAt = new Date().toISOString();
      session.durationMs = Date.now() - startTime;
      session.numTurns = agentResult.numTurns;
      session.result = agentResult.result;
      if (options.worktreePath) {
        session.worktreePath = options.worktreePath;
      }
      this.saveSession(session);

      // Fire SubagentStop hook
      await this.fireSubagentStop(agentId, agentType, agentResult.result, options.cwd);

      if (agentResult.isError) {
        throw new Error(agentResult.result || 'Agent execution failed');
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

      throw error;
    }
  }

  /**
   * Execute an agent in the background. Returns immediately with agent ID and output file.
   * The agent writes its output to the file as it runs.
   */
  async executeInBackground(options: ExecuteOptions): Promise<{ agentId: string; outputFile: string }> {
    const agentId = options.resume || `agent-${randomUUID().slice(0, 12)}`;
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

    this.agents.set(agentId, session);
    writeFileSync(outputFile, ''); // Create empty output file
    this.saveSession(session);

    // Fire SubagentStart hook before launching background task
    await this.fireSubagentStart(agentId, agentType, options.cwd);

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
        });

        const agentResult = await runner.run(options.prompt);

        session.state = agentResult.isError ? 'failed' : 'completed';
        session.completedAt = new Date().toISOString();
        session.durationMs = Date.now() - startTime;
        session.numTurns = agentResult.numTurns;
        session.result = agentResult.result;
        if (options.worktreePath) {
          session.worktreePath = options.worktreePath;
        }

        // Fire SubagentStop hook
        await this.fireSubagentStop(agentId, agentType, agentResult.result, options.cwd);

        if (agentResult.isError) {
          appendFileSync(outputFile, `\n--- Agent failed ---\n${agentResult.result}\n`);
        } else {
          appendFileSync(outputFile, `\n--- Agent completed ---\n${agentResult.result}\n`);
        }
      } catch (error: unknown) {
        session.state = 'failed';
        session.completedAt = new Date().toISOString();
        session.durationMs = Date.now() - startTime;
        session.error = error instanceof Error ? error.message : String(error);
        appendFileSync(outputFile, `\n--- Agent failed ---\n${session.error}\n`);

        // Fire SubagentStop hook on failure
        await this.fireSubagentStop(agentId, agentType, session.error, options.cwd);
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

  /** Stop a background agent (best-effort) */
  stopAgent(agentId: string): boolean {
    const session = this.agents.get(agentId);
    if (!session || session.state !== 'running') return false;
    session.state = 'shutdown';
    session.completedAt = new Date().toISOString();
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
      return readFileSync(path, 'utf-8')
        .split('\n')
        .filter(line => line.trim())
        .map(line => JSON.parse(line))
        .filter((entry: any) => entry.type === 'user' || entry.type === 'assistant')
        .map((entry: any) => entry.message);
    } catch {
      return [];
    }
  }
}
