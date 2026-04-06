/**
 * Session mutation APIs — rename, tag, fork.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';

function getSessionDir(projectDir?: string): string {
  if (projectDir) {
    const crypto = require('crypto');
    const hash = crypto.createHash('sha256').update(projectDir).digest('hex');
    return join(homedir(), '.claude', 'projects', hash, 'sessions');
  }
  return join(homedir(), '.claude', 'sessions');
}

function getSessionPath(sessionId: string, projectDir?: string): string {
  return join(getSessionDir(projectDir), `${sessionId}.jsonl`);
}

function appendToSession(sessionId: string, entry: unknown, projectDir?: string): void {
  const path = getSessionPath(sessionId, projectDir);
  mkdirSync(dirname(path), { recursive: true });
  const line = JSON.stringify(entry) + '\n';
  writeFileSync(path, line, { flag: 'a' });
}

/**
 * Rename a session by appending a custom-title entry.
 */
export function renameSession(sessionId: string, title: string, opts?: { dir?: string }): void {
  appendToSession(sessionId, {
    type: 'custom-title',
    title,
    timestamp: new Date().toISOString(),
  }, opts?.dir);
}

/**
 * Tag a session. Pass null to clear.
 */
export function tagSession(sessionId: string, tag: string | null, opts?: { dir?: string }): void {
  appendToSession(sessionId, {
    type: 'tag',
    tag,
    timestamp: new Date().toISOString(),
  }, opts?.dir);
}

/**
 * Fork a session into a new branch.
 */
export function forkSession(
  sessionId: string,
  opts?: { dir?: string; upToMessageId?: string; title?: string },
): { sessionId: string } {
  const sourcePath = getSessionPath(sessionId, opts?.dir);
  let lines: string[];
  try {
    lines = readFileSync(sourcePath, 'utf-8').split('\n').filter(Boolean);
  } catch {
    throw new Error(`Session not found: ${sessionId}`);
  }

  const newSessionId = randomUUID();
  const uuidMap = new Map<string, string>();

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);

      // Remap UUIDs
      if (entry.uuid) {
        const newUuid = randomUUID();
        uuidMap.set(entry.uuid, newUuid);
        entry.uuid = newUuid;
      }
      if (entry.parentUuid && uuidMap.has(entry.parentUuid)) {
        entry.parentUuid = uuidMap.get(entry.parentUuid);
      }

      // Update session ID
      entry.sessionId = newSessionId;

      appendToSession(newSessionId, entry, opts?.dir);

      // Stop at the specified message
      if (opts?.upToMessageId && entry.uuid === uuidMap.get(opts.upToMessageId)) {
        break;
      }
    } catch {
      // Skip corrupted lines
    }
  }

  if (opts?.title) {
    renameSession(newSessionId, opts.title, { dir: opts.dir });
  }

  return { sessionId: newSessionId };
}
