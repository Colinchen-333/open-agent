import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { mkdir, appendFile, readFile } from 'node:fs/promises';

export function projectHash(cwd: string): string {
  return createHash('sha256').update(cwd).digest('hex');
}

export function resolveSessionPath(root: string, cwd: string, sessionId: string): string {
  return join(root, 'projects', projectHash(cwd), 'sessions', `${sessionId}.jsonl`);
}

export async function readJsonlSession(path: string): Promise<unknown[]> {
  let content: string;
  try {
    content = await readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  const out: unknown[] = [];
  for (const line of content.split('\n')) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // partial/truncated trailing line — stop reading
      break;
    }
  }
  return out;
}

export class SessionJsonlWriter {
  private ensured = false;
  constructor(private readonly path: string) {}

  async append(record: unknown): Promise<void> {
    if (!this.ensured) {
      await mkdir(dirname(this.path), { recursive: true });
      this.ensured = true;
    }
    await appendFile(this.path, JSON.stringify(record) + '\n', 'utf8');
  }

  async close(): Promise<void> {
    // no-op for now; placeholder for future buffered implementations
  }
}
