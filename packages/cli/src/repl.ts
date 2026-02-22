import * as readline from 'readline/promises';

export class REPL {
  private rl: readline.Interface;
  private promptText: string;

  constructor(modelName: string) {
    // Use a short model name fragment to keep the prompt tidy.
    const shortName = modelName.split('/').pop() ?? modelName;
    this.promptText = `${shortName} > `;
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });

    // Prevent readline from swallowing Ctrl+C — let the SIGINT handler in
    // apps/cli/src/index.ts deal with it instead.
    this.rl.on('SIGINT', () => {
      process.emit('SIGINT');
    });
  }

  /**
   * Read one line of user input.
   * Returns the trimmed input string, or `null` on EOF (Ctrl+D).
   */
  async getInput(): Promise<string | null> {
    try {
      const line = await this.rl.question(this.promptText);
      return line.trim() || null;
    } catch {
      // readline throws (or rejects) when stdin reaches EOF.
      return null;
    }
  }

  close(): void {
    this.rl.close();
  }
}
