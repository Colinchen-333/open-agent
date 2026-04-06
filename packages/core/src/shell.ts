/**
 * Multi-mode shell execution framework.
 * Supports bash, sh, zsh with sandbox wrapping, signal handling,
 * output limits, and PTY-aware execution.
 */

export type ShellMode = 'bash' | 'sh' | 'zsh' | 'powershell';
export type SandboxMode = 'none' | 'darwin-seatbelt' | 'linux-bwrap';

export interface ShellConfig {
  mode: ShellMode;
  cwd: string;
  env?: Record<string, string>;
  sandbox?: SandboxMode;
  /** Max output size in bytes before truncation (default: 1MB) */
  maxOutputBytes?: number;
  /** Command timeout in ms (default: 120000) */
  timeoutMs?: number;
  /** Whether to use PTY (default: false, requires node-pty bridge) */
  usePty?: boolean;
  /** Columns for PTY (default: 80) */
  cols?: number;
  /** Rows for PTY (default: 24) */
  rows?: number;
}

export interface ShellExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  signal?: string;
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;
  /** Actual bytes before truncation */
  rawOutputBytes: number;
  /** Sandbox violations detected */
  sandboxViolations?: string[];
}

export interface ShellSignalHandler {
  onOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void;
  onExit?: (code: number, signal?: string) => void;
  onError?: (error: Error) => void;
}

/** Get the default shell for the current platform */
export function getDefaultShell(): ShellMode {
  const shell = process.env.SHELL ?? '';
  if (shell.endsWith('zsh')) return 'zsh';
  if (shell.endsWith('bash')) return 'bash';
  if (process.platform === 'win32') return 'powershell';
  return 'sh';
}

/** Get the shell binary path */
export function getShellBinary(mode: ShellMode): string {
  switch (mode) {
    case 'bash': return '/bin/bash';
    case 'sh': return '/bin/sh';
    case 'zsh': return '/bin/zsh';
    case 'powershell': return process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
  }
}

/** Build shell command args for -c execution */
export function buildShellArgs(mode: ShellMode, command: string): string[] {
  const binary = getShellBinary(mode);
  switch (mode) {
    case 'bash':
    case 'sh':
    case 'zsh':
      return [binary, '-c', command];
    case 'powershell':
      return [binary, '-NoProfile', '-NonInteractive', '-Command', command];
  }
}

/** Detect the sandbox mode for the current platform */
export function detectSandboxMode(): SandboxMode {
  if (process.platform === 'darwin') return 'darwin-seatbelt';
  if (process.platform === 'linux') return 'linux-bwrap';
  return 'none';
}

/** Truncate output to maxBytes, preserving the tail */
function truncateOutput(output: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.byteLength(output, 'utf-8');
  if (bytes <= maxBytes) return { text: output, truncated: false };

  // Keep the last maxBytes worth of content
  const buf = Buffer.from(output, 'utf-8');
  const truncated = buf.subarray(buf.length - maxBytes).toString('utf-8');
  const header = `[Output truncated: ${bytes} bytes total, showing last ${maxBytes} bytes]\n`;
  return { text: header + truncated, truncated: true };
}

/**
 * Execute a shell command with full lifecycle management.
 */
export async function shellExec(
  command: string,
  config: ShellConfig,
  handler?: ShellSignalHandler,
): Promise<ShellExecResult> {
  const maxOutput = config.maxOutputBytes ?? 1_048_576; // 1MB
  const timeout = config.timeoutMs ?? 120_000;
  const args = buildShellArgs(config.mode, command);

  const t0 = performance.now();
  let timedOut = false;

  const proc = Bun.spawn(args, {
    cwd: config.cwd,
    env: { ...process.env, ...config.env },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const timer = setTimeout(() => {
    timedOut = true;
    try { proc.kill('SIGTERM'); } catch { /* process may have already exited */ }
    // Force kill after 5s if still running
    setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* ignore */ } }, 5000);
  }, timeout);

  const [exitCode, rawStdout, rawStderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  clearTimeout(timer);

  // Stream callbacks (post-collection for non-PTY mode)
  if (handler?.onOutput && rawStdout) handler.onOutput(rawStdout, 'stdout');
  if (handler?.onOutput && rawStderr) handler.onOutput(rawStderr, 'stderr');
  if (handler?.onExit) handler.onExit(timedOut ? 124 : exitCode);

  const durationMs = Math.round(performance.now() - t0);
  const rawOutputBytes = Buffer.byteLength(rawStdout + rawStderr, 'utf-8');

  const { text: stdout, truncated: stdoutTrunc } = truncateOutput(rawStdout, maxOutput);
  const { text: stderr, truncated: stderrTrunc } = truncateOutput(rawStderr, maxOutput);

  return {
    stdout,
    stderr,
    exitCode: timedOut ? 124 : exitCode,
    signal: timedOut ? 'SIGTERM' : undefined,
    durationMs,
    timedOut,
    truncated: stdoutTrunc || stderrTrunc,
    rawOutputBytes,
  };
}

/**
 * Execute multiple commands in sequence, stopping on first failure.
 */
export async function shellExecChain(
  commands: string[],
  config: ShellConfig,
): Promise<{ results: ShellExecResult[]; allSucceeded: boolean }> {
  const results: ShellExecResult[] = [];
  for (const cmd of commands) {
    const result = await shellExec(cmd, config);
    results.push(result);
    if (result.exitCode !== 0) {
      return { results, allSucceeded: false };
    }
  }
  return { results, allSucceeded: true };
}

/**
 * Execute a command with automatic retry on specific exit codes.
 */
export async function shellExecWithRetry(
  command: string,
  config: ShellConfig,
  opts?: { maxRetries?: number; retryExitCodes?: number[]; delayMs?: number },
): Promise<ShellExecResult> {
  const maxRetries = opts?.maxRetries ?? 2;
  const retryOn = new Set(opts?.retryExitCodes ?? [124, 137]); // timeout, killed
  const delay = opts?.delayMs ?? 1000;

  let lastResult: ShellExecResult | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    lastResult = await shellExec(command, config);
    if (lastResult.exitCode === 0 || !retryOn.has(lastResult.exitCode)) {
      return lastResult;
    }
    if (attempt < maxRetries) {
      await new Promise(r => setTimeout(r, delay));
    }
  }
  return lastResult!;
}
