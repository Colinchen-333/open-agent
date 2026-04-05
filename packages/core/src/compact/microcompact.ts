export interface MicrocompactOptions {
  /** Maximum allowed length (in chars) for a single tool_result content string. */
  maxResultSizeChars: number;
}

type Block = { type: string; [k: string]: unknown };
type Msg = { role: string; content: Block[] };

/**
 * Microcompact strategy: when a tool_result content string exceeds
 * `maxResultSizeChars`, truncate it to the allowed head and append a marker
 * indicating how many characters were dropped.
 *
 * Only string-valued content fields are compacted; array-form content blocks
 * (multi-part tool results) are left untouched.
 */
export function microcompact(messages: Msg[], opts: MicrocompactOptions): Msg[] {
  return messages.map((m) => ({
    ...m,
    content: m.content.map((block) => {
      if (block.type === 'tool_result' && typeof block.content === 'string') {
        const s = block.content as string;
        if (s.length > opts.maxResultSizeChars) {
          const head = s.slice(0, opts.maxResultSizeChars);
          const dropped = s.length - opts.maxResultSizeChars;
          return {
            ...block,
            content: `${head}\n\n[...truncated — ${dropped} chars dropped by microcompact]`,
          };
        }
      }
      return block;
    }),
  }));
}
