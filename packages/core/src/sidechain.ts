import type { SessionJsonlWriter } from './session-io.js';

/**
 * A transcript entry with sidechain metadata, matching Claude Code's
 * JSONL format for subagent message persistence.
 */
export interface SidechainEntry {
  /** The message content (role + content blocks) */
  message: unknown;
  /** Always true for sidechain entries */
  isSidechain: true;
  /** Agent ID that produced this message */
  agentId: string;
  /** Parent message UUID for thread reconstruction */
  parentUuid?: string | null;
  /** Prompt ID for grouping related entries */
  promptId?: string;
  /** ISO timestamp */
  timestamp: string;
  /** Agent type (e.g., 'code-writer', 'Explore') */
  agentType?: string;
}

/**
 * Records subagent messages as sidechain entries in the session transcript.
 * Fire-and-forget — persistence failure should not block the agent.
 */
export async function recordSidechainTranscript(
  writer: SessionJsonlWriter,
  messages: unknown[],
  agentId: string,
  opts?: {
    parentUuid?: string | null;
    promptId?: string;
    agentType?: string;
  },
): Promise<void> {
  const timestamp = new Date().toISOString();
  for (const message of messages) {
    const entry: SidechainEntry = {
      message,
      isSidechain: true,
      agentId,
      parentUuid: opts?.parentUuid ?? null,
      promptId: opts?.promptId,
      timestamp,
      agentType: opts?.agentType,
    };
    await writer.append(entry);
  }
}

/**
 * Reads a JSONL transcript and separates main-thread vs sidechain entries.
 */
export function partitionTranscript(entries: unknown[]): {
  mainThread: unknown[];
  sidechains: Map<string, unknown[]>; // agentId -> entries
} {
  const mainThread: unknown[] = [];
  const sidechains = new Map<string, unknown[]>();

  for (const entry of entries) {
    if (isSidechainEntry(entry)) {
      const list = sidechains.get(entry.agentId) ?? [];
      list.push(entry);
      sidechains.set(entry.agentId, list);
    } else {
      mainThread.push(entry);
    }
  }

  return { mainThread, sidechains };
}

/**
 * Type guard for sidechain entries.
 */
export function isSidechainEntry(entry: unknown): entry is SidechainEntry {
  return (
    typeof entry === 'object' &&
    entry !== null &&
    'isSidechain' in entry &&
    (entry as any).isSidechain === true &&
    'agentId' in entry &&
    typeof (entry as any).agentId === 'string'
  );
}

/**
 * Extracts messages for a specific agent from sidechain entries.
 * Used to reconstruct agent state for resume.
 */
export function extractAgentMessages(
  entries: unknown[],
  agentId: string,
): unknown[] {
  return entries
    .filter(isSidechainEntry)
    .filter(e => e.agentId === agentId)
    .map(e => e.message);
}
