import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { join, dirname } from 'path';

interface CheckpointEntry {
  toolUseId: string;
  filePath: string;
  originalContent: string | null; // null means file didn't exist
  timestamp: number;
}

interface StoredCheckpointEntry extends CheckpointEntry {
  checkpointFile: string;
}

type PathSnapshot =
  | { kind: 'missing' }
  | { kind: 'file'; content: string }
  | { kind: 'directory' };

export interface RewindTarget {
  filePath: string;
  originalContent: string | null;
}

/**
 * FileCheckpoint tracks file states before Write/Edit operations,
 * enabling rewind to any previous tool_use checkpoint.
 */
export class FileCheckpoint {
  private entries: StoredCheckpointEntry[] = [];
  private sessionDir: string;

  constructor(sessionDir: string) {
    this.sessionDir = join(sessionDir, 'checkpoints');
    mkdirSync(this.sessionDir, { recursive: true });
    this.loadFromDisk();
  }

  private loadFromDisk(): void {
    if (!existsSync(this.sessionDir)) return;
    const loaded: StoredCheckpointEntry[] = [];
    for (const file of readdirSync(this.sessionDir)) {
      if (!file.endsWith('.json')) continue;
      try {
        const checkpointFile = join(this.sessionDir, file);
        const entry = JSON.parse(readFileSync(checkpointFile, 'utf-8')) as CheckpointEntry;
        if (entry?.toolUseId && entry?.filePath && typeof entry.timestamp === 'number') {
          loaded.push({
            ...entry,
            checkpointFile,
          });
        }
      } catch {
        // Ignore malformed checkpoint files.
      }
    }
    loaded.sort((a, b) => a.timestamp - b.timestamp);
    this.entries = loaded;
  }

  /** Record the current state of a file before modification. */
  save(toolUseId: string, filePath: string): void {
    let originalContent: string | null = null;
    if (existsSync(filePath)) {
      originalContent = readFileSync(filePath, 'utf-8');
    }

    const timestamp = Date.now();
    const checkpointFile = join(
      this.sessionDir,
      `${toolUseId}-${timestamp}-${Math.random().toString(36).slice(2, 6)}.json`,
    );
    const entry: StoredCheckpointEntry = {
      toolUseId,
      filePath,
      originalContent,
      timestamp,
      checkpointFile,
    };

    this.entries.push(entry);

    // Also persist to disk
    writeFileSync(checkpointFile, JSON.stringify(entry), 'utf-8');
  }

  /** Rewind all files modified at or after the given toolUseId to their prior state. */
  rewindTo(toolUseId: string): { restored: string[]; errors: string[] } {
    const idx = this.entries.findIndex(e => e.toolUseId === toolUseId);
    if (idx === -1) {
      return { restored: [], errors: [`Checkpoint not found: ${toolUseId}`] };
    }

    const toRewind = this.entries.slice(idx).reverse();
    const restored: string[] = [];
    const errors: string[] = [];
    const rollbackSnapshots = new Map<string, PathSnapshot>();
    const touchedPaths: string[] = [];

    for (const entry of toRewind) {
      try {
        if (!rollbackSnapshots.has(entry.filePath)) {
          rollbackSnapshots.set(entry.filePath, snapshotPath(entry.filePath));
          touchedPaths.push(entry.filePath);
        }
        restoreCheckpointTarget(entry.filePath, entry.originalContent);
        restored.push(entry.filePath);
      } catch (err: unknown) {
        errors.push(`Failed to restore ${entry.filePath}: ${err instanceof Error ? err.message : String(err)}`);
        const rollbackErrors = this.rollbackRewind(touchedPaths, rollbackSnapshots);
        return {
          restored: [],
          errors: [...errors, ...rollbackErrors],
        };
      }
    }

    for (const entry of this.entries.slice(idx)) {
      try {
        unlinkSync(entry.checkpointFile);
      } catch {
        // Ignore checkpoint cleanup failures after a successful restore.
      }
    }

    // Remove rewound entries from memory only after the restore commits.
    this.entries = this.entries.slice(0, idx);

    return { restored, errors };
  }

  /** List all checkpoints. */
  list(): { toolUseId: string; filePath: string; timestamp: number }[] {
    return this.entries.map(e => ({
      toolUseId: e.toolUseId,
      filePath: e.filePath,
      timestamp: e.timestamp,
    }));
  }

  /**
   * Return the per-file target state when rewinding from a given toolUseId.
   * If the checkpoint is missing, returns null.
   */
  getRewindTargets(toolUseId: string): RewindTarget[] | null {
    const idx = this.entries.findIndex(e => e.toolUseId === toolUseId);
    if (idx === -1) return null;
    const targets = new Map<string, string | null>();
    for (const entry of this.entries.slice(idx)) {
      // The earliest checkpoint in the rewind slice determines the final file state.
      if (!targets.has(entry.filePath)) {
        targets.set(entry.filePath, entry.originalContent);
      }
    }
    return [...targets.entries()].map(([filePath, originalContent]) => ({
      filePath,
      originalContent,
    }));
  }

  private rollbackRewind(
    touchedPaths: string[],
    snapshots: Map<string, PathSnapshot>,
  ): string[] {
    const errors: string[] = [];
    for (const filePath of [...touchedPaths].reverse()) {
      const snapshot = snapshots.get(filePath);
      if (!snapshot) continue;
      try {
        restorePathSnapshot(filePath, snapshot);
      } catch (err: unknown) {
        errors.push(
          `Failed to roll back ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return errors;
  }
}

function restoreCheckpointTarget(filePath: string, originalContent: string | null): void {
  if (originalContent === null) {
    if (existsSync(filePath)) {
      rmSync(filePath, { recursive: true, force: true });
    }
    return;
  }

  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, originalContent, 'utf-8');
}

function snapshotPath(filePath: string): PathSnapshot {
  if (!existsSync(filePath)) {
    return { kind: 'missing' };
  }

  const stat = lstatSync(filePath);
  if (stat.isDirectory()) {
    return { kind: 'directory' };
  }

  return {
    kind: 'file',
    content: readFileSync(filePath, 'utf-8'),
  };
}

function restorePathSnapshot(filePath: string, snapshot: PathSnapshot): void {
  if (snapshot.kind === 'missing') {
    if (existsSync(filePath)) {
      rmSync(filePath, { recursive: true, force: true });
    }
    return;
  }

  if (snapshot.kind === 'directory') {
    if (existsSync(filePath)) {
      const stat = lstatSync(filePath);
      if (stat.isDirectory()) {
        return;
      }
      rmSync(filePath, { recursive: true, force: true });
    }
    mkdirSync(filePath, { recursive: true });
    return;
  }

  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, snapshot.content, 'utf-8');
}
