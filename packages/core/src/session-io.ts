import { createHash } from 'node:crypto';
import { join } from 'node:path';

export function projectHash(cwd: string): string {
  return createHash('sha256').update(cwd).digest('hex');
}

export function resolveSessionPath(root: string, cwd: string, sessionId: string): string {
  return join(root, 'projects', projectHash(cwd), 'sessions', `${sessionId}.jsonl`);
}
