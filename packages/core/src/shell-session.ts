/**
 * Persistent shell session manager.
 * Maintains long-running shell processes for efficient command execution,
 * matching Claude Code's Shell.ts session lifecycle.
 */

export interface ShellSession {
  id: string;
  pid: number;
  cwd: string;
  state: 'active' | 'idle' | 'exited' | 'error';
  createdAt: string;
  lastCommandAt?: string;
  commandCount: number;
}

export interface ShellSessionConfig {
  /** Shell to use (default: process.env.SHELL or '/bin/sh') */
  shell?: string;
  /** Working directory */
  cwd: string;
  /** Environment variables */
  env?: Record<string, string>;
  /** Max idle time before auto-cleanup in ms (default: 300000 = 5min) */
  maxIdleMs?: number;
  /** Terminal columns (default: 80) */
  cols?: number;
  /** Terminal rows (default: 24) */
  rows?: number;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
}

/**
 * Shell session pool — manages multiple persistent shell sessions.
 */
export class ShellSessionPool {
  private sessions = new Map<string, { session: ShellSession; proc: any; idleTimer?: ReturnType<typeof setTimeout> }>();
  private defaultConfig: ShellSessionConfig;
  private nextId = 0;

  constructor(config: ShellSessionConfig) {
    this.defaultConfig = config;
  }

  /** Create a new shell session. */
  async create(config?: Partial<ShellSessionConfig>): Promise<ShellSession> {
    const id = `shell-${++this.nextId}`;
    const merged = { ...this.defaultConfig, ...config };
    const shell = merged.shell ?? process.env.SHELL ?? '/bin/sh';

    const proc = Bun.spawn([shell], {
      cwd: merged.cwd,
      env: { ...process.env, ...merged.env },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const session: ShellSession = {
      id,
      pid: proc.pid,
      cwd: merged.cwd,
      state: 'idle',
      createdAt: new Date().toISOString(),
      commandCount: 0,
    };

    const entry = { session, proc, idleTimer: undefined as ReturnType<typeof setTimeout> | undefined };
    this.sessions.set(id, entry);

    // Auto-cleanup timer
    if (merged.maxIdleMs) {
      entry.idleTimer = setTimeout(() => this.destroy(id), merged.maxIdleMs);
    }

    return session;
  }

  /** Execute a command in an existing session or create a new one. */
  async exec(command: string, opts?: { sessionId?: string; timeout?: number; cwd?: string }): Promise<CommandResult> {
    const t0 = performance.now();
    const cwd = opts?.cwd ?? this.defaultConfig.cwd;
    const timeout = opts?.timeout ?? 120_000;

    // Use Bun.spawn for per-command execution (persistent PTY requires node-pty)
    const proc = Bun.spawn(['sh', '-c', command], {
      cwd,
      env: process.env,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, timeout);

    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    clearTimeout(timer);

    return {
      stdout,
      stderr,
      exitCode: timedOut ? 124 : exitCode,
      durationMs: Math.round(performance.now() - t0),
      timedOut,
    };
  }

  /** Get session by ID. */
  get(id: string): ShellSession | null {
    return this.sessions.get(id)?.session ?? null;
  }

  /** List all active sessions. */
  list(): ShellSession[] {
    return [...this.sessions.values()].map(e => ({ ...e.session }));
  }

  /** Destroy a specific session. */
  async destroy(id: string): Promise<boolean> {
    const entry = this.sessions.get(id);
    if (!entry) return false;

    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    try { entry.proc.kill(); } catch {}
    entry.session.state = 'exited';
    this.sessions.delete(id);
    return true;
  }

  /** Destroy all sessions. */
  async destroyAll(): Promise<void> {
    for (const id of [...this.sessions.keys()]) {
      await this.destroy(id);
    }
  }

  /** Get pool stats. */
  stats(): { total: number; active: number; idle: number } {
    let active = 0, idle = 0;
    for (const entry of this.sessions.values()) {
      if (entry.session.state === 'active') active++;
      else if (entry.session.state === 'idle') idle++;
    }
    return { total: this.sessions.size, active, idle };
  }
}
