import { createRequire } from 'module';

/**
 * Cross-runtime utilities for Bun and Node.js/Electron.
 *
 * Use `'Bun' in globalThis` (not `typeof Bun`) as the runtime check.
 * All Bun APIs are accessed through `(globalThis as any).Bun` to avoid
 * TypeScript errors when compiling under Node.js type definitions.
 */

const IS_BUN = 'Bun' in globalThis;
const NODE_REQUIRE = IS_BUN ? null : createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExecOptions {
  /** Working directory for the child process. */
  cwd?: string;
  /** Additional environment variables merged with process.env. */
  env?: Record<string, string>;
  /** String written to the process's stdin before closing it. */
  stdin?: string;
  /** Timeout in milliseconds. If exceeded the process is killed. */
  timeout?: number;
}

export interface ExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** True when the process was killed due to timeout. */
  timedOut: boolean;
}

export interface SpawnHandle {
  /** Write a string to the process's stdin. */
  writeStdin(data: string): void;
  /** Close the stdin pipe (sends EOF). */
  closeStdin(): void;
  /** Force-kill the process. */
  kill(signal?: string): void;
  /** Resolves with the exit code when the process exits. */
  exited: Promise<number | null>;
  /** Readable stream for stdout (Node: Readable; Bun: ReadableStream). */
  stdout: AsyncIterable<Uint8Array> | NodeJS.ReadableStream | null;
  /** Readable stream for stderr (Node: Readable; Bun: ReadableStream). */
  stderr: AsyncIterable<Uint8Array> | NodeJS.ReadableStream | null;
  /** Collect all stdout as a string. */
  stdoutText(): Promise<string>;
  /** Collect all stderr as a string. */
  stderrText(): Promise<string>;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function mergeEnv(env?: Record<string, string>): Record<string, string> {
  return env ? { ...process.env, ...env } as Record<string, string> : process.env as Record<string, string>;
}

/** Read all bytes from a Node.js Readable into a string. */
function nodeStreamToText(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
    });
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    stream.on('error', reject);
  });
}

/** Schedule a kill after `ms` milliseconds; returns a cancel function. */
function scheduleKill(killFn: () => void, ms: number): () => void {
  const t = setTimeout(killFn, ms);
  return () => clearTimeout(t);
}

// ---------------------------------------------------------------------------
// exec — async, collects stdout/stderr, returns exit code
// ---------------------------------------------------------------------------

export async function exec(cmd: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  const env = mergeEnv(opts.env);

  if (IS_BUN) {
    const B = (globalThis as any).Bun;
    const proc = B.spawn(cmd, {
      cwd: opts.cwd,
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: opts.stdin !== undefined ? 'pipe' : 'ignore',
      env,
    });

    if (opts.stdin !== undefined) {
      proc.stdin.write(opts.stdin);
      proc.stdin.flush();
      proc.stdin.end();
    }

    let timedOut = false;
    let cancelTimeout: (() => void) | undefined;
    if (opts.timeout !== undefined) {
      cancelTimeout = scheduleKill(() => {
        timedOut = true;
        proc.kill();
      }, opts.timeout);
    }

    let stdout = '';
    let stderr = '';
    try {
      [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      await proc.exited;
    } finally {
      cancelTimeout?.();
    }

    return {
      exitCode: proc.exitCode as number | null,
      stdout,
      stderr,
      timedOut,
    };
  } else {
    // Node.js path
    const { spawn } = await import('child_process');
    return new Promise<ExecResult>((resolve, reject) => {
      const child = spawn(cmd[0], cmd.slice(1), {
        cwd: opts.cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
      child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

      if (opts.stdin !== undefined) {
        child.stdin?.write(opts.stdin);
        child.stdin?.end();
      }

      let timedOut = false;
      let cancelTimeout: (() => void) | undefined;
      if (opts.timeout !== undefined) {
        cancelTimeout = scheduleKill(() => {
          timedOut = true;
          child.kill();
        }, opts.timeout);
      }

      child.on('error', (err) => {
        cancelTimeout?.();
        reject(err);
      });

      child.on('close', (code) => {
        cancelTimeout?.();
        resolve({
          exitCode: code,
          stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
          stderr: Buffer.concat(stderrChunks).toString('utf-8'),
          timedOut,
        });
      });
    });
  }
}

// ---------------------------------------------------------------------------
// execSync — synchronous variant
// ---------------------------------------------------------------------------

export interface ExecSyncResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export function execSync(cmd: string[], opts: Omit<ExecOptions, 'timeout'> = {}): ExecSyncResult {
  const env = mergeEnv(opts.env);

  if (IS_BUN) {
    const B = (globalThis as any).Bun;
    const result = B.spawnSync(cmd, {
      cwd: opts.cwd,
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: opts.stdin !== undefined ? opts.stdin : undefined,
      env,
    });
    return {
      exitCode: result.exitCode as number | null,
      stdout: new TextDecoder().decode(result.stdout),
      stderr: new TextDecoder().decode(result.stderr),
    };
  } else {
    // Node.js path
    const cp = NODE_REQUIRE!('child_process') as typeof import('child_process');
    try {
      const stdout = cp.execFileSync(cmd[0], cmd.slice(1), {
        cwd: opts.cwd,
        env,
        input: opts.stdin,
        encoding: 'utf-8',
      });
      return { exitCode: 0, stdout: stdout as string, stderr: '' };
    } catch (err: any) {
      return {
        exitCode: err.status ?? 1,
        stdout: (err.stdout ?? '') as string,
        stderr: (err.stderr ?? '') as string,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// spawnProcess — long-running process with streaming handles
// ---------------------------------------------------------------------------

export async function spawnProcess(cmd: string[], opts: ExecOptions = {}): Promise<SpawnHandle> {
  const env = mergeEnv(opts.env);

  if (IS_BUN) {
    const B = (globalThis as any).Bun;
    const proc = B.spawn(cmd, {
      cwd: opts.cwd,
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'pipe',
      env,
    });

    let cancelTimeout: (() => void) | undefined;

    const handle: SpawnHandle = {
      writeStdin(data: string) {
        proc.stdin.write(data);
      },
      closeStdin() {
        proc.stdin.flush();
        proc.stdin.end();
      },
      kill(signal?: string) {
        cancelTimeout?.();
        proc.kill(signal);
      },
      exited: (proc.exited as Promise<number>).then((code: number) => code as number | null),
      stdout: proc.stdout,
      stderr: proc.stderr,
      stdoutText() {
        return new Response(proc.stdout).text();
      },
      stderrText() {
        return new Response(proc.stderr).text();
      },
    };

    if (opts.timeout !== undefined) {
      cancelTimeout = scheduleKill(() => {
        proc.kill();
      }, opts.timeout);
      // Auto-cancel when process exits
      handle.exited.finally(() => cancelTimeout?.());
    }

    if (opts.stdin !== undefined) {
      handle.writeStdin(opts.stdin);
      handle.closeStdin();
    }

    return handle;
  } else {
    // Node.js path
    const { spawn } = await import('child_process');
    const child = spawn(cmd[0], cmd.slice(1), {
      cwd: opts.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let cancelTimeout: (() => void) | undefined;

    const exitedPromise = new Promise<number | null>((resolve) => {
      child.on('close', (code) => {
        cancelTimeout?.();
        resolve(code);
      });
      child.on('error', () => {
        cancelTimeout?.();
        resolve(null);
      });
    });

    const handle: SpawnHandle = {
      writeStdin(data: string) {
        child.stdin?.write(data);
      },
      closeStdin() {
        child.stdin?.end();
      },
      kill(signal?: string) {
        cancelTimeout?.();
        child.kill((signal as NodeJS.Signals) ?? 'SIGTERM');
      },
      exited: exitedPromise,
      stdout: child.stdout,
      stderr: child.stderr,
      stdoutText() {
        return child.stdout ? nodeStreamToText(child.stdout) : Promise.resolve('');
      },
      stderrText() {
        return child.stderr ? nodeStreamToText(child.stderr) : Promise.resolve('');
      },
    };

    if (opts.timeout !== undefined) {
      cancelTimeout = scheduleKill(() => {
        child.kill();
      }, opts.timeout);
    }

    if (opts.stdin !== undefined) {
      handle.writeStdin(opts.stdin);
      handle.closeStdin();
    }

    return handle;
  }
}

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

/** Read a file as a UTF-8 string. */
export async function readText(filePath: string): Promise<string> {
  if (IS_BUN) {
    const B = (globalThis as any).Bun;
    return B.file(filePath).text() as Promise<string>;
  } else {
    const { readFile } = await import('fs/promises');
    return readFile(filePath, 'utf-8');
  }
}

/** Write a string to a file, overwriting existing content. */
export async function writeText(filePath: string, content: string): Promise<void> {
  if (IS_BUN) {
    const B = (globalThis as any).Bun;
    await B.write(filePath, content);
  } else {
    const { writeFile } = await import('fs/promises');
    await writeFile(filePath, content, 'utf-8');
  }
}

/** Check whether a file exists at the given path. */
export async function fileExists(filePath: string): Promise<boolean> {
  if (IS_BUN) {
    const B = (globalThis as any).Bun;
    return B.file(filePath).exists() as Promise<boolean>;
  } else {
    const { access } = await import('fs/promises');
    try {
      await access(filePath);
      return true;
    } catch {
      return false;
    }
  }
}

/** Return the byte size of a file. */
export async function fileSize(filePath: string): Promise<number> {
  if (IS_BUN) {
    const B = (globalThis as any).Bun;
    return B.file(filePath).size as number;
  } else {
    const { stat } = await import('fs/promises');
    const s = await stat(filePath);
    return s.size;
  }
}

/**
 * Return a MIME type for the file based on its extension.
 *
 * Bun provides `Bun.file(path).type` for this; under Node.js we use a
 * static extension→MIME mapping (the set covers all types used in this
 * project).  The function is synchronous so callers do not need to await.
 */
export function fileMimeType(filePath: string): string {
  if (IS_BUN) {
    const B = (globalThis as any).Bun;
    // Bun.file().type is a synchronous property getter
    return B.file(filePath).type as string;
  } else {
    const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
    const MIME_MAP: Record<string, string> = {
      // Images
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.bmp': 'image/bmp',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon',
      '.tiff': 'image/tiff',
      // Text
      '.txt': 'text/plain',
      '.html': 'text/html',
      '.htm': 'text/html',
      '.css': 'text/css',
      '.csv': 'text/csv',
      '.md': 'text/markdown',
      // Code
      '.js': 'application/javascript',
      '.mjs': 'application/javascript',
      '.cjs': 'application/javascript',
      '.ts': 'application/typescript',
      '.tsx': 'application/typescript',
      '.jsx': 'application/javascript',
      '.json': 'application/json',
      '.xml': 'application/xml',
      '.yaml': 'application/x-yaml',
      '.yml': 'application/x-yaml',
      // Documents
      '.pdf': 'application/pdf',
      // Archives
      '.zip': 'application/zip',
      '.tar': 'application/x-tar',
      '.gz': 'application/gzip',
      // Audio/Video
      '.mp3': 'audio/mpeg',
      '.mp4': 'video/mp4',
      '.webm': 'video/webm',
      // Fonts
      '.woff': 'font/woff',
      '.woff2': 'font/woff2',
      '.ttf': 'font/ttf',
    };
    return MIME_MAP[ext] ?? 'application/octet-stream';
  }
}

/** The current Bun version, or the Node.js version string if running under Node. */
export const runtimeVersion: string = IS_BUN
  ? (globalThis as any).Bun.version as string
  : process.version;
