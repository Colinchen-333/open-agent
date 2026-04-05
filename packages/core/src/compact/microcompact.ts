/**
 * Microcompact: per-tool_result truncation with tool-type awareness.
 *
 * Unlike the basic character truncator, this version:
 *   - Uses different budgets per tool type (Read gets more, WebFetch gets less)
 *   - Preserves image and binary content blocks unchanged
 *   - Respects cache_control flags (skipped — they're explicitly cached)
 *   - Cuts at semantic boundaries (newlines) when possible
 */

export interface MicrocompactOptions {
  /** Default character budget for unspecified tool types. */
  maxResultSizeChars: number;
  /** Optional per-tool-name overrides. */
  toolBudgets?: Partial<Record<string, number>>;
}

type Msg = {
  role: string;
  content: Array<{ type: string; [k: string]: unknown }>;
};

/** Default per-tool budgets (characters). */
export const DEFAULT_TOOL_BUDGETS: Record<string, number> = {
  Read: 200_000,       // file contents are often the most valuable
  Edit: 100_000,
  Write: 50_000,
  Grep: 150_000,       // search results can be long but structured
  Glob: 100_000,
  Bash: 100_000,       // shell output
  WebFetch: 40_000,    // pages are verbose
  WebSearch: 40_000,
  ListMcpResources: 80_000,
  ReadMcpResource: 150_000,
};

/**
 * Apply microcompact to a message list. Returns a new list with oversized
 * tool_result content truncated in place.
 */
export function microcompact(messages: Msg[], opts: MicrocompactOptions): Msg[] {
  // Build a map from tool_use_id → tool name so tool_result can look up its type
  const toolUseIdToName = new Map<string, string>();
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const block of m.content) {
      if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
        toolUseIdToName.set(block.id as string, block.name as string);
      }
    }
  }

  return messages.map((m) => ({
    ...m,
    content: Array.isArray(m.content)
      ? m.content.map((block) => compactBlock(block, toolUseIdToName, opts))
      : m.content,
  }));
}

function compactBlock(
  block: { type: string; [k: string]: unknown },
  toolUseIdToName: Map<string, string>,
  opts: MicrocompactOptions,
): { type: string; [k: string]: unknown } {
  if (block.type !== 'tool_result') return block;

  // Skip blocks with explicit cache_control — they're intentionally cached
  if (block.cache_control) return block;

  const toolUseId = typeof block.tool_use_id === 'string' ? block.tool_use_id : '';
  const toolName = toolUseIdToName.get(toolUseId);
  const budget = resolveBudget(toolName, opts);

  // Handle array content (mixed text + image blocks)
  if (Array.isArray(block.content)) {
    return {
      ...block,
      content: compactArrayContent(block.content as Array<Record<string, unknown>>, budget),
    };
  }

  // Handle string content
  if (typeof block.content === 'string') {
    return {
      ...block,
      content: truncateAtBoundary(block.content, budget, toolName),
    };
  }

  return block;
}

function resolveBudget(toolName: string | undefined, opts: MicrocompactOptions): number {
  if (!toolName) return opts.maxResultSizeChars;
  const override = opts.toolBudgets?.[toolName];
  if (typeof override === 'number') return override;
  const defaultBudget = DEFAULT_TOOL_BUDGETS[toolName];
  if (typeof defaultBudget === 'number') return defaultBudget;
  return opts.maxResultSizeChars;
}

function compactArrayContent(
  content: Array<Record<string, unknown>>,
  budget: number,
): Array<Record<string, unknown>> {
  // Preserve images, binary, resource blocks verbatim — truncate text blocks
  let remainingBudget = budget;
  const out: Array<Record<string, unknown>> = [];

  for (const block of content) {
    const type = block.type;
    if (type === 'image' || type === 'resource' || type === 'binary') {
      out.push(block); // untouched — images count as "free" in text budget terms
    } else if (type === 'text' && typeof block.text === 'string') {
      if (remainingBudget <= 0) {
        out.push({ ...block, text: `[truncated — budget exhausted by earlier text blocks]` });
      } else {
        const truncated = truncateAtBoundary(block.text, remainingBudget);
        out.push({ ...block, text: truncated });
        remainingBudget -= truncated.length;
      }
    } else {
      out.push(block);
    }
  }
  return out;
}

/**
 * Truncate a string at the last newline before `budget`, if one exists within
 * the final 10% of the budget. Otherwise hard-cut at exactly `budget` chars.
 * Appends a truncation marker.
 */
function truncateAtBoundary(text: string, budget: number, toolName?: string): string {
  if (text.length <= budget) return text;

  // Search for a newline within the last 10% of the budget
  const searchStart = Math.floor(budget * 0.9);
  const lastNewline = text.lastIndexOf('\n', budget);
  const cutPoint = lastNewline > searchStart ? lastNewline : budget;

  const head = text.slice(0, cutPoint);
  const droppedChars = text.length - cutPoint;
  const label = toolName ? `[${toolName} output truncated` : '[truncated';
  return `${head}\n\n${label} — ${droppedChars} chars dropped by microcompact]`;
}
