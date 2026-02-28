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
import type { SDKMessage } from './types.js';
import type { Message } from '@open-agent/providers';

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

    // Update global session index for cross-CWD resume support.
    this.updateGlobalIndex(id, cwd);

    return info;
  }

  /**
   * Ensure a specific session id has metadata on disk.
   * If it already exists, updates `lastActiveAt`; otherwise creates it.
   */
  ensureSession(cwd: string, sessionId: string, model: string): SessionInfo {
    const existing = this.getSession(cwd, sessionId);
    if (existing) {
      this.touchSession(cwd, sessionId);
      return this.getSession(cwd, sessionId) ?? existing;
    }

    const now = new Date().toISOString();
    const info: SessionInfo = {
      id: sessionId,
      cwd,
      model,
      createdAt: now,
      lastActiveAt: now,
    };
    const projectDir = this.getProjectDir(cwd);
    writeFileSync(this.metaPath(projectDir, sessionId), JSON.stringify(info, null, 2));
    this.updateGlobalIndex(sessionId, cwd);
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
   * Read the transcript for a session and reconstruct conversation history as
   * provider-compatible `Message` objects suitable for passing as `initialMessages`
   * to `ConversationLoop`.
   *
   * Only 'user' and 'assistant' SDKMessages are included — stream_event,
   * tool_result, result, and system messages are skipped because they are
   * informational records, not conversation turns.
   *
   * For assistant messages the content blocks (text, thinking, tool_use) are
   * pulled from `message.message.content`.  For user messages the raw string
   * prompt is used when `message.message.content` is a string, or the content
   * block array otherwise.
   */
  loadTranscript(cwd: string, sessionId: string): Message[] {
    const raw = this.readTranscript(cwd, sessionId) as SDKMessage[];
    const messages: Message[] = [];

    for (const entry of raw) {
      // Skip transient messages (e.g. "Continue." prompts) to avoid replaying them on resume.
      if ((entry as any)._transient === true) continue;

      if (entry.type === 'user') {
        const content = (entry as any).message?.content;
        if (content === undefined || content === null) continue;
        messages.push({ role: 'user', content });
      } else if (entry.type === 'assistant') {
        const content = (entry as any).message?.content;
        if (!content) continue;

        // JSON.parse produces plain objects; ensure content blocks are valid
        // before handing them back to the provider layer.
        const normalised = Array.isArray(content)
          ? content
              .filter((block: unknown): block is Record<string, unknown> =>
                block !== null && typeof block === 'object',
              )
              .map((block: Record<string, unknown>) => {
                // tool_use blocks may have their `input` field stored as a
                // JSON string (e.g. when the transcript was written from a
                // partially-assembled stream).  Parse it back to an object.
                if (block['type'] === 'tool_use' && typeof block['input'] === 'string') {
                  try {
                    return { ...block, input: JSON.parse(block['input'] as string) };
                  } catch {
                    // Malformed JSON — keep original string to avoid silent data loss.
                    return block;
                  }
                }
                return block;
              })
          : content;

        // Reconstruct a proper assistant Message with content blocks.
        messages.push({ role: 'assistant', content: normalised });
      }
      // Reconstruct tool_result user messages from transcript entries.
      // When the LLM uses tools, the conversation loop appends tool_result
      // blocks as a user message.  These must be restored for the conversation
      // to remain coherent on resume (the model expects tool results after
      // tool_use blocks).
      if (entry.type === 'tool_result') {
        const toolUseId = (entry as any).tool_use_id;
        // Prefer the full result content (persisted as _fullResult) over the
        // 500-char display preview so resumed sessions get the complete context.
        const result = (entry as any)._fullResult ?? (entry as any).result ?? '';
        const isError = (entry as any).is_error === true;

        // Check if the previous message is already a user message with
        // tool_result content blocks — if so, append to it; otherwise
        // create a new user message.
        const lastMsg = messages[messages.length - 1];
        const toolResultBlock = {
          type: 'tool_result' as const,
          tool_use_id: toolUseId,
          content: typeof result === 'string' ? result : JSON.stringify(result),
          ...(isError ? { is_error: true } : {}),
        };

        if (
          lastMsg?.role === 'user' &&
          Array.isArray(lastMsg.content) &&
          lastMsg.content.length > 0 &&
          (lastMsg.content[0] as any)?.type === 'tool_result'
        ) {
          // Append to existing tool_result user message
          (lastMsg.content as any[]).push(toolResultBlock);
        } else {
          // Create a new user message with tool_result content
          messages.push({ role: 'user', content: [toolResultBlock] as any });
        }
      }
      // stream_event, result, system messages are skipped (informational only).
    }

    return messages;
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
   * Return the on-disk project directory for the given CWD.
   * Useful for callers that need to store session-scoped artefacts (e.g.
   * checkpoints) alongside the session metadata and transcript files.
   */
  getSessionDir(cwd: string, sessionId: string): string {
    const dir = join(this.getProjectDir(cwd), sessionId);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  /**
   * Return a single session by ID, or `null` if not found.
   * Falls back to the global index for cross-CWD lookup when
   * the session is not found in the specified CWD's project directory.
   */
  getSession(cwd: string, sessionId: string): SessionInfo | null {
    const projectDir = this.getProjectDir(cwd);
    const path = this.metaPath(projectDir, sessionId);
    if (existsSync(path)) {
      try {
        return JSON.parse(readFileSync(path, 'utf-8')) as SessionInfo;
      } catch {
        return null;
      }
    }

    // Fall back to global index — the session may have been created from a different CWD.
    const originalCwd = this.lookupGlobalIndex(sessionId);
    if (originalCwd && originalCwd !== cwd) {
      const altProjectDir = this.getProjectDir(originalCwd);
      const altPath = this.metaPath(altProjectDir, sessionId);
      if (existsSync(altPath)) {
        try {
          return JSON.parse(readFileSync(altPath, 'utf-8')) as SessionInfo;
        } catch {
          return null;
        }
      }
    }

    return null;
  }

  /**
   * Load a transcript, with cross-CWD fallback via global index.
   * If the session isn't found under the given CWD, checks the global
   * index for the original CWD and loads from there.
   */
  loadTranscriptAnyCwd(sessionId: string, preferredCwd: string): Message[] {
    // Try preferred CWD first
    const transcript = this.loadTranscript(preferredCwd, sessionId);
    if (transcript.length > 0) return transcript;

    // Fall back to global index
    const originalCwd = this.lookupGlobalIndex(sessionId);
    if (originalCwd && originalCwd !== preferredCwd) {
      return this.loadTranscript(originalCwd, sessionId);
    }

    return [];
  }

  // ---------------------------------------------------------------------------
  // Global session index — maps sessionId → original CWD for cross-dir resume
  // ---------------------------------------------------------------------------

  private get globalIndexPath(): string {
    return join(this.baseDir, 'sessions-index.json');
  }

  private updateGlobalIndex(sessionId: string, cwd: string): void {
    try {
      let index: Record<string, string> = {};
      if (existsSync(this.globalIndexPath)) {
        index = JSON.parse(readFileSync(this.globalIndexPath, 'utf-8'));
      }
      index[sessionId] = cwd;
      writeFileSync(this.globalIndexPath, JSON.stringify(index));
    } catch {
      // Non-fatal — index is an optimization, not critical.
    }
  }

  private lookupGlobalIndex(sessionId: string): string | null {
    try {
      if (!existsSync(this.globalIndexPath)) return null;
      const index = JSON.parse(readFileSync(this.globalIndexPath, 'utf-8'));
      return index[sessionId] ?? null;
    } catch {
      return null;
    }
  }
}
