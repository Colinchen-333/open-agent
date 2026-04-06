import { snip } from './snip.js';
import { microcompact } from './microcompact.js';

export { snip } from './snip.js';
export type { SnipOptions } from './snip.js';
export { microcompact, DEFAULT_TOOL_BUDGETS } from './microcompact.js';
export type { MicrocompactOptions } from './microcompact.js';

export type AutoCompactPolicy = 'proactive' | 'reactive-only' | 'disabled';

export * from './summarizer.js';
export * from './llm-summarizer.js';
export * from './llm-autocompact.js';
export * from './token-estimate.js';

export {
  recordCollapseCommit,
  recordCollapseError,
  recordEmptyCollapse,
  stageCollapse,
  flushStaged,
  resetContextCollapse,
  restoreFromEntries,
  getCollapseStats,
  getCollapseCommits,
  subscribe as subscribeToCollapse,
  type ContextCollapseCommit,
  type ContextCollapseSnapshot,
  type ContextCollapseStats,
  type CollapseHealth,
} from './context-collapse.js';

export interface CompactPipelineOptions {
  /** Number of recent assistant turns whose tool_results to preserve unchanged. */
  keepLastN: number;
  /** Maximum allowed size in chars for any single tool_result content string. */
  maxResultSizeChars: number;
}

/**
 * Run the layered auto-compact pipeline on a message array.
 *
 * Stages (in order):
 *  1. snip   — replace tool_result bodies for old turns with a short placeholder
 *  2. microcompact — truncate any remaining oversized tool_result strings
 *
 * Returns a new message array; inputs are never mutated.
 */
export function runCompactPipeline(
  messages: any[],
  opts: CompactPipelineOptions,
): any[] {
  let out = messages;
  out = snip(out, { keepLastN: opts.keepLastN });
  out = microcompact(out, { maxResultSizeChars: opts.maxResultSizeChars });
  return out;
}
