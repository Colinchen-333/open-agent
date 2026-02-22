import * as readline from 'readline/promises';
import type { PermissionPrompter } from '@open-agent/core';

export class TerminalPermissionPrompter implements PermissionPrompter {
  async prompt(request: {
    toolName: string;
    input: any;
    reason?: string;
  }): Promise<'allow' | 'deny' | 'always'> {
    const summary = this.summarizeInput(request.toolName, request.input);
    const reason = request.reason ? ` (${request.reason})` : '';

    process.stdout.write(
      `\n\x1b[33mPermission required: \x1b[1m${request.toolName}\x1b[0m${reason}\n`,
    );
    process.stdout.write(`\x1b[90m  ${summary}\x1b[0m\n`);
    process.stdout.write(`\x1b[33m  Allow? [y]es / [n]o / [a]lways: \x1b[0m`);

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = await rl.question('');
      const lower = answer.trim().toLowerCase();
      if (lower === 'a' || lower === 'always') return 'always';
      if (lower === 'y' || lower === 'yes' || lower === '') return 'allow';
      return 'deny';
    } finally {
      rl.close();
    }
  }

  private summarizeInput(toolName: string, input: any): string {
    if (!input) return '';
    switch (toolName) {
      case 'Bash':
        return `$ ${String(input.command ?? '').slice(0, 200)}`;
      case 'Read':
        return `${input.file_path ?? ''}`;
      case 'Write':
        return `${input.file_path ?? ''} (${String(input.content ?? '').length} chars)`;
      case 'Edit':
        return `${input.file_path ?? ''}: "${String(input.old_string ?? '').slice(0, 50)}..." -> "${String(input.new_string ?? '').slice(0, 50)}..."`;
      case 'Glob':
        return `${input.pattern ?? ''}`;
      case 'Grep':
        return `/${input.pattern ?? ''}/`;
      default:
        return JSON.stringify(input).slice(0, 200);
    }
  }
}
