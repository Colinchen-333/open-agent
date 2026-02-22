import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';

interface CheckpointEntry {
  toolUseId: string;
  filePath: string;
  originalContent: string | null; // null means file didn't exist
  timestamp: number;
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
    const checkpointFile = join(this.sessionDir, `${toolUseId}-${Date.now()}.json`);
    writeFileSync(checkpointFile, JSON.stringify(entry), 'utf-8');
  }

  /** Rewind all files modified after the given toolUseId to their prior state. */
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
}
