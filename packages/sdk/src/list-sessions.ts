import { SessionManager } from '@open-agent/core';
import type { SessionInfo } from '@open-agent/core';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { ListSessionsOptions, SessionSummary } from './types.js';

function toSummary(sm: SessionManager, session: SessionInfo): SessionSummary {
  let transcript: unknown[] = [];
  try {
    transcript = sm.readTranscript(session.cwd, session.id);
  } catch {
    transcript = [];
  }

  const firstPrompt = transcript.find((entry) => {
    const e = entry as any;
    return e?.type === 'user' && typeof e?.message?.content === 'string';
  }) as any;

  const summaryText = typeof firstPrompt?.message?.content === 'string'
    ? firstPrompt.message.content
    : `Session ${session.id.slice(0, 8)}`;

  const fileSize = Buffer.byteLength(JSON.stringify(transcript), 'utf-8');
  return {
    sessionId: session.id,
    summary: summaryText.slice(0, 200),
    lastModified: new Date(session.lastActiveAt).getTime(),
    messageCount: transcript.length,
    fileSize,
    cwd: session.cwd,
  };
}

function listAllSessionMetas(): SessionInfo[] {
  const baseDir = join(homedir(), '.open-agent', 'projects');
  if (!existsSync(baseDir)) return [];

  const out: SessionInfo[] = [];
  for (const projectDir of readdirSync(baseDir, { withFileTypes: true })) {
    if (!projectDir.isDirectory()) continue;
    const absProjectDir = join(baseDir, projectDir.name);
    for (const f of readdirSync(absProjectDir)) {
      if (!f.endsWith('.meta.json')) continue;
      try {
        const meta = JSON.parse(readFileSync(join(absProjectDir, f), 'utf-8')) as SessionInfo;
        if (meta?.id && meta?.cwd) out.push(meta);
      } catch {
        // Skip malformed metadata entries.
      }
    }
  }
  return out;
}

/**
 * Official-compatible session listing:
 * - listSessions()
 * - listSessions({ dir, limit })
 * Also accepts the legacy `listSessions(cwd)` signature for backwards compatibility.
 */
export async function listSessions(
  optionsOrDir?: ListSessionsOptions | string,
): Promise<SessionSummary[]> {
  const sm = new SessionManager();
  const options: ListSessionsOptions =
    typeof optionsOrDir === 'string'
      ? { dir: optionsOrDir }
      : (optionsOrDir ?? {});

  const raw = options.dir
    ? sm.listSessions(options.dir)
    : listAllSessionMetas().sort(
      (a, b) => new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime(),
    );

  const summaries = raw.map((s) => toSummary(sm, s));
  return options.limit !== undefined ? summaries.slice(0, options.limit) : summaries;
}
