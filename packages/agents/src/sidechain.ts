import { join, dirname } from 'node:path';
import { mkdir, appendFile } from 'node:fs/promises';

/**
 * Returns the canonical sidechain JSONL path for a given agent.
 * Structure: <root>/sidechain/<agentId>/messages.jsonl
 */
export function sidechainPath(root: string, agentId: string): string {
  return join(root, 'sidechain', agentId, 'messages.jsonl');
}

/**
 * Appends JSONL records to a sidechain file, creating the directory on first use.
 * Each call to `append` serialises `record` as a single JSON line.
 */
export class SidechainWriter {
  /** Tracks whether the parent directory has been created already. */
  private ensured = false;

  constructor(private readonly path: string) {}

  async append(record: unknown): Promise<void> {
    if (!this.ensured) {
      await mkdir(dirname(this.path), { recursive: true });
      this.ensured = true;
    }
    await appendFile(this.path, JSON.stringify(record) + '\n', 'utf8');
  }
}
