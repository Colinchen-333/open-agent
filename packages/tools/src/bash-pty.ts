/**
 * Persistent PTY session for the Bash tool.
 *
 * Bun's runtime does not drive the libuv I/O callbacks used by node-pty's
 * native addon, so we cannot use node-pty directly from Bun code.  Instead,
 * each BashPtySession owns a Node.js child process (`bash-pty-worker.js`)
 * that hosts the node-pty instance.  The parent (Bun) communicates with the
 * worker over stdin/stdout using newline-delimited JSON (NDJSON).
 *
 * Worker protocol (parent → worker):
 *   { "cmd": "exec", "id": N, "command": "…", "timeout": N }
 *   { "cmd": "kill" }
 *
 * Worker protocol (worker → parent):
 *   { "type": "ready" }
 *   { "type": "result", "id": N, "stdout": "…", "exitCode": N | null }
 *   { "type": "error",  "id": N, "message": "…" }
 */

import { spawn } from 'child_process';
import { createInterface } from 'readline';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface BashPtyOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

export interface BashPtyExecOptions {
  /** Milliseconds before the command is considered timed out. Default 60 000. */
  timeout?: number;
}

export interface BashPtyResult {
  stdout: string;
  exitCode: number | null;
}

// ---------------------------------------------------------------------------
// Resolve the worker script path
// ---------------------------------------------------------------------------

// Works for both ESM (import.meta.url) and CJS (__dirname) contexts.
let _workerPath: string;
try {
  // ESM
  _workerPath = join(
    dirname(fileURLToPath(import.meta.url)),
    'bash-pty-worker.js',
  );
} catch {
  // CJS fallback
  _workerPath = join(__dirname, 'bash-pty-worker.js');
}

// Resolve to absolute, robust path
const WORKER_PATH = resolve(_workerPath);

// ---------------------------------------------------------------------------
// BashPtySession
// ---------------------------------------------------------------------------

interface PendingExec {
  id: number;
  resolve: (result: BashPtyResult) => void;
  reject: (err: Error) => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

let _globalSeq = 0;

export class BashPtySession {
  private readonly worker: ReturnType<typeof spawn>;
  private readonly pending = new Map<number, PendingExec>();
  private readonly readyPromise: Promise<void>;
  private closed = false;

  constructor(opts: BashPtyOptions) {
    const env: Record<string, string> = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(([, v]) => v !== undefined) as [string, string][],
      ),
      PTY_CWD: opts.cwd,
      PTY_ENV: JSON.stringify(opts.env ?? {}),
    };

    this.worker = spawn('node', [WORKER_PATH], {
      stdio: ['pipe', 'pipe', 'inherit'],
      env,
    });

    // Set up readline interface for incoming messages
    const rl = createInterface({ input: this.worker.stdout! });
    rl.on('line', (line) => this._handleLine(line));

    this.worker.on('exit', () => {
      // Reject all pending commands
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timeoutHandle);
        pending.reject(new Error('PTY worker exited unexpectedly'));
      }
      this.pending.clear();
      this.closed = true;
    });

    // readyPromise resolves when the worker sends { "type": "ready" }
    this.readyPromise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('PTY worker did not send ready within 5s')),
        5000,
      );
      const handler = (line: string) => {
        let msg: { type?: string };
        try { msg = JSON.parse(line); } catch { return; }
        if (msg.type === 'ready') {
          clearTimeout(timeout);
          rl.off('line', handler);
          resolve();
        }
      };
      rl.on('line', handler);
    });
  }

  private _handleLine(line: string): void {
    let msg: { type?: string; id?: number; stdout?: string; exitCode?: number | null; message?: string };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }

    if (msg.type === 'result' || msg.type === 'error') {
      const pending = this.pending.get(msg.id!);
      if (!pending) return;
      this.pending.delete(msg.id!);
      clearTimeout(pending.timeoutHandle);

      if (msg.type === 'result') {
        pending.resolve({ stdout: msg.stdout ?? '', exitCode: msg.exitCode ?? null });
      } else {
        pending.reject(new Error(msg.message ?? 'unknown PTY error'));
      }
    }
  }

  /**
   * Execute `command` inside the persistent shell and return its stdout and
   * exit code.  Shell state (cwd, env, functions, aliases) persists across
   * calls.
   */
  async exec(
    command: string,
    opts: BashPtyExecOptions = {},
  ): Promise<BashPtyResult> {
    if (this.closed) {
      throw new Error('BashPtySession is closed');
    }

    await this.readyPromise;

    const timeout = opts.timeout ?? 60_000;
    const id = ++_globalSeq;

    return new Promise<BashPtyResult>((resolve, reject) => {
      // Worker-side timeout is the authoritative one; we add a small safety
      // margin (500ms) on the Bun side so we get the worker's error message.
      const safetyTimeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`command timeout after ${timeout}ms`));
      }, timeout + 500);

      this.pending.set(id, { id, resolve, reject, timeoutHandle: safetyTimeout });

      const msg = JSON.stringify({ cmd: 'exec', id, command, timeout });
      this.worker.stdin!.write(msg + '\n');
    });
  }

  /** Terminate the underlying PTY worker process. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      this.worker.stdin!.write(JSON.stringify({ cmd: 'kill' }) + '\n');
    } catch {
      // ignore write errors during close
    }
    this.worker.kill();
  }
}

// ---------------------------------------------------------------------------
// Module-level session store (keyed by agent sessionId)
// ---------------------------------------------------------------------------

const _sessions = new Map<string, BashPtySession>();

/**
 * Return the existing BashPtySession for `sessionId`, or create a new one
 * with the supplied `opts`.
 *
 * The `opts` are only used when a new session is created — they are ignored
 * for subsequent calls with the same `sessionId`.
 */
export function getOrCreateBashPty(
  sessionId: string,
  opts: BashPtyOptions,
): BashPtySession {
  let sess = _sessions.get(sessionId);
  if (!sess) {
    sess = new BashPtySession(opts);
    _sessions.set(sessionId, sess);
  }
  return sess;
}

/**
 * Close and remove the BashPtySession for `sessionId` (if any).
 */
export async function closeBashPty(sessionId: string): Promise<void> {
  const sess = _sessions.get(sessionId);
  if (sess) {
    await sess.close();
    _sessions.delete(sessionId);
  }
}
