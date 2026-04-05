import { readFile, writeFile, access } from 'node:fs/promises';

export interface FileSnapshot {
  sessionId: string;
  messageUuid: string;
  filePath: string;
  prevContent: string | null; // null if the file didn't exist before
  timestamp: number;
}

/**
 * Persistence adapter called when a new snapshot is captured.
 * The implementation is responsible for durable storage (e.g. appending to
 * the session JSONL transcript).  Wire via `FileHistoryStore.setPersistence`.
 */
export interface FileHistoryPersistence {
  /** Called synchronously after each new snapshot is pushed to the in-memory store. */
  onSnapshotCreated?: (snap: FileSnapshot) => void | Promise<void>;
}

const MAX_SNAPSHOTS_PER_SESSION = 100;

export class FileHistoryStore {
  private snapshotsBySession = new Map<string, FileSnapshot[]>();
  private persistence?: FileHistoryPersistence;

  /**
   * Wire a persistence adapter.  Called by SessionManager (or ConversationLoop)
   * during session setup.  Pass `undefined` to remove an existing adapter.
   */
  setPersistence(persistence: FileHistoryPersistence | undefined): void {
    this.persistence = persistence;
  }

  /**
   * Rehydrate snapshots from persisted records (e.g. read from session JSONL
   * on resume).  Does NOT fire the persistence hook to avoid duplicate writes.
   */
  hydrate(sessionId: string, snapshots: FileSnapshot[]): void {
    this.snapshotsBySession.set(sessionId, [...snapshots]);
  }

  /**
   * Capture current file content (if any) as a snapshot, then return.
   * Called BEFORE the tool writes. If the file doesn't exist yet, stores prevContent=null.
   * If prevContent would be identical to the last snapshot's for this file in the same turn, skip.
   */
  async trackEdit(sessionId: string, messageUuid: string, filePath: string): Promise<void> {
    let prevContent: string | null = null;
    try {
      await access(filePath);
      prevContent = await readFile(filePath, 'utf8');
    } catch {
      // File doesn't exist — prevContent stays null
    }

    // Dedup: skip if the last snapshot for this file in the same turn has identical content.
    const list = this.snapshotsBySession.get(sessionId);
    if (list) {
      for (let i = list.length - 1; i >= 0; i--) {
        const existing = list[i]!;
        if (existing.messageUuid !== messageUuid) break;
        if (existing.filePath === filePath && existing.prevContent === prevContent) {
          return; // identical snapshot for same file/turn — skip
        }
      }
    }

    const snap: FileSnapshot = {
      sessionId,
      messageUuid,
      filePath,
      prevContent,
      timestamp: Date.now(),
    };

    let snapList = this.snapshotsBySession.get(sessionId);
    if (!snapList) {
      snapList = [];
      this.snapshotsBySession.set(sessionId, snapList);
    }
    snapList.push(snap);
    // FIFO eviction
    if (snapList.length > MAX_SNAPSHOTS_PER_SESSION) {
      snapList.splice(0, snapList.length - MAX_SNAPSHOTS_PER_SESSION);
    }

    // Notify persistence adapter so the snapshot can be durably stored.
    if (this.persistence?.onSnapshotCreated) {
      await Promise.resolve(this.persistence.onSnapshotCreated(snap));
    }
  }

  /** Return all snapshots for a session, oldest first. */
  list(sessionId: string): ReadonlyArray<FileSnapshot> {
    return this.snapshotsBySession.get(sessionId) ?? [];
  }

  /**
   * Rewind by N turns. Each "turn" is one messageUuid. Collects all snapshots
   * whose messageUuid is in the last N unique uuids, and restores them in reverse order
   * (most recent first). Returns the list of restored file paths.
   */
  async rewind(sessionId: string, turns: number): Promise<string[]> {
    const list = this.snapshotsBySession.get(sessionId);
    if (!list || list.length === 0) return [];
    if (turns <= 0) return [];

    // Collect unique messageUuids in order (scanning from newest), find the last N
    const seenUuids: string[] = [];
    for (let i = list.length - 1; i >= 0; i--) {
      const uuid = list[i]!.messageUuid;
      if (!seenUuids.includes(uuid)) {
        seenUuids.push(uuid);
        if (seenUuids.length >= turns) break;
      }
    }
    const uuidsToRestore = new Set(seenUuids);

    // For each file, find its OLDEST snapshot in the uuidsToRestore set
    // (oldest prevContent represents the state BEFORE the first edit in those turns)
    const oldestByFile = new Map<string, FileSnapshot>();
    for (const snap of list) {
      if (!uuidsToRestore.has(snap.messageUuid)) continue;
      if (!oldestByFile.has(snap.filePath)) {
        oldestByFile.set(snap.filePath, snap);
      }
    }

    // Restore each file
    const restored: string[] = [];
    for (const [filePath, snap] of oldestByFile) {
      if (snap.prevContent === null) {
        // File didn't exist before — delete it (if it exists now)
        try {
          const { unlink } = await import('node:fs/promises');
          await unlink(filePath);
          restored.push(filePath);
        } catch {
          // Already gone — still counts as restored
          restored.push(filePath);
        }
      } else {
        await writeFile(filePath, snap.prevContent, 'utf8');
        restored.push(filePath);
      }
    }

    // Remove the rewound snapshots from the store so subsequent rewinds don't loop
    this.snapshotsBySession.set(
      sessionId,
      list.filter((s) => !uuidsToRestore.has(s.messageUuid)),
    );

    return restored;
  }

  /** Clear all snapshots for a session (e.g. on /clear). */
  clear(sessionId: string): void {
    this.snapshotsBySession.delete(sessionId);
  }

  /** Global singleton for simple callers that don't want to thread the store. */
  static default = new FileHistoryStore();
}

/** Convenience export — the default global store. */
export const fileHistory = FileHistoryStore.default;
