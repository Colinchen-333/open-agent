/**
 * Terminal UI component primitives matching Claude Code's Ink component API
 * surface without the React dependency. These produce ANSI strings for direct
 * stdout output.
 *
 * Uses raw ANSI escape codes (same approach as renderer.ts) to avoid pulling
 * in chalk or any other external dependency.
 */

// ── ANSI escape codes (mirrored from renderer.ts for independence) ───
const ESC = '\x1b';

const A = {
  reset: `${ESC}[0m`,
  bold: `${ESC}[1m`,
  dim: `${ESC}[2m`,
  italic: `${ESC}[3m`,
  underline: `${ESC}[4m`,
  strikethrough: `${ESC}[9m`,

  // Foreground colors
  black: `${ESC}[30m`,
  red: `${ESC}[31m`,
  green: `${ESC}[32m`,
  yellow: `${ESC}[33m`,
  blue: `${ESC}[34m`,
  magenta: `${ESC}[35m`,
  cyan: `${ESC}[36m`,
  white: `${ESC}[37m`,
  gray: `${ESC}[90m`,

  // Cursor / line control
  clearLine: `${ESC}[2K`,
} as const;

/** Map of color names to their ANSI foreground codes. */
const COLOR_MAP: Record<string, string> = {
  black: A.black,
  red: A.red,
  green: A.green,
  yellow: A.yellow,
  blue: A.blue,
  magenta: A.magenta,
  cyan: A.cyan,
  white: A.white,
  gray: A.gray,
  grey: A.gray,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Strip ANSI escape codes for visible-width calculation. */
export function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

/** Wrap a string with an ANSI style code and a reset suffix. */
function wrap(code: string, text: string): string {
  return `${code}${text}${A.reset}`;
}

// ---------------------------------------------------------------------------
// Text component
// ---------------------------------------------------------------------------

export interface TextOptions {
  color?: string; // key into COLOR_MAP
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  dimColor?: boolean;
  strikethrough?: boolean;
  wrap?: 'wrap' | 'truncate' | 'truncate-end';
}

/**
 * Render styled terminal text.
 *
 * Applies ANSI formatting in a deterministic order: decorations first, then
 * color, so the outermost escape is always the color (matching chalk's
 * nesting behaviour).
 */
export function renderText(content: string, opts?: TextOptions): string {
  if (!opts) return content;

  let result = content;

  // Apply decorations (innermost first so they nest correctly)
  if (opts.strikethrough) result = wrap(A.strikethrough, result);
  if (opts.underline) result = wrap(A.underline, result);
  if (opts.italic) result = wrap(A.italic, result);
  if (opts.dimColor) result = wrap(A.dim, result);
  if (opts.bold) result = wrap(A.bold, result);

  // Apply color (outermost)
  if (opts.color) {
    const code = COLOR_MAP[opts.color];
    if (code) result = wrap(code, result);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Box component
// ---------------------------------------------------------------------------

export type BorderStyle = 'single' | 'double' | 'round' | 'bold' | 'classic' | 'none';

export interface BoxOptions {
  borderStyle?: BorderStyle;
  borderColor?: string;
  padding?: number | { top?: number; bottom?: number; left?: number; right?: number };
  margin?: number | { top?: number; bottom?: number; left?: number; right?: number };
  width?: number;
  flexDirection?: 'row' | 'column';
  justifyContent?: 'flex-start' | 'center' | 'flex-end' | 'space-between';
  alignItems?: 'flex-start' | 'center' | 'flex-end';
}

interface BorderChars {
  tl: string;
  tr: string;
  bl: string;
  br: string;
  h: string;
  v: string;
}

const BORDER_CHARS: Record<BorderStyle, BorderChars | null> = {
  single: { tl: '┌', tr: '┐', bl: '└', br: '┘', h: '─', v: '│' },
  double: { tl: '╔', tr: '╗', bl: '╚', br: '╝', h: '═', v: '║' },
  round: { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' },
  bold: { tl: '┏', tr: '┓', bl: '┗', br: '┛', h: '━', v: '┃' },
  classic: { tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|' },
  none: null,
};

interface Sides {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** Normalize a shorthand padding/margin value to explicit {top,right,bottom,left}. */
function normalizeSides(
  value?: number | { top?: number; bottom?: number; left?: number; right?: number },
): Sides {
  if (value == null) return { top: 0, bottom: 0, left: 0, right: 0 };
  if (typeof value === 'number')
    return { top: value, bottom: value, left: value, right: value };
  return {
    top: value.top ?? 0,
    bottom: value.bottom ?? 0,
    left: value.left ?? 0,
    right: value.right ?? 0,
  };
}

/**
 * Render a box around content with optional border, padding, and margin.
 *
 * The returned string contains newlines and can be written directly to stdout.
 */
export function renderBox(content: string, opts?: BoxOptions): string {
  const border = BORDER_CHARS[opts?.borderStyle ?? 'none'];
  const pad = normalizeSides(opts?.padding);
  const margin = normalizeSides(opts?.margin);

  const lines = content.split('\n');

  // Determine the visible width of the widest content line.
  const maxContentWidth = Math.max(...lines.map((l) => stripAnsi(l).length));

  const contentWidth = opts?.width
    ? opts.width - (border ? 2 : 0) - pad.left - pad.right
    : maxContentWidth;

  const innerWidth = contentWidth + pad.left + pad.right;
  const result: string[] = [];

  // Top margin
  for (let i = 0; i < margin.top; i++) result.push('');

  const marginLeft = ' '.repeat(margin.left);
  const padLeft = ' '.repeat(pad.left);
  const padRight = ' '.repeat(pad.right);

  // Colorize border characters if a borderColor is specified.
  const colorize = (s: string): string => {
    if (!opts?.borderColor) return s;
    const code = COLOR_MAP[opts.borderColor];
    return code ? wrap(code, s) : s;
  };

  // Top border
  if (border) {
    result.push(
      marginLeft + colorize(border.tl + border.h.repeat(innerWidth) + border.tr),
    );
  }

  // Top padding rows
  for (let i = 0; i < pad.top; i++) {
    const padLine = ' '.repeat(innerWidth);
    result.push(
      border
        ? marginLeft + colorize(border.v) + padLine + colorize(border.v)
        : marginLeft + padLine,
    );
  }

  // Content lines
  for (const line of lines) {
    const visibleLen = stripAnsi(line).length;
    const fill = ' '.repeat(Math.max(0, contentWidth - visibleLen));
    const inner = padLeft + line + fill + padRight;
    result.push(
      border
        ? marginLeft + colorize(border.v) + inner + colorize(border.v)
        : marginLeft + inner,
    );
  }

  // Bottom padding rows
  for (let i = 0; i < pad.bottom; i++) {
    const padLine = ' '.repeat(innerWidth);
    result.push(
      border
        ? marginLeft + colorize(border.v) + padLine + colorize(border.v)
        : marginLeft + padLine,
    );
  }

  // Bottom border
  if (border) {
    result.push(
      marginLeft + colorize(border.bl + border.h.repeat(innerWidth) + border.br),
    );
  }

  // Bottom margin
  for (let i = 0; i < margin.bottom; i++) result.push('');

  return result.join('\n');
}

// ---------------------------------------------------------------------------
// Spinner component
// ---------------------------------------------------------------------------

export interface SpinnerOptions {
  type?: 'dots' | 'line' | 'pipe' | 'star' | 'bounce';
  label?: string;
  color?: string;
}

const SPINNER_FRAMES: Record<string, string[]> = {
  dots: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
  line: ['-', '\\', '|', '/'],
  pipe: ['┤', '┘', '┴', '└', '├', '┌', '┬', '┐'],
  star: ['✶', '✸', '✹', '✺', '✹', '✷'],
  bounce: ['⠁', '⠂', '⠄', '⠂'],
};

/**
 * An animated terminal spinner that renders to stdout.
 *
 * Use `frame()` for manual (single-shot) rendering, or `start()` / `stop()`
 * for automatic interval-based animation.
 */
export class TerminalSpinner {
  private frameIndex = 0;
  private interval: ReturnType<typeof setInterval> | null = null;
  private frames: string[];
  private opts: SpinnerOptions;

  constructor(opts?: SpinnerOptions) {
    this.opts = opts ?? {};
    this.frames = SPINNER_FRAMES[opts?.type ?? 'dots'] ?? SPINNER_FRAMES.dots!;
  }

  /** Get the current frame string (for manual rendering). */
  frame(): string {
    const char = this.frames[this.frameIndex % this.frames.length]!;
    const colorCode = (this.opts.color && COLOR_MAP[this.opts.color]) || A.cyan;
    const colorized = wrap(colorCode, char);
    return this.opts.label ? `${colorized} ${this.opts.label}` : colorized;
  }

  /** Start auto-rendering to stdout at the given interval. */
  start(intervalMs = 80): void {
    if (this.interval) return;
    process.stdout.write(this.frame());
    this.interval = setInterval(() => {
      process.stdout.write(`\r${this.frame()}`);
      this.frameIndex++;
    }, intervalMs);
  }

  /** Stop the spinner and optionally print a final message. */
  stop(finalMessage?: string): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    process.stdout.write('\r' + ' '.repeat(80) + '\r');
    if (finalMessage) process.stdout.write(finalMessage + '\n');
  }

  /** Update the label while the spinner is running. */
  setLabel(label: string): void {
    this.opts.label = label;
  }
}

// ---------------------------------------------------------------------------
// Progress bar
// ---------------------------------------------------------------------------

export interface ProgressBarOptions {
  width?: number;
  complete?: string;
  incomplete?: string;
  color?: string;
}

/**
 * Render a single-line progress bar.
 *
 * @param progress Value between 0 and 1 (clamped).
 */
export function renderProgressBar(
  progress: number,
  opts?: ProgressBarOptions,
): string {
  const width = opts?.width ?? 40;
  const clamped = Math.max(0, Math.min(1, progress));
  const filled = Math.round(clamped * width);
  const empty = width - filled;
  const complete = opts?.complete ?? '█';
  const incomplete = opts?.incomplete ?? '░';
  const bar = complete.repeat(filled) + incomplete.repeat(empty);
  const pct = `${Math.round(clamped * 100)}%`;
  const colorCode = (opts?.color && COLOR_MAP[opts.color]) || A.green;
  const colored = wrap(colorCode, bar);
  return `${colored} ${pct}`;
}

// ---------------------------------------------------------------------------
// Table (simple)
// ---------------------------------------------------------------------------

/**
 * Render a simple fixed-width table with headers and rows.
 *
 * Column widths are auto-calculated from the widest cell in each column.
 */
export function renderTable(
  headers: string[],
  rows: string[][],
  opts?: { padding?: number },
): string {
  const pad = opts?.padding ?? 1;

  // Calculate column widths (max visible width per column).
  const colWidths = headers.map((h, i) => {
    const dataMax = Math.max(0, ...rows.map((r) => stripAnsi(r[i] ?? '').length));
    return Math.max(stripAnsi(h).length, dataMax);
  });

  const sp = ' '.repeat(pad);

  const formatRow = (cells: string[]) =>
    cells
      .map((c, i) => {
        const visLen = stripAnsi(c).length;
        return c + ' '.repeat(Math.max(0, colWidths[i]! - visLen));
      })
      .join(sp);

  const headerLine = formatRow(headers.map((h) => wrap(A.bold, h)));
  const separator = colWidths.map((w) => '─'.repeat(w)).join(sp.replace(/ /g, '─'));
  const bodyLines = rows.map((r) => formatRow(r));

  return [headerLine, separator, ...bodyLines].join('\n');
}
