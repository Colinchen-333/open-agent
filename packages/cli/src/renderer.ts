import type { StreamEvent } from '@open-agent/providers';

// ── ANSI escape codes ─────────────────────────────────────────────────
const ESC = '\x1b';
const C = {
  reset: `${ESC}[0m`,
  bold: `${ESC}[1m`,
  dim: `${ESC}[2m`,
  italic: `${ESC}[3m`,
  underline: `${ESC}[4m`,
  inverse: `${ESC}[7m`,
  strikethrough: `${ESC}[9m`,

  red: `${ESC}[31m`,
  green: `${ESC}[32m`,
  yellow: `${ESC}[33m`,
  blue: `${ESC}[34m`,
  magenta: `${ESC}[35m`,
  cyan: `${ESC}[36m`,
  white: `${ESC}[37m`,
  gray: `${ESC}[90m`,

  bgRed: `${ESC}[41m`,
  bgGreen: `${ESC}[42m`,
  bgYellow: `${ESC}[43m`,
  bgBlue: `${ESC}[44m`,
  bgCyan: `${ESC}[46m`,
  bgGray: `${ESC}[100m`,

  // Cursor control
  hide: `${ESC}[?25l`,
  show: `${ESC}[?25h`,
  clearLine: `${ESC}[2K`,
  moveUp: (n: number) => `${ESC}[${n}A`,
  moveToCol: (n: number) => `${ESC}[${n}G`,
} as const;

// ── Box drawing ───────────────────────────────────────────────────────
const BOX = {
  topLeft: '╭',
  topRight: '╮',
  bottomLeft: '╰',
  bottomRight: '╯',
  horizontal: '─',
  vertical: '│',
  teeRight: '├',
  teeLeft: '┤',
} as const;

// ── Spinner frames ────────────────────────────────────────────────────
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/**
 * Get terminal width, clamped to a reasonable range.
 */
function getWidth(): number {
  return Math.min(process.stdout.columns ?? 80, 120);
}

/**
 * Draw a horizontal line with optional label.
 */
function hline(label?: string, color: string = C.gray): string {
  const w = getWidth();
  if (!label) return color + BOX.horizontal.repeat(w) + C.reset;
  const padded = ` ${label} `;
  const remaining = Math.max(0, w - padded.length - 2);
  return (
    color +
    BOX.topLeft +
    BOX.horizontal +
    C.reset +
    color +
    C.bold +
    padded +
    C.reset +
    color +
    BOX.horizontal.repeat(remaining) +
    BOX.topRight +
    C.reset
  );
}

function bottomLine(color: string = C.gray): string {
  const w = getWidth();
  return color + BOX.bottomLeft + BOX.horizontal.repeat(w - 2) + BOX.bottomRight + C.reset;
}

/**
 * Render basic Markdown to ANSI terminal output.
 * Handles: **bold**, *italic*, `inline code`, ```code blocks```,
 * # headers, - lists, > blockquotes
 */
function renderMarkdown(text: string): string {
  const lines = text.split('\n');
  const result: string[] = [];
  let inCodeBlock = false;
  let codeBlockLang = '';

  for (const line of lines) {
    // Code block toggle
    if (line.trimStart().startsWith('```')) {
      if (!inCodeBlock) {
        codeBlockLang = line.trimStart().slice(3).trim();
        const label = codeBlockLang || 'code';
        result.push(
          `${C.gray}${BOX.topLeft}${BOX.horizontal} ${label} ${BOX.horizontal.repeat(Math.max(0, 40 - label.length))}${C.reset}`,
        );
        inCodeBlock = true;
      } else {
        result.push(`${C.gray}${BOX.bottomLeft}${BOX.horizontal.repeat(44)}${C.reset}`);
        inCodeBlock = false;
        codeBlockLang = '';
      }
      continue;
    }

    if (inCodeBlock) {
      result.push(`${C.gray}${BOX.vertical}${C.reset} ${C.cyan}${line}${C.reset}`);
      continue;
    }

    let processed = line;

    // Headers
    const headerMatch = processed.match(/^(#{1,6})\s+(.*)$/);
    if (headerMatch) {
      const level = headerMatch[1].length;
      const content = headerMatch[2];
      if (level === 1) {
        result.push(`\n${C.bold}${C.white}${content}${C.reset}`);
        result.push(`${C.gray}${'═'.repeat(Math.min(content.length, getWidth()))}${C.reset}`);
      } else if (level === 2) {
        result.push(`\n${C.bold}${content}${C.reset}`);
        result.push(`${C.gray}${'─'.repeat(Math.min(content.length, getWidth()))}${C.reset}`);
      } else {
        result.push(`${C.bold}${content}${C.reset}`);
      }
      continue;
    }

    // Blockquotes
    if (processed.startsWith('>')) {
      const content = processed.replace(/^>\s*/, '');
      result.push(`${C.gray}${BOX.vertical}${C.reset} ${C.italic}${content}${C.reset}`);
      continue;
    }

    // List items
    if (processed.match(/^\s*[-*]\s/)) {
      processed = processed.replace(/^(\s*)[-*]\s/, '$1• ');
    } else if (processed.match(/^\s*\d+\.\s/)) {
      // Numbered lists: bold the number
      processed = processed.replace(/^(\s*)(\d+\.)(\s)/, `$1${C.bold}$2${C.reset}$3`);
    }

    // Inline formatting
    // Bold **text**
    processed = processed.replace(/\*\*([^*]+)\*\*/g, `${C.bold}$1${C.reset}`);
    // Italic *text*
    processed = processed.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, `${C.italic}$1${C.reset}`);
    // Inline code `text`
    processed = processed.replace(/`([^`]+)`/g, `${C.bgGray}${C.white} $1 ${C.reset}`);
    // Strikethrough ~~text~~
    processed = processed.replace(/~~([^~]+)~~/g, `${C.strikethrough}$1${C.reset}`);
    // Markdown links [text](url)
    processed = processed.replace(
      /\[([^\]]+)\]\(([^)]+)\)/g,
      `${C.underline}$1${C.reset}${C.dim} ($2)${C.reset}`,
    );

    result.push(processed);
  }

  // Close unclosed code block
  if (inCodeBlock) {
    result.push(`${C.gray}${BOX.bottomLeft}${BOX.horizontal.repeat(44)}${C.reset}`);
  }

  return result.join('\n');
}

export class TerminalRenderer {
  private inThinking = false;
  private inToolUse = false;
  private currentToolName = '';
  private currentToolInput = '';
  private spinnerInterval: ReturnType<typeof setInterval> | null = null;
  private spinnerFrame = 0;
  private textBuffer = '';
  private noMarkdown = false;

  constructor(options?: { noMarkdown?: boolean }) {
    this.noMarkdown = options?.noMarkdown ?? false;
  }

  private render(text: string): string {
    return this.noMarkdown ? text : renderMarkdown(text);
  }

  // ── Flush timer (streaming partial lines) ────────────────────────
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  private startFlushTimer(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      if (this.textBuffer) {
        process.stdout.write(this.textBuffer);
        this.textBuffer = '';
      }
      this.flushTimer = null;
    }, 50);
  }

  private cancelFlushTimer(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  // ── Spinner ───────────────────────────────────────────────────────
  startSpinner(label = 'Thinking'): void {
    if (this.spinnerInterval) return;
    process.stdout.write(C.hide);
    this.spinnerInterval = setInterval(() => {
      const frame = SPINNER_FRAMES[this.spinnerFrame % SPINNER_FRAMES.length];
      process.stdout.write(`${C.clearLine}\r${C.cyan}${frame}${C.reset} ${C.dim}${label}...${C.reset}`);
      this.spinnerFrame++;
    }, 80);
  }

  stopSpinner(): void {
    if (this.spinnerInterval) {
      clearInterval(this.spinnerInterval);
      this.spinnerInterval = null;
      process.stdout.write(`${C.clearLine}\r${C.show}`);
    }
    this.cancelFlushTimer();
  }

  // ── Stream events ─────────────────────────────────────────────────
  renderStreamEvent(event: StreamEvent): void {
    switch (event.type) {
      case 'text_delta': {
        this.stopSpinner();
        if (this.inThinking) {
          process.stdout.write(`\n${C.gray}${C.dim}${BOX.bottomLeft}${BOX.horizontal.repeat(40)}${C.reset}\n\n`);
          this.inThinking = false;
        }
        this.textBuffer += event.text;

        // Flush complete lines with markdown rendering
        const lastNewline = this.textBuffer.lastIndexOf('\n');
        if (lastNewline !== -1) {
          const toRender = this.textBuffer.slice(0, lastNewline);
          this.textBuffer = this.textBuffer.slice(lastNewline + 1);
          process.stdout.write(this.render(toRender) + '\n');
          this.cancelFlushTimer();
        }

        // Start a flush timer for partial lines (streaming feel)
        this.startFlushTimer();
        break;
      }

      case 'thinking_delta': {
        this.stopSpinner();
        if (!this.inThinking) {
          process.stdout.write(
            `\n${C.gray}${C.dim}${BOX.topLeft}${BOX.horizontal} thinking ${BOX.horizontal.repeat(30)}${C.reset}\n${C.gray}${C.dim}`,
          );
          this.inThinking = true;
        }
        // Thinking content in dim gray
        process.stdout.write(event.thinking);
        break;
      }

      case 'tool_use_start': {
        this.stopSpinner();
        this.cancelFlushTimer();
        // Flush remaining text buffer
        if (this.textBuffer) {
          process.stdout.write(this.render(this.textBuffer));
          this.textBuffer = '';
        }
        if (this.inThinking) {
          process.stdout.write(`${C.reset}\n`);
          this.inThinking = false;
        }
        this.currentToolName = event.name;
        this.currentToolInput = '';
        this.inToolUse = true;

        // Draw tool call header
        const icon = this.getToolIcon(event.name);
        process.stdout.write(`\n${hline(`${icon} ${event.name}`, C.cyan)}\n`);
        break;
      }

      case 'tool_use_delta': {
        if (this.inToolUse) {
          this.currentToolInput += event.partial_json;
        }
        break;
      }

      case 'tool_use_end': {
        if (this.inToolUse) {
          // Show input summary
          const summary = this.formatToolInput(this.currentToolName, this.currentToolInput);
          if (summary) {
            for (const line of summary.split('\n')) {
              process.stdout.write(`${C.gray}${BOX.vertical}${C.reset} ${line}\n`);
            }
          }
          process.stdout.write(`${bottomLine(C.cyan)}\n`);
          this.inToolUse = false;

          // Use contextual spinner label based on the tool being executed
          const spinnerLabel = this.getSpinnerLabel(this.currentToolName, this.currentToolInput);
          this.startSpinner(spinnerLabel);
        }
        break;
      }

      case 'error': {
        this.stopSpinner();
        process.stderr.write(
          `\n${C.red}${C.bold}Error:${C.reset} ${C.red}${JSON.stringify(event.error)}${C.reset}\n`,
        );
        break;
      }
    }
  }

  // ── Tool result (called from ConversationLoop integration) ────────
  renderToolResult(toolName: string, result: unknown, isError: boolean): void {
    this.stopSpinner();
    if (isError) {
      const detail = typeof result === 'string' ? result : JSON.stringify(result).slice(0, 200);
      process.stdout.write(`  ${C.red}✗ ${detail}${C.reset}\n`);
    } else {
      this.renderSuccessToolResult(toolName, result);
    }
  }

  private renderSuccessToolResult(toolName: string, result: unknown): void {
    const resultStr = typeof result === 'string' ? result : JSON.stringify(result);

    switch (toolName) {
      case 'Bash': {
        // Show first 3 lines of stdout
        const lines = resultStr.split('\n').filter((l) => l.trim() !== '');
        const preview = lines.slice(0, 3);
        const remaining = lines.length - preview.length;
        if (preview.length === 0) {
          process.stdout.write(`  ${C.green}✓${C.reset} ${C.dim}(no output)${C.reset}\n`);
        } else {
          process.stdout.write(`  ${C.green}✓${C.reset}\n`);
          for (const line of preview) {
            process.stdout.write(`  ${C.dim}${line}${C.reset}\n`);
          }
          if (remaining > 0) {
            process.stdout.write(`  ${C.dim}… ${remaining} more line${remaining > 1 ? 's' : ''}${C.reset}\n`);
          }
        }
        break;
      }

      case 'Read': {
        // Try structured result first, then fall back to raw string
        let filePath = '';
        let numLines = 0;
        if (typeof result === 'object' && result !== null) {
          const r = result as Record<string, any>;
          filePath = r?.file?.filePath ?? r?.filePath ?? '';
          numLines = r?.file?.numLines ?? r?.numLines ?? 0;
        } else {
          // Raw string result — count lines and derive filename from tool input
          numLines = resultStr.split('\n').length;
          filePath = this.basename(
            (() => {
              try { return JSON.parse(this.currentToolInput || '{}').file_path ?? ''; } catch { return ''; }
            })()
          );
        }
        const name = filePath ? this.basename(filePath) : 'file';
        process.stdout.write(`  ${C.green}✓ Read ${name} (${numLines} lines)${C.reset}\n`);
        break;
      }

      case 'Write': {
        const r = (typeof result === 'object' && result !== null) ? result as Record<string, any> : {};
        const filePath = r?.filePath ?? '';
        const name = filePath ? this.basename(filePath) : 'file';
        process.stdout.write(`  ${C.green}✓ Wrote ${name}${C.reset}\n`);
        break;
      }

      case 'Edit': {
        const r = (typeof result === 'object' && result !== null) ? result as Record<string, any> : {};
        const filePath = r?.filePath ?? '';
        const name = filePath ? this.basename(filePath) : 'file';
        const reps = r?.replacements ?? 1;
        process.stdout.write(`  ${C.green}✓ Edited ${name} (${reps} replacement${reps > 1 ? 's' : ''})${C.reset}\n`);

        // Render the structured patch when available (generated by generateSimplePatch
        // in the Edit tool).  This shows added/removed lines with color-coded prefixes
        // and dim context lines, skipping the header lines (--- / +++).
        if (r?.patch && typeof r.patch === 'string') {
          const patchLines = r.patch.split('\n');
          // Skip the --- / +++ header lines (first two); they add noise in the terminal.
          const bodyLines = patchLines.slice(2, 22); // display at most 20 diff lines
          for (const line of bodyLines) {
            if (line.startsWith('+ ')) {
              process.stdout.write(`  ${C.green}${line}${C.reset}\n`);
            } else if (line.startsWith('- ')) {
              process.stdout.write(`  ${C.red}${line}${C.reset}\n`);
            } else {
              process.stdout.write(`  ${C.dim}${line}${C.reset}\n`);
            }
          }
          if (patchLines.length > 22) {
            const remaining = patchLines.length - 22;
            process.stdout.write(`  ${C.dim}… ${remaining} more line${remaining > 1 ? 's' : ''}${C.reset}\n`);
          }
        }
        break;
      }

      default: {
        const summary = this.summarizeToolResult(toolName, result);
        process.stdout.write(`  ${C.green}✓ ${summary}${C.reset}\n`);
        break;
      }
    }
  }

  // ── Final result ──────────────────────────────────────────────────
  renderResult(result: Record<string, any>): void {
    this.stopSpinner();
    // Flush remaining text
    if (this.textBuffer) {
      process.stdout.write(this.render(this.textBuffer) + '\n');
      this.textBuffer = '';
    }

    process.stdout.write('\n');

    if (result.is_error) {
      const detail = Array.isArray(result.errors) ? result.errors.join(', ') : result.subtype;
      process.stdout.write(`${C.red}${C.bold}Error:${C.reset} ${C.red}${detail}${C.reset}\n`);
    }

    const usage = result.usage as Record<string, number> | undefined;
    if (usage) {
      const cost = result.total_cost_usd as number | undefined;
      const costStr = cost && cost > 0 ? ` ${C.yellow}$${cost.toFixed(4)}${C.gray}` : '';
      const tokIn = usage.input_tokens ?? 0;
      const tokOut = usage.output_tokens ?? 0;
      const duration = result.duration_ms ?? 0;
      const durationStr = duration >= 1000 ? `${(duration / 1000).toFixed(1)}s` : `${duration}ms`;

      process.stdout.write(
        `${C.gray}${C.dim}` +
          `${tokIn.toLocaleString()} → ${tokOut.toLocaleString()} tokens` +
          ` · ${result.num_turns ?? 0} turns` +
          ` · ${durationStr}` +
          `${costStr}` +
          `${C.reset}\n`,
      );
    }
  }

  // ── Per-turn cost line ────────────────────────────────────────────
  renderTurnCost(inputTokens: number, outputTokens: number, cumulativeCost: number): void {
    const costStr = cumulativeCost > 0 ? ` · ${C.yellow}$${cumulativeCost.toFixed(4)}${C.reset}` : '';
    process.stdout.write(
      `  ${C.dim}${C.gray}↳ ${inputTokens.toLocaleString()} in · ${outputTokens.toLocaleString()} out${costStr}${C.dim}${C.gray}${C.reset}\n`,
    );
  }

  // ── Welcome message ───────────────────────────────────────────────
  renderWelcome(model: string, cwd?: string): void {
    const VERSION = '0.1.0';
    const cwdDisplay = cwd ?? process.cwd();

    // Lines to display inside the box (without padding)
    const innerLines = [
      `${C.bold}${C.cyan}✻ OpenAgent v${VERSION}${C.reset}`,
      '',
      `${C.dim}/help for help${C.reset}`,
      '',
      `${C.dim}cwd: ${cwdDisplay}${C.reset}`,
      `${C.dim}model: ${model}${C.reset}`,
    ];

    // Calculate visible width of each line (strip ANSI codes for measurement)
    const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');
    const visibleLengths = innerLines.map((l) => stripAnsi(l).length);
    const maxVisible = Math.max(...visibleLengths);
    // Box inner width = maxVisible + 2 padding on each side
    const innerWidth = maxVisible + 4;

    const top = `${C.gray}${BOX.topLeft}${BOX.horizontal.repeat(innerWidth)}${BOX.topRight}${C.reset}`;
    const bottom = `${C.gray}${BOX.bottomLeft}${BOX.horizontal.repeat(innerWidth)}${BOX.bottomRight}${C.reset}`;

    process.stdout.write('\n' + top + '\n');
    for (let i = 0; i < innerLines.length; i++) {
      const line = innerLines[i];
      const visible = visibleLengths[i];
      const pad = innerWidth - visible - 2; // 2 for left "│ " prefix
      process.stdout.write(`${C.gray}${BOX.vertical}${C.reset}  ${line}${' '.repeat(Math.max(0, pad))}${C.gray}${BOX.vertical}${C.reset}\n`);
    }
    process.stdout.write(bottom + '\n\n');
  }

  // ── Contextual spinner label ──────────────────────────────────────
  private getSpinnerLabel(toolName: string, rawJson: string): string {
    try {
      const input = JSON.parse(rawJson || '{}');
      switch (toolName) {
        case 'Read':    return `Reading ${this.basename(input.file_path ?? '')}`;
        case 'Write':   return `Writing ${this.basename(input.file_path ?? '')}`;
        case 'Edit':    return `Editing ${this.basename(input.file_path ?? '')}`;
        case 'Bash':    return 'Running command';
        case 'Glob':    return 'Searching files';
        case 'Grep':    return 'Searching content';
        case 'WebFetch':  return 'Fetching URL';
        case 'WebSearch': return 'Searching web';
        case 'Task':    return `Running ${input.subagent_type ?? 'agent'}`;
        default:        return `Running ${toolName}`;
      }
    } catch {
      return `Running ${toolName}`;
    }
  }

  private basename(filePath: string): string {
    if (!filePath) return 'file';
    const parts = filePath.split('/');
    return parts[parts.length - 1] || filePath;
  }

  // ── Tool icons ────────────────────────────────────────────────────
  private getToolIcon(toolName: string): string {
    const icons: Record<string, string> = {
      Read: '📄',
      Write: '✏️',
      Edit: '🔧',
      Bash: '⚡',
      Glob: '🔍',
      Grep: '🔎',
      WebFetch: '🌐',
      WebSearch: '🔍',
      NotebookEdit: '📓',
      Task: '🚀',
      AskUserQuestion: '❓',
      EnterPlanMode: '📋',
      ExitPlanMode: '✅',
      Config: '⚙️',
      EnterWorktree: '🌳',
      TeamCreate: '👥',
      SendMessage: '💬',
      TaskCreate: '📝',
      TaskUpdate: '🔄',
      TaskList: '📋',
      Skill: '⭐',
      ToolSearch: '🔧',
    };
    return icons[toolName] ?? '⚡';
  }

  // ── Tool input formatting ─────────────────────────────────────────
  private formatToolInput(toolName: string, rawJson: string): string {
    let input: Record<string, unknown>;
    try {
      input = JSON.parse(rawJson || '{}');
    } catch {
      return '';
    }

    switch (toolName) {
      case 'Bash': {
        const cmd = String(input.command ?? '');
        const desc = input.description ? `${C.dim}# ${input.description}${C.reset}\n` : '';
        return desc + `${C.yellow}$ ${cmd}${C.reset}`;
      }
      case 'Read':
        return (
          `${C.dim}path:${C.reset} ${input.file_path}` +
          (input.offset ? ` ${C.dim}offset:${C.reset} ${input.offset}` : '') +
          (input.limit ? ` ${C.dim}limit:${C.reset} ${input.limit}` : '')
        );
      case 'Write':
        return `${C.dim}path:${C.reset} ${input.file_path} ${C.dim}(${String(input.content ?? '').length} chars)${C.reset}`;
      case 'Edit': {
        const old = String(input.old_string ?? '')
          .slice(0, 60)
          .replace(/\n/g, '↵');
        const _new = String(input.new_string ?? '')
          .slice(0, 60)
          .replace(/\n/g, '↵');
        return (
          `${C.dim}path:${C.reset} ${input.file_path}\n` +
          `${C.red}- ${old}${C.reset}\n` +
          `${C.green}+ ${_new}${C.reset}`
        );
      }
      case 'Glob':
        return (
          `${C.dim}pattern:${C.reset} ${input.pattern}` +
          (input.path ? ` ${C.dim}in:${C.reset} ${input.path}` : '')
        );
      case 'Grep':
        return (
          `${C.dim}pattern:${C.reset} /${input.pattern}/` +
          (input.path ? ` ${C.dim}in:${C.reset} ${input.path}` : '') +
          (input.glob ? ` ${C.dim}glob:${C.reset} ${input.glob}` : '')
        );
      case 'Task':
        return `${C.dim}type:${C.reset} ${input.subagent_type}\n${C.dim}prompt:${C.reset} ${String(input.prompt ?? '').slice(0, 100)}`;
      case 'WebSearch':
        return `${C.dim}query:${C.reset} ${input.query}`;
      case 'WebFetch':
        return `${C.dim}url:${C.reset} ${input.url}`;
      default: {
        // Generic: show key-value pairs
        const entries = Object.entries(input).slice(0, 5);
        return entries
          .map(([k, v]) => {
            const val =
              typeof v === 'string' ? v.slice(0, 80) : JSON.stringify(v).slice(0, 80);
            return `${C.dim}${k}:${C.reset} ${val}`;
          })
          .join('\n');
      }
    }
  }

  // ── Tool result summary ───────────────────────────────────────────
  private summarizeToolResult(toolName: string, result: unknown): string {
    if (typeof result === 'string') {
      // Truncate long results
      if (result.length > 120) return result.slice(0, 120) + '…';
      return result;
    }
    const r = result as Record<string, any>;
    switch (toolName) {
      case 'Read':
        return `Read ${r?.file?.filePath ?? 'file'} (${r?.file?.numLines ?? '?'} lines)`;
      case 'Write':
        return `Wrote ${r?.filePath ?? 'file'}`;
      case 'Edit':
        return `Edited ${r?.filePath ?? 'file'} (${r?.replacements ?? 1} replacement${(r?.replacements ?? 1) > 1 ? 's' : ''})`;
      case 'Bash':
        return (r?.stdout as string | undefined)?.slice(0, 100)?.split('\n')[0] ?? '(no output)';
      case 'Glob':
        return `Found ${r?.numFiles ?? 0} files`;
      case 'Grep':
        return `Found ${r?.numFiles ?? 0} matches`;
      default:
        return JSON.stringify(result).slice(0, 120);
    }
  }
}

// Export for use by other modules
export { renderMarkdown, C as ANSI_COLORS };
