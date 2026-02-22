import * as readline from 'readline/promises';
import type { PermissionPrompter } from '@open-agent/core';

const ESC = '\x1b';
const C = {
  reset: `${ESC}[0m`,
  bold: `${ESC}[1m`,
  dim: `${ESC}[2m`,
  italic: `${ESC}[3m`,
  red: `${ESC}[31m`,
  green: `${ESC}[32m`,
  yellow: `${ESC}[33m`,
  cyan: `${ESC}[36m`,
  gray: `${ESC}[90m`,
  white: `${ESC}[37m`,
  bgYellow: `${ESC}[43m`,
  bgRed: `${ESC}[41m`,
};

const BOX = {
  topLeft: '╭',
  topRight: '╮',
  bottomLeft: '╰',
  bottomRight: '╯',
  horizontal: '─',
  vertical: '│',
};

export class TerminalPermissionPrompter implements PermissionPrompter {
  async prompt(request: {
    toolName: string;
    input: any;
    reason?: string;
  }): Promise<'allow' | 'deny' | 'always'> {
    const w = Math.min(process.stdout.columns ?? 80, 70);
    const innerW = w - 4;

    const isDangerous = this.isDangerous(request.toolName, request.input);
    const icon = isDangerous ? '⚠️ ' : '🔒';
    const dangerColor = isDangerous ? C.red : C.yellow;

    // Top border
    process.stdout.write(`\n${dangerColor}${BOX.topLeft}${BOX.horizontal.repeat(w - 2)}${BOX.topRight}${C.reset}\n`);

    // Title line
    const titleText = `${icon} Permission Required: ${C.bold}${request.toolName}${C.reset}`;
    const titleVisible = `${isDangerous ? '⚠️ ' : '🔒'} Permission Required: ${request.toolName}`;
    const titlePad = Math.max(0, innerW - titleVisible.length);
    process.stdout.write(`${dangerColor}${BOX.vertical}${C.reset} ${dangerColor}${titleText}${C.reset}${' '.repeat(titlePad)} ${dangerColor}${BOX.vertical}${C.reset}\n`);

    // Separator
    process.stdout.write(`${dangerColor}${BOX.vertical}${BOX.horizontal.repeat(w - 2)}${BOX.vertical}${C.reset}\n`);

    // Input summary lines
    const summaryLines = this.formatSummary(request.toolName, request.input);
    for (const line of summaryLines) {
      const visible = this.stripAnsi(line);
      const truncatedVisible = visible.slice(0, innerW);
      // Truncate the raw line proportionally
      const truncatedLine = visible.length > innerW ? line.slice(0, line.length - (visible.length - innerW)) : line;
      const pad = Math.max(0, innerW - truncatedVisible.length);
      process.stdout.write(`${dangerColor}${BOX.vertical}${C.reset} ${truncatedLine}${' '.repeat(pad)} ${dangerColor}${BOX.vertical}${C.reset}\n`);
    }

    // Reason (if present)
    if (request.reason) {
      process.stdout.write(`${dangerColor}${BOX.vertical}${C.reset}${' '.repeat(innerW + 2)}${dangerColor}${BOX.vertical}${C.reset}\n`);
      const reasonText = `${C.dim}Reason: ${request.reason}${C.reset}`;
      const reasonVisible = `Reason: ${request.reason}`;
      const reasonPad = Math.max(0, innerW - reasonVisible.length);
      process.stdout.write(`${dangerColor}${BOX.vertical}${C.reset} ${reasonText}${' '.repeat(reasonPad)} ${dangerColor}${BOX.vertical}${C.reset}\n`);
    }

    // Options separator
    process.stdout.write(`${dangerColor}${BOX.vertical}${BOX.horizontal.repeat(w - 2)}${BOX.vertical}${C.reset}\n`);

    // Options line
    const options = `${C.green}[y]${C.reset} Allow  ${C.red}[n]${C.reset} Deny  ${C.cyan}[a]${C.reset} Always allow ${C.dim}${request.toolName}${C.reset}`;
    const optionsVisible = `[y] Allow  [n] Deny  [a] Always allow ${request.toolName}`;
    const optionsPad = Math.max(0, innerW - optionsVisible.length);
    process.stdout.write(`${dangerColor}${BOX.vertical}${C.reset} ${options}${' '.repeat(optionsPad)} ${dangerColor}${BOX.vertical}${C.reset}\n`);

    // Bottom border
    process.stdout.write(`${dangerColor}${BOX.bottomLeft}${BOX.horizontal.repeat(w - 2)}${BOX.bottomRight}${C.reset}\n`);

    // Prompt for answer
    process.stdout.write(`${dangerColor}❯${C.reset} `);

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = await rl.question('');
      const lower = answer.trim().toLowerCase();

      if (lower === 'a' || lower === 'always') {
        process.stdout.write(`${C.cyan}  ✓ Always allowing ${request.toolName}${C.reset}\n`);
        return 'always';
      }
      if (lower === 'y' || lower === 'yes' || lower === '') {
        process.stdout.write(`${C.green}  ✓ Allowed${C.reset}\n`);
        return 'allow';
      }
      process.stdout.write(`${C.red}  ✗ Denied${C.reset}\n`);
      return 'deny';
    } finally {
      rl.close();
    }
  }

  private isDangerous(toolName: string, input: any): boolean {
    if (toolName !== 'Bash') return false;
    const cmd = String(input?.command ?? '');
    return /\b(rm|sudo|dd|chmod|mkfs|git\s+push|git\s+reset|curl.*\|.*bash)\b/.test(cmd);
  }

  private formatSummary(toolName: string, input: any): string[] {
    if (!input) return [];
    switch (toolName) {
      case 'Bash': {
        const cmd = String(input.command ?? '');
        const desc = input.description ? [`${C.dim}${input.description}${C.reset}`] : [];
        // Split long commands into multiple lines
        const cmdLines =
          cmd.length > 60
            ? [`${C.yellow}$ ${cmd.slice(0, 60)}${C.reset}`, `${C.yellow}  ${cmd.slice(60, 120)}${C.reset}`]
            : [`${C.yellow}$ ${cmd}${C.reset}`];
        return [...desc, ...cmdLines];
      }
      case 'Write':
        return [
          `${C.dim}file:${C.reset} ${input.file_path ?? ''}`,
          `${C.dim}size:${C.reset} ${String(input.content ?? '').length} characters`,
        ];
      case 'Edit':
        return [
          `${C.dim}file:${C.reset} ${input.file_path ?? ''}`,
          `${C.red}- ${String(input.old_string ?? '').slice(0, 50).replace(/\n/g, '↵')}${C.reset}`,
          `${C.green}+ ${String(input.new_string ?? '').slice(0, 50).replace(/\n/g, '↵')}${C.reset}`,
        ];
      case 'Read':
        return [`${C.dim}file:${C.reset} ${input.file_path ?? ''}`];
      default:
        return [JSON.stringify(input).slice(0, 60)];
    }
  }

  private stripAnsi(str: string): string {
    return str.replace(/\x1b\[[0-9;]*m/g, '');
  }
}
