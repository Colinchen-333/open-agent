import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from 'fs';
import { join, dirname } from 'path';

interface CheckpointEntry {
  toolUseId: string;
  filePath: string;
  originalContent: string | null; // null means file didn't exist
  timestamp: number;
}

export interface RewindTarget {
  filePath: string;
  originalContent: string | null;
}

/**
 * FileCheckpoint tracks file states before Write/Edit operations,
 * enabling rewind to any previous tool_use checkpoint.
 */
export class FileCheckpoint {
  private entries: CheckpointEntry[] = [];
  private sessionDir: string;

  constructor(sessionDir: string) {
    this.sessionDir = join(sessionDir, 'checkpoints');
    mkdirSync(this.sessionDir, { recursive: true });
    this.loadFromDisk();
  }

  private loadFromDisk(): void {
    if (!existsSync(this.sessionDir)) return;
    const loaded: CheckpointEntry[] = [];
    for (const file of readdirSync(this.sessionDir)) {
      if (!file.endsWith('.json')) continue;
      try {
        const entry = JSON.parse(readFileSync(join(this.sessionDir, file), 'utf-8')) as CheckpointEntry;
        if (entry?.toolUseId && entry?.filePath && typeof entry.timestamp === 'number') {
          loaded.push(entry);
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

    const entry: CheckpointEntry = {
      toolUseId,
      filePath,
      originalContent,
      timestamp: Date.now(),
    };

    this.entries.push(entry);

    // Also persist to disk
    const checkpointFile = join(this.sessionDir, `${toolUseId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`);
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

    for (const entry of toRewind) {
      try {
        if (entry.originalContent === null) {
          // File didn't exist before - remove it
          if (existsSync(entry.filePath)) {
            unlinkSync(entry.filePath);
          }
        } else {
          mkdirSync(dirname(entry.filePath), { recursive: true });
          writeFileSync(entry.filePath, entry.originalContent, 'utf-8');
        }
        restored.push(entry.filePath);
      } catch (err: unknown) {
        errors.push(`Failed to restore ${entry.filePath}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Remove rewound entries
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
}
