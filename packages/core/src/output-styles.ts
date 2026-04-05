import { loadMarkdownConfig } from './markdown-config-loader.js';

export interface OutputStyle {
  /** Name (from frontmatter or filename stem). */
  name: string;
  /** Short description shown in `/output-style` list. */
  description: string;
  /** The markdown body — inserted into the system prompt as additional styling instructions. */
  instructions: string;
  /** When true, Claude Code's standard "coding agent" instructions are still injected alongside this style. */
  keepCodingInstructions: boolean;
  /** Source path for debug. */
  sourcePath: string;
}

/**
 * Load all output styles from `~/.claude/output-styles/*.md` and `<cwd>/.claude/output-styles/*.md`.
 * Project overrides user. Returns list sorted by name.
 */
export async function loadOutputStyles(cwd: string, home?: string): Promise<OutputStyle[]> {
  const entries = await loadMarkdownConfig({ subdir: 'output-styles', cwd, home });
  return entries.map((entry) => {
    const fm = entry.frontmatter;
    const nameFromFm = typeof fm.name === 'string' ? fm.name : null;
    const name = nameFromFm || entry.name;
    const description = typeof fm.description === 'string' ? fm.description : '';
    const keepCodingInstructions = parseBooleanish(
      fm['keep-coding-instructions'] ?? fm.keepCodingInstructions ?? true,
    );
    return {
      name,
      description,
      instructions: entry.body.trim(),
      keepCodingInstructions,
      sourcePath: entry.filePath,
    };
  });
}

function parseBooleanish(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') {
    const lower = v.trim().toLowerCase();
    return !(lower === 'false' || lower === '0' || lower === 'no');
  }
  return true; // default true when absent
}

/**
 * Built-in output styles that ship with OpenAgent. Users can still override
 * by defining a style with the same name in their ~/.claude/output-styles/.
 */
export const BUILTIN_OUTPUT_STYLES: OutputStyle[] = [
  {
    name: 'default',
    description: 'Balanced, concise replies with code blocks',
    instructions: '',
    keepCodingInstructions: true,
    sourcePath: '<builtin>',
  },
  {
    name: 'verbose',
    description: 'Expansive explanations with step-by-step reasoning',
    instructions:
      'Prefer thorough, step-by-step explanations. Walk through your reasoning. Include context and cite files when relevant.',
    keepCodingInstructions: true,
    sourcePath: '<builtin>',
  },
  {
    name: 'terse',
    description: 'Minimal output, code-first',
    instructions:
      'Be extremely concise. Lead with code. Skip explanations unless asked. No preamble, no summaries.',
    keepCodingInstructions: true,
    sourcePath: '<builtin>',
  },
];

/** Merge loaded user/project styles with built-ins. User styles win on name collision. */
export function mergeOutputStyles(
  loaded: OutputStyle[],
  builtin: OutputStyle[] = BUILTIN_OUTPUT_STYLES,
): OutputStyle[] {
  const byName = new Map<string, OutputStyle>();
  for (const b of builtin) byName.set(b.name, b);
  for (const l of loaded) byName.set(l.name, l); // loaded overrides
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Find an output style by name. Falls back to 'default' if not found.
 */
export function findOutputStyle(name: string, styles: OutputStyle[]): OutputStyle {
  const hit = styles.find((s) => s.name === name);
  if (hit) return hit;
  const fallback = styles.find((s) => s.name === 'default');
  if (fallback) return fallback;
  return styles[0] ?? BUILTIN_OUTPUT_STYLES[0]!;
}
