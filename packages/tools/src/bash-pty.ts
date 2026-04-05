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
 *
 * If the underlying bash shell exits (e.g. because a command called `exit` or
 * `set -e` caused it to abort), the worker process also exits.  In that case
 * BashPtySession transparently spawns a new worker on the next exec() call so
 * the session remains usable (starting from a fresh shell in the original cwd).
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
// Internal worker wrapper (one per BashPtySession)
// ---------------------------------------------------------------------------

interface PendingExec {
  id: number;
  resolve: (result: BashPtyResult) => void;
  reject: (err: Error) => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

let _globalSeq = 0;

class PtyWorker {
  readonly process: ReturnType<typeof spawn>;
  readonly pending = new Map<number, PendingExec>();
  readonly readyPromise: Promise<void>;
  dead = false;

  constructor(opts: BashPtyOptions) {
    const env: Record<string, string> = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(([, v]) => v !== undefined) as [string, string][],
      ),
      PTY_CWD: opts.cwd,
      PTY_ENV: JSON.stringify(opts.env ?? {}),
    };

    this.process = spawn('node', [WORKER_PATH], {
      stdio: ['pipe', 'pipe', 'inherit'],
      env,
    });

    const rl = createInterface({ input: this.process.stdout! });
    rl.on('line', (line) => this._handleLine(line));

    this.process.on('exit', () => {
      this.dead = true;
      // Give the result message a chance to arrive via stdout before rejecting.
      // The worker sends the result message just before exiting, and Node/Bun
      // may deliver the exit event before the final stdout data is processed.
      setTimeout(() => {
        for (const p of this.pending.values()) {
          clearTimeout(p.timeoutHandle);
          p.reject(new Error('PTY shell exited unexpectedly'));
        }
        this.pending.clear();
      }, 800);
    });

    this.readyPromise = new Promise<void>((res, rej) => {
      const t = setTimeout(
        () => rej(new Error('PTY worker did not send ready within 5s')),
        5000,
      );
      const handler = (line: string) => {
        let msg: { type?: string };
        try { msg = JSON.parse(line); } catch { return; }
        if (msg.type === 'ready') {
          clearTimeout(t);
          rl.off('line', handler);
          res();
        }
      };
      rl.on('line', handler);
    });
  }

  private _handleLine(line: string): void {
    let msg: {
      type?: string;
      id?: number;
      stdout?: string;
      exitCode?: number | null;
      message?: string;
    };
    try { msg = JSON.parse(line); } catch { return; }

    if (msg.type === 'shell-exited') {
      // The bash shell has exited; mark this worker dead immediately so the
      // next exec() call creates a fresh worker rather than writing to a dead shell.
      this.dead = true;
      return;
    }

    if (msg.type === 'result' || msg.type === 'error') {
      const p = this.pending.get(msg.id!);
      if (!p) return;
      this.pending.delete(msg.id!);
      clearTimeout(p.timeoutHandle);
      if (msg.type === 'result') {
        p.resolve({ stdout: msg.stdout ?? '', exitCode: msg.exitCode ?? null });
      } else {
        p.reject(new Error(msg.message ?? 'unknown PTY error'));
      }
    }
  }

  kill(): void {
    this.dead = true;
    try { this.process.stdin!.write(JSON.stringify({ cmd: 'kill' }) + '\n'); } catch { /* ignore */ }
    this.process.kill();
  }
}

// ---------------------------------------------------------------------------
// BashPtySession — public API
// ---------------------------------------------------------------------------

export class BashPtySession {
  private readonly opts: BashPtyOptions;
  private worker: PtyWorker;
  private _closed = false;

  constructor(opts: BashPtyOptions) {
    this.opts = opts;
    this.worker = new PtyWorker(opts);
  }

  /**
   * Execute `command` inside the persistent shell and return its stdout and
   * exit code.  Shell state (cwd, env, functions, aliases) persists across
   * calls.
   *
   * If the underlying bash process exited (e.g. due to `exit` or an unhandled
   * `set -e` failure) a new worker is spawned automatically so the session
   * remains usable.
   */
  async exec(
    command: string,
    opts: BashPtyExecOptions = {},
  ): Promise<BashPtyResult> {
    if (this._closed) throw new Error('BashPtySession is closed');

    // Yield to allow any pending I/O callbacks (like the `shell-exited` readline
    // line or the process `exit` event) to fire before we check the dead flag.
    // We use setTimeout(0) rather than setImmediate because the shell-exited
    // message may arrive in a separate I/O chunk from the result, so setImmediate
    // alone may not be sufficient.
    await new Promise<void>((r) => setTimeout(r, 0));

    // Auto-restart if the previous shell died.
    if (this.worker.dead || this.worker.process.exitCode !== null) {
      this.worker = new PtyWorker(this.opts);
    }

    const timeout = opts.timeout ?? 60_000;
    const id = ++_globalSeq;
    const worker = this.worker;

    await worker.readyPromise;

    return new Promise<BashPtyResult>((resolve, reject) => {
      // Safety timeout on Bun side (worker-side timeout + 500ms margin)
      const safetyTimeout = setTimeout(() => {
        worker.pending.delete(id);
        reject(new Error(`command timeout after ${timeout}ms`));
      }, timeout + 500);

      worker.pending.set(id, { id, resolve, reject, timeoutHandle: safetyTimeout });

      worker.process.stdin!.write(JSON.stringify({ cmd: 'exec', id, command, timeout }) + '\n');
    });
  }

  /** Terminate the underlying PTY worker process. */
  async close(): Promise<void> {
    if (this._closed) return;
    this._closed = true;
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
