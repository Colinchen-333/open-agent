import type { StreamEvent } from '@open-agent/providers';

// ANSI escape codes
const COLORS = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
} as const;

export class TerminalRenderer {
  private inThinking = false;
  private inToolUse = false;
  private currentToolName = '';

  renderStreamEvent(event: StreamEvent): void {
    switch (event.type) {
      case 'text_delta': {
        // Close any open thinking block before emitting regular text.
        if (this.inThinking) {
          process.stdout.write(COLORS.reset + '\n');
          this.inThinking = false;
        }
        process.stdout.write(event.text);
        break;
      }

      case 'thinking_delta': {
        if (!this.inThinking) {
          process.stdout.write(COLORS.dim + '💭 ');
          this.inThinking = true;
        }
        process.stdout.write(COLORS.dim + event.thinking);
        break;
      }

      case 'tool_use_start': {
        if (this.inThinking) {
          process.stdout.write(COLORS.reset + '\n');
          this.inThinking = false;
        }
        this.currentToolName = event.name;
        this.inToolUse = true;
        process.stdout.write(`\n${COLORS.cyan}⚡ ${event.name}${COLORS.reset} `);
        break;
      }

      case 'tool_use_end': {
        if (this.inToolUse) {
          process.stdout.write('\n');
          this.inToolUse = false;
        }
        break;
      }

      case 'error': {
        process.stderr.write(
          `${COLORS.red}Error: ${JSON.stringify(event.error)}${COLORS.reset}\n`,
        );
        break;
      }

      // Other events (message_start, message_end, content_block_*, tool_use_delta)
      // carry no displayable content for a human-readable stream, so they are
      // intentionally left unhandled here.
    }
  }

  renderToolResult(toolName: string, result: unknown, isError: boolean): void {
    if (isError) {
      const detail =
        typeof result === 'string' ? result : JSON.stringify(result).slice(0, 200);
      process.stdout.write(
        `${COLORS.red}  ✗ ${toolName} failed: ${detail}${COLORS.reset}\n`,
      );
    } else {
      const summary = this.summarizeToolResult(toolName, result);
      process.stdout.write(`${COLORS.green}  ✓ ${summary}${COLORS.reset}\n`);
    }
  }

  private summarizeToolResult(toolName: string, result: unknown): string {
    if (typeof result === 'string') return result.slice(0, 100);
    const r = result as Record<string, any>;
    switch (toolName) {
      case 'Read':
        return `Read ${r?.file?.filePath ?? 'file'} (${r?.file?.numLines ?? '?'} lines)`;
      case 'Write':
        return `Wrote ${r?.filePath ?? 'file'}`;
      case 'Edit':
        return `Edited ${r?.filePath ?? 'file'}`;
      case 'Bash':
        return (r?.stdout as string | undefined)?.slice(0, 80) ?? '(no output)';
      case 'Glob':
        return `Found ${r?.numFiles ?? 0} files`;
      case 'Grep':
        return `Found ${r?.numFiles ?? 0} matches`;
      default:
        return JSON.stringify(result).slice(0, 100);
    }
  }

  renderResult(result: Record<string, any>): void {
    process.stdout.write('\n');
    if (result.is_error) {
      const detail =
        Array.isArray(result.errors) ? result.errors.join(', ') : result.subtype;
      process.stdout.write(
        `${COLORS.red}Session ended with error: ${detail}${COLORS.reset}\n`,
      );
    }
    const usage = result.usage as Record<string, number> | undefined;
    if (usage) {
      process.stdout.write(
        `${COLORS.dim}Tokens: ${usage.input_tokens ?? 0} in / ${usage.output_tokens ?? 0} out` +
          ` | Turns: ${result.num_turns} | ${result.duration_ms}ms${COLORS.reset}\n`,
      );
    }
  }

  renderWelcome(model: string): void {
    process.stdout.write(
      `${COLORS.bold}OpenAgent${COLORS.reset} ${COLORS.dim}(${model})${COLORS.reset}\n`,
    );
    process.stdout.write(
      `${COLORS.dim}Type your message. Press Ctrl+C to interrupt, Ctrl+D to exit.${COLORS.reset}\n\n`,
    );
  }
}
