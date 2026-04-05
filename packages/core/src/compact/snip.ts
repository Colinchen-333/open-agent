export interface SnipOptions {
  /** Number of assistant turns whose tool_result bodies to preserve. */
  keepLastN: number;
}

type Block = { type: string; [k: string]: unknown };
type Msg = { role: string; content: Block[] };

/**
 * Snip strategy: drop tool_result bodies for tool calls older than the last
 * `keepLastN` assistant turns, replacing them with a short placeholder.
 * tool_use blocks are always kept intact so the message structure remains valid.
 */
export function snip(messages: Msg[], opts: SnipOptions): Msg[] {
  // Collect the index of each assistant message — each one represents a "turn".
  const turnIndices: number[] = [];
  messages.forEach((m, i) => {
    if (m.role === 'assistant') turnIndices.push(i);
  });

  // Determine the boundary: tool_results before this index get snipped.
  const keepFromIdx =
    turnIndices.length > opts.keepLastN
      ? turnIndices[turnIndices.length - opts.keepLastN]!
      : 0;

  return messages.map((m, i) => {
    // Messages at or after the boundary are returned unchanged.
    if (i >= keepFromIdx) return m;

    // For older messages, replace tool_result content with a placeholder but
    // leave every other block (including tool_use) untouched.
    const newContent = m.content.map((block) => {
      if (block.type === 'tool_result') {
        return {
          ...block,
          content: '[snipped by auto-compact — use Read to retrieve]',
        };
      }
      return block;
    });

    return { ...m, content: newContent };
  });
}
