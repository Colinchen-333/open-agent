/**
 * Context-collapse tracking for conversation compaction.
 * Records what was collapsed, provides health stats, and
 * persists commit/snapshot entries for session resume.
 */

export interface ContextCollapseCommit {
  /** Unique ID for this collapse */
  id: string;
  /** Summary text produced by the compactor */
  summary: string;
  /** Number of messages that were collapsed */
  messageCount: number;
  /** Estimated tokens saved */
  tokensSaved: number;
  /** ISO timestamp when collapse happened */
  timestamp: string;
  /** UUID of the message that triggered the collapse (the last user message before compact) */
  triggeredByUuid?: string;
}

export interface ContextCollapseSnapshot {
  /** Commits pending write (staged queue) */
  staged: ContextCollapseCommit[];
  /** Current health state */
  health: CollapseHealth;
}

export interface CollapseHealth {
  totalSpawns: number;
  totalErrors: number;
  lastError?: string;
  totalEmptySpawns: number;
  emptySpawnWarningEmitted: boolean;
}

export interface ContextCollapseStats {
  collapsedSpans: number;
  collapsedMessages: number;
  stagedSpans: number;
  health: CollapseHealth;
}

const DEFAULT_HEALTH: CollapseHealth = {
  totalSpawns: 0,
  totalErrors: 0,
  totalEmptySpawns: 0,
  emptySpawnWarningEmitted: false,
};

// Module-level store (singleton per process, like Claude Code)
let commits: ContextCollapseCommit[] = [];
let snapshot: ContextCollapseSnapshot | undefined;
let stats: ContextCollapseStats = {
  collapsedSpans: 0,
  collapsedMessages: 0,
  stagedSpans: 0,
  health: { ...DEFAULT_HEALTH },
};
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** Subscribe to collapse state changes. Returns unsubscribe function. */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Get current collapse stats (deep copy). */
export function getCollapseStats(): ContextCollapseStats {
  return { ...stats, health: { ...stats.health } };
}

/** Get all committed collapses. */
export function getCollapseCommits(): ContextCollapseCommit[] {
  return [...commits];
}

/** Record a successful collapse. */
export function recordCollapseCommit(commit: ContextCollapseCommit): void {
  commits.push(commit);
  stats.collapsedSpans++;
  stats.collapsedMessages += commit.messageCount;
  stats.health.totalSpawns++;
  emit();
}

/** Record a collapse error. */
export function recordCollapseError(error: string): void {
  stats.health.totalErrors++;
  stats.health.lastError = error;
  emit();
}

/** Record an empty collapse (compactor returned nothing useful). */
export function recordEmptyCollapse(): void {
  stats.health.totalEmptySpawns++;
  if (stats.health.totalEmptySpawns >= 3 && !stats.health.emptySpawnWarningEmitted) {
    stats.health.emptySpawnWarningEmitted = true;
  }
  emit();
}

/** Stage a pending collapse for persistence. */
export function stageCollapse(commit: ContextCollapseCommit): void {
  if (!snapshot) {
    snapshot = { staged: [], health: { ...stats.health } };
  }
  snapshot.staged.push(commit);
  stats.stagedSpans = snapshot.staged.length;
  emit();
}

/** Flush staged collapses (after they've been persisted to JSONL). */
export function flushStaged(): ContextCollapseCommit[] {
  const flushed = snapshot?.staged ?? [];
  if (snapshot) {
    snapshot.staged = [];
    stats.stagedSpans = 0;
  }
  emit();
  return flushed;
}

/** Reset all collapse state (for new session or testing). */
export function resetContextCollapse(): void {
  commits = [];
  snapshot = undefined;
  stats = {
    collapsedSpans: 0,
    collapsedMessages: 0,
    stagedSpans: 0,
    health: { ...DEFAULT_HEALTH },
  };
  emit();
}

/** Restore collapse state from persisted entries (for /resume). */
export function restoreFromEntries(
  savedCommits: ContextCollapseCommit[],
  savedSnapshot?: ContextCollapseSnapshot,
): void {
  commits = [...savedCommits];
  snapshot = savedSnapshot
    ? { staged: [...savedSnapshot.staged], health: { ...savedSnapshot.health } }
    : undefined;
  stats = {
    collapsedSpans: commits.length,
    collapsedMessages: commits.reduce((sum, c) => sum + c.messageCount, 0),
    stagedSpans: snapshot?.staged.length ?? 0,
    health: savedSnapshot?.health
      ? { ...savedSnapshot.health }
      : { ...DEFAULT_HEALTH, totalSpawns: commits.length },
  };
  emit();
}
