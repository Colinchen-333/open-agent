import { randomUUID } from 'crypto';
import {
  existsSync,
  mkdirSync,
  appendFileSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export interface SessionInfo {
  id: string;
  cwd: string;
  model: string;
  createdAt: string;
  lastActiveAt: string;
}

/**
 * Manages agent session metadata and transcripts on disk.
 *
 * Layout under `~/.open-agent/projects/`:
 *   <safe-cwd>/
 *     <session-id>.meta.json   — session metadata
 *     <session-id>.jsonl       — newline-delimited JSON transcript
 *
 * The "safe CWD" is the absolute path with every `/` replaced by `-` and any
 * leading `-` stripped, e.g. `/Users/foo/bar` → `Users-foo-bar`.
 */
export class SessionManager {
  private baseDir: string;

  constructor() {
    this.baseDir = join(homedir(), '.open-agent', 'projects');
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Derive a filesystem-safe directory name from an absolute CWD path and
   * ensure the directory exists, creating it recursively if needed.
   */
  private getProjectDir(cwd: string): string {
    // Replace every forward-slash with a hyphen, then strip any leading hyphen
    // that results from a path starting with `/`.
    const safePath = cwd.replace(/\//g, '-').replace(/^-/, '');
    const dir = join(this.baseDir, safePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  private metaPath(projectDir: string, sessionId: string): string {
    return join(projectDir, `${sessionId}.meta.json`);
  }

  private transcriptPath(projectDir: string, sessionId: string): string {
    return join(projectDir, `${sessionId}.jsonl`);
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Create a new session for the given working directory and model.
   * Writes a `.meta.json` file and returns the session metadata.
   */
  createSession(cwd: string, model: string): SessionInfo {
    const id = randomUUID();
    const now = new Date().toISOString();
    const info: SessionInfo = { id, cwd, model, createdAt: now, lastActiveAt: now };

    const projectDir = this.getProjectDir(cwd);
    // writeFileSync is used here to keep the implementation runtime-agnostic.
    // Bun supports all Node.js `fs` APIs, so this works in both environments.
    writeFileSync(this.metaPath(projectDir, id), JSON.stringify(info, null, 2));

    return info;
  }

  /**
   * Update the `lastActiveAt` timestamp for an existing session.
   * Silently does nothing if the session metadata file is not found.
   */
  touchSession(cwd: string, sessionId: string): void {
    const projectDir = this.getProjectDir(cwd);
    const path = this.metaPath(projectDir, sessionId);
    if (!existsSync(path)) return;

    try {
      const info: SessionInfo = JSON.parse(readFileSync(path, 'utf-8'));
      info.lastActiveAt = new Date().toISOString();
      writeFileSync(path, JSON.stringify(info, null, 2));
    } catch {
      // Ignore parse/write errors — the transcript is still valuable.
    }
  }

  /**
   * Append a single SDKMessage (or any JSON-serialisable value) to the session
   * transcript as a newline-terminated JSON line.
   */
  appendToTranscript(cwd: string, sessionId: string, message: unknown): void {
    const projectDir = this.getProjectDir(cwd);
    appendFileSync(
      this.transcriptPath(projectDir, sessionId),
      JSON.stringify(message) + '\n',
    );
  }

  /**
   * Read and parse every line from the session transcript.
   * Returns an empty array if the transcript file does not exist.
   */
  readTranscript(cwd: string, sessionId: string): unknown[] {
    const projectDir = this.getProjectDir(cwd);
    const path = this.transcriptPath(projectDir, sessionId);
    if (!existsSync(path)) return [];

    return readFileSync(path, 'utf-8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));
  }

  /**
   * List all sessions for the given CWD, sorted by most-recently-active first.
   */
  listSessions(cwd: string): SessionInfo[] {
    const projectDir = this.getProjectDir(cwd);
    if (!existsSync(projectDir)) return [];

    return readdirSync(projectDir)
      .filter((f) => f.endsWith('.meta.json'))
      .flatMap((f) => {
        try {
          return [JSON.parse(readFileSync(join(projectDir, f), 'utf-8')) as SessionInfo];
        } catch {
          return [];
        }
      })
      .sort(
        (a, b) =>
          new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime(),
      );
  }

  /**
   * Return the most recently active session for the given CWD, or `null` if
   * no sessions exist.
   */
  getLatestSession(cwd: string): SessionInfo | null {
    return this.listSessions(cwd)[0] ?? null;
  }

  /**
   * Return a single session by ID, or `null` if not found.
   */
  getSession(cwd: string, sessionId: string): SessionInfo | null {
    const projectDir = this.getProjectDir(cwd);
    const path = this.metaPath(projectDir, sessionId);
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, 'utf-8')) as SessionInfo;
    } catch {
      return null;
    }
  }
}
