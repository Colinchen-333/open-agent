import type { SessionInfo } from './session-manager.js';

export interface SessionSearchQuery {
  /** Free-text search — matches title, summary, createdFromPrompt, or first user message. */
  text?: string;
  /** Filter to sessions created at/after this timestamp (ms). */
  sinceTimestamp?: number;
  /** Filter to sessions that touched any of these file paths (requires transcript scan). */
  touchedFiles?: string[];
  /** Max results to return. */
  limit?: number;
}

export interface SessionSearchResult {
  sessionId: string;
  title?: string;
  cwd: string;
  createdAt?: number;
  lastActiveAt?: number;
  score: number;
  /** True when the session's cwd differs from the caller's current working directory. */
  crossProject: boolean;
}

/**
 * Extract a millisecond timestamp from a field that may be a number (ms),
 * an ISO date string, or absent.  Returns 0 when the value cannot be parsed.
 */
function toMs(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const n = Date.parse(value);
    return Number.isNaN(n) ? 0 : n;
  }
  return 0;
}

/**
 * Rank a list of sessions against a search query using simple keyword overlap.
 * Returns results sorted by score descending.
 *
 * For each session:
 *   - Tokenize the query `text` (lowercase, split on whitespace, drop short words)
 *   - Count matches in title + summary + createdFromPrompt
 *   - Score = matches / queryTokens.length (0..1)
 *   - Add recency bonus: +0.1 if lastActiveAt within 24h
 */
export function searchSessions(
  sessions: ReadonlyArray<SessionInfo>,
  query: SessionSearchQuery,
  currentCwd: string,
): SessionSearchResult[] {
  const textTokens = query.text
    ? query.text
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 2)
    : [];

  const now = Date.now();
  const results: SessionSearchResult[] = [];

  for (const s of sessions) {
    const createdAtMs = toMs(s.createdAt);
    const lastActiveAtMs = toMs(s.lastActiveAt);

    // Filter: sinceTimestamp
    if (query.sinceTimestamp !== undefined && createdAtMs < query.sinceTimestamp) {
      continue;
    }

    // Score: text match
    let score = 0;
    if (textTokens.length > 0) {
      const haystack = [s.title ?? '', s.summary ?? '', s.createdFromPrompt ?? '']
        .join(' ')
        .toLowerCase();
      let matched = 0;
      for (const t of textTokens) {
        if (haystack.includes(t)) matched++;
      }
      score = matched / textTokens.length;
    } else {
      // No query text — all sessions get a middling default score
      score = 0.5;
    }

    // Recency bonus: +0.1 if lastActiveAt is within the last 24 hours
    if (lastActiveAtMs > 0 && now - lastActiveAtMs < 24 * 60 * 60 * 1000) {
      score += 0.1;
    }

    // Skip zero-score hits when a text query was provided
    if (textTokens.length > 0 && score === 0) continue;

    results.push({
      sessionId: s.id,
      title: s.title,
      cwd: s.cwd,
      createdAt: createdAtMs > 0 ? createdAtMs : undefined,
      lastActiveAt: lastActiveAtMs > 0 ? lastActiveAtMs : undefined,
      score,
      crossProject: s.cwd !== currentCwd,
    });
  }

  results.sort((a, b) => b.score - a.score);
  return query.limit ? results.slice(0, query.limit) : results;
}

/**
 * Build a cross-project resume hint: if the best-matching result is in a
 * different cwd, return an actionable instruction for the user.
 * Returns null if the result is in the same project.
 */
export function buildCrossProjectResumeHint(
  result: SessionSearchResult,
  currentCwd: string,
): string | null {
  if (!result.crossProject) return null;
  return (
    `Session ${result.sessionId} is in a different project (${result.cwd}). ` +
    `Resume it from that directory: cd ${JSON.stringify(result.cwd)} && open-agent --resume ${result.sessionId}`
  );
}
