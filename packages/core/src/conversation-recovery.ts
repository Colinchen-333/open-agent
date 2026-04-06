/**
 * Conversation recovery from corrupted or partial JSONL session files.
 * Reconstructs message chains, detects orphaned entries, and finds
 * the newest valid conversation state.
 */

export interface RecoveryResult {
  /** Successfully parsed messages */
  messages: unknown[];
  /** Number of corrupted/skipped lines */
  corruptedLines: number;
  /** Total lines in file */
  totalLines: number;
  /** Whether recovery was needed (had corrupted lines) */
  wasCorrupted: boolean;
  /** Line numbers of corrupted entries */
  corruptedLineNumbers: number[];
}

/**
 * Read a JSONL session file with corruption tolerance.
 * Unlike readJsonlSession which stops at first error, this skips
 * corrupted lines and continues reading.
 */
export function recoverFromJsonl(content: string): RecoveryResult {
  const lines = content.split('\n');
  const messages: unknown[] = [];
  const corruptedLineNumbers: number[] = [];
  let corruptedLines = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue; // Skip blank lines

    try {
      const parsed = JSON.parse(line);
      messages.push(parsed);
    } catch {
      corruptedLines++;
      corruptedLineNumbers.push(i + 1); // 1-indexed
    }
  }

  return {
    messages,
    corruptedLines,
    totalLines: lines.filter(l => l.trim().length > 0).length,
    wasCorrupted: corruptedLines > 0,
    corruptedLineNumbers,
  };
}

/**
 * Find the newest conversation leaf in a message chain.
 * Messages with parentUuid form a tree; we want the newest leaf
 * (most recent message that isn't referenced as a parent).
 */
export function findNewestLeaf(messages: unknown[]): unknown | null {
  if (messages.length === 0) return null;

  // Collect all UUIDs that are referenced as parentUuid
  const parentUuids = new Set<string>();
  for (const msg of messages) {
    const parent = (msg as any)?.parentUuid;
    if (typeof parent === 'string') parentUuids.add(parent);
  }

  // Find messages whose UUID is NOT referenced as a parent — these are leaves
  const leaves: unknown[] = [];
  for (const msg of messages) {
    const uuid = (msg as any)?.uuid;
    if (typeof uuid === 'string' && !parentUuids.has(uuid)) {
      leaves.push(msg);
    }
  }

  if (leaves.length === 0) {
    // No UUID structure — return last message
    return messages[messages.length - 1] ?? null;
  }

  // Return newest leaf by timestamp
  return leaves.sort((a, b) => {
    const ta = (a as any)?.timestamp ?? '';
    const tb = (b as any)?.timestamp ?? '';
    return tb.localeCompare(ta);
  })[0] ?? null;
}

/**
 * Extract a linear conversation chain ending at a specific message.
 * Walks backward through parentUuid links.
 */
export function extractChain(messages: unknown[], leafUuid: string): unknown[] {
  const byUuid = new Map<string, unknown>();
  for (const msg of messages) {
    const uuid = (msg as any)?.uuid;
    if (typeof uuid === 'string') byUuid.set(uuid, msg);
  }

  const chain: unknown[] = [];
  let current: string | null = leafUuid;
  const visited = new Set<string>();

  while (current && !visited.has(current)) {
    visited.add(current);
    const msg = byUuid.get(current);
    if (!msg) break;
    chain.unshift(msg);
    current = (msg as any)?.parentUuid ?? null;
  }

  return chain;
}

/**
 * Filter messages to exclude sidechain entries.
 */
export function filterMainThread(messages: unknown[]): unknown[] {
  return messages.filter(msg => {
    const entry = msg as any;
    return !entry.isSidechain;
  });
}

/**
 * Detect and report conversation health metrics.
 */
export interface ConversationHealth {
  totalMessages: number;
  mainThreadMessages: number;
  sidechainMessages: number;
  uniqueAgents: number;
  hasOrphanedToolUse: boolean;
  newestTimestamp: string | null;
}

export function assessHealth(messages: unknown[]): ConversationHealth {
  let mainThread = 0;
  let sidechain = 0;
  const agents = new Set<string>();
  let newestTimestamp: string | null = null;
  const toolUseIds = new Set<string>();
  const toolResultIds = new Set<string>();

  for (const msg of messages) {
    const entry = msg as any;

    if (entry.isSidechain) {
      sidechain++;
      if (entry.agentId) agents.add(entry.agentId);
    } else {
      mainThread++;
    }

    const ts = entry.timestamp;
    if (typeof ts === 'string' && (!newestTimestamp || ts > newestTimestamp)) {
      newestTimestamp = ts;
    }

    // Track tool_use / tool_result for orphan detection
    const content = entry.message?.content ?? entry.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'tool_use') toolUseIds.add(block.id);
        if (block.type === 'tool_result') toolResultIds.add(block.tool_use_id);
      }
    }
  }

  const hasOrphanedToolUse = [...toolUseIds].some(id => !toolResultIds.has(id));

  return {
    totalMessages: messages.length,
    mainThreadMessages: mainThread,
    sidechainMessages: sidechain,
    uniqueAgents: agents.size,
    hasOrphanedToolUse,
    newestTimestamp,
  };
}
