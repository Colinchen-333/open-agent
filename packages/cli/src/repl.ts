import * as readline from 'readline/promises';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const ESC = '\x1b';
const C = {
  reset: `${ESC}[0m`,
  bold: `${ESC}[1m`,
  dim: `${ESC}[2m`,
  cyan: `${ESC}[36m`,
  gray: `${ESC}[90m`,
  white: `${ESC}[37m`,
};

const HISTORY_FILE = join(homedir(), '.open-agent', 'history');
const MAX_HISTORY_ENTRIES = 500;

export class REPL {
  private rl: readline.Interface;
  private model: string;
  private history: string[] = [];

  constructor(modelName: string) {
    this.model = modelName;

    // Load persisted history from disk.
    this.history = this.loadHistory();

    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
      prompt: this.getPrompt(),
      historySize: MAX_HISTORY_ENTRIES,
      history: this.history.slice().reverse(), // readline expects newest-first
    });

    // Prevent readline from swallowing Ctrl+C — let the SIGINT handler in
    // apps/cli/src/index.ts deal with it instead.
    this.rl.on('SIGINT', () => {
      process.emit('SIGINT');
    });
  }

  /** Load history from ~/.open-agent/history, one entry per line. */
  private loadHistory(): string[] {
    try {
      if (existsSync(HISTORY_FILE)) {
        return readFileSync(HISTORY_FILE, 'utf-8')
          .split('\n')
          .filter(l => l.length > 0)
          .slice(-MAX_HISTORY_ENTRIES);
      }
    } catch {
      // Non-fatal — start with empty history.
    }
    return [];
  }

  /** Persist history to disk. Called on close and after each input. */
  private saveHistory(): void {
    try {
      const dir = join(homedir(), '.open-agent');
      mkdirSync(dir, { recursive: true });
      const entries = this.history.slice(-MAX_HISTORY_ENTRIES);
      writeFileSync(HISTORY_FILE, entries.join('\n') + '\n');
    } catch {
      // Non-fatal — history persistence failure is not critical.
    }
  }

  private getPrompt(): string {
    return `${C.cyan}${C.bold}>${C.reset} `;
  }

  /**
   * Read user input, supporting multi-line with backslash continuation.
   * Returns trimmed input, or null on EOF.
   */
  async getInput(): Promise<string | null> {
    try {
      const line = await this.rl.question(this.getPrompt());
      if (line === undefined) return null;

      let input = line;

      // Support multi-line with trailing backslash
      while (input.endsWith('\\')) {
        input = input.slice(0, -1) + '\n';
        const continuation = await this.rl.question(`${C.gray}…${C.reset} `);
        if (continuation === undefined) break;
        input += continuation;
      }

      const trimmed = input.trim();
      // Return '' for blank/whitespace-only input so the caller can `continue`
      // the loop.  null is reserved exclusively for EOF (Ctrl+D).
      if (!trimmed) return '';

      // Add to history, avoiding consecutive duplicates
      if (trimmed && (this.history.length === 0 || this.history[this.history.length - 1] !== trimmed)) {
        this.history.push(trimmed);
        this.saveHistory();
      }

      return trimmed;
    } catch {
      // readline throws (or rejects) when stdin reaches EOF.
      return null;
    }
  }

  /**
   * Display a subtle separator between turns.
   */
  renderTurnSeparator(): void {
    process.stdout.write(`\n${C.dim}${C.gray}${'─'.repeat(Math.min(process.stdout.columns ?? 80, 60))}${C.reset}\n\n`);
  }

  setModel(model: string): void {
    this.model = model;
  }

  close(): void {
    this.saveHistory();
    this.rl.close();
  }
}
