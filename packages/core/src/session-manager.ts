import { createHash, randomUUID } from 'crypto';
import {
  existsSync,
  mkdirSync,
  appendFileSync,
  readFileSync,
  readdirSync,
  realpathSync,
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
 *   <project-key>/
 *     <session-id>.meta.json   — session metadata
 *     <session-id>.jsonl       — newline-delimited JSON transcript
 *
 * `<project-key>` uses a hashed cwd key to avoid collisions between paths such
 * as `/a-b/c` and `/a/b-c`.  Legacy safe-path directories are still read as a
 * fallback for backwards compatibility.
 */
export class SessionManager {
  private baseDir: string;

  constructor() {
    this.baseDir = join(homedir(), '.open-agent', 'projects');
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private normalizeCwd(cwd: string): string {
    try {
      return realpathSync(cwd);
    } catch {
      return cwd;
    }
  }

  private getLegacyProjectKey(cwd: string): string {
    return cwd.replace(/\//g, '-').replace(/^-/, '');
  }

  private getHashedProjectKey(cwd: string): string {
    const normalized = this.normalizeCwd(cwd);
    const digest = createHash('sha256').update(normalized).digest('hex');
    return `v2-${digest.slice(0, 32)}`;
  }

  private getProjectDirForKey(projectKey: string, ensureExists = false): string {
    const dir = join(this.baseDir, projectKey);
    if (ensureExists && !existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  private getProjectDir(cwd: string): string {
    return this.getProjectDirForKey(this.getHashedProjectKey(cwd), true);
  }

  private getProjectDirsForLookup(cwd: string): string[] {
    const hashedDir = this.getProjectDirForKey(this.getHashedProjectKey(cwd), false);
    const legacyDir = this.getProjectDirForKey(this.getLegacyProjectKey(cwd), false);
    return hashedDir === legacyDir ? [hashedDir] : [hashedDir, legacyDir];
  }

  private resolveSessionProjectDir(cwd: string, sessionId: string): string {
    for (const dir of this.getProjectDirsForLookup(cwd)) {
      if (
        existsSync(this.metaPath(dir, sessionId)) ||
        existsSync(this.transcriptPath(dir, sessionId))
      ) {
        return dir;
      }
    }
    return this.getProjectDir(cwd);
  }

  private findMetaPathInCwd(cwd: string, sessionId: string): string | null {
    for (const dir of this.getProjectDirsForLookup(cwd)) {
      const path = this.metaPath(dir, sessionId);
      if (existsSync(path)) return path;
    }
    return null;
  }

  private findTranscriptPathInCwd(cwd: string, sessionId: string): string | null {
    for (const dir of this.getProjectDirsForLookup(cwd)) {
      const path = this.transcriptPath(dir, sessionId);
      if (existsSync(path)) return path;
    }
    return null;
  }

  private readSessionInfoFromCwd(cwd: string, sessionId: string): SessionInfo | null {
    const path = this.findMetaPathInCwd(cwd, sessionId);
    if (!path) return null;
    try {
      return JSON.parse(readFileSync(path, 'utf-8')) as SessionInfo;
    } catch {
      return null;
    }
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
    const session = this.getSession(cwd, sessionId);
    if (!session) return;
    const path = this.findMetaPathInCwd(session.cwd ?? cwd, sessionId);
    if (!path) return;

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
    const projectDir = this.resolveSessionProjectDir(cwd, sessionId);
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
    const path = this.findTranscriptPathInCwd(cwd, sessionId);
    if (!path) return [];

    const lines = readFileSync(path, 'utf-8')
      .split('\n')
      .filter((line) => line.trim().length > 0);
    const parsed: unknown[] = [];
    for (const line of lines) {
      try {
        parsed.push(JSON.parse(line));
      } catch {
        // Skip malformed lines so one bad record does not invalidate resume.
      }
    }
    return parsed;
  }

  private toConversationMessages(raw: SDKMessage[]): Message[] {
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

  private truncateRawTranscriptAtAssistant(
    raw: SDKMessage[],
    assistantMessageUuid: string,
  ): { entries: SDKMessage[]; found: boolean } {
    const entries: SDKMessage[] = [];
    for (const entry of raw) {
      entries.push(entry);
      if (entry.type === 'assistant' && entry.uuid === assistantMessageUuid) {
        return { entries, found: true };
      }
    }
    return { entries: [], found: false };
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
    return this.toConversationMessages(raw);
  }

  /**
   * Load transcript up to and including a specific assistant message UUID.
   * Returns `found=false` when the assistant message does not exist.
   */
  loadTranscriptUpToAssistant(
    cwd: string,
    sessionId: string,
    assistantMessageUuid: string,
  ): { messages: Message[]; found: boolean } {
    const raw = this.readTranscript(cwd, sessionId) as SDKMessage[];
    const { entries, found } = this.truncateRawTranscriptAtAssistant(raw, assistantMessageUuid);
    if (!found) return { messages: [], found: false };
    return { messages: this.toConversationMessages(entries), found: true };
  }

  /**
   * List all sessions for the given CWD, sorted by most-recently-active first.
   */
  listSessions(cwd: string): SessionInfo[] {
    const merged = new Map<string, SessionInfo>();

    for (const projectDir of this.getProjectDirsForLookup(cwd)) {
      if (!existsSync(projectDir)) continue;
      for (const fileName of readdirSync(projectDir).filter((f) => f.endsWith('.meta.json'))) {
        try {
          const info = JSON.parse(readFileSync(join(projectDir, fileName), 'utf-8')) as SessionInfo;
          const current = merged.get(info.id);
          if (!current) {
            merged.set(info.id, info);
            continue;
          }
          if (new Date(info.lastActiveAt).getTime() > new Date(current.lastActiveAt).getTime()) {
            merged.set(info.id, info);
          }
        } catch {
          // Skip malformed metadata files.
        }
      }
    }

    return [...merged.values()]
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
    const dir = join(this.resolveSessionProjectDir(cwd, sessionId), sessionId);
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
    const local = this.readSessionInfoFromCwd(cwd, sessionId);
    if (local) return local;

    // Fall back to global index — the session may have been created from a different CWD.
    const originalCwd = this.lookupGlobalIndex(sessionId);
    if (originalCwd && originalCwd !== cwd) {
      return this.readSessionInfoFromCwd(originalCwd, sessionId);
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

  /**
   * Cross-CWD variant of `loadTranscriptUpToAssistant`.
   */
  loadTranscriptAnyCwdUpToAssistant(
    sessionId: string,
    preferredCwd: string,
    assistantMessageUuid: string,
  ): { messages: Message[]; found: boolean } {
    const preferred = this.loadTranscriptUpToAssistant(preferredCwd, sessionId, assistantMessageUuid);
    if (preferred.found) return preferred;

    const originalCwd = this.lookupGlobalIndex(sessionId);
    if (originalCwd && originalCwd !== preferredCwd) {
      return this.loadTranscriptUpToAssistant(originalCwd, sessionId, assistantMessageUuid);
    }

    return { messages: [], found: false };
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
