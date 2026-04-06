import type { SlashCommand } from './index.js';
export const clearCommand: SlashCommand = {
  name: 'clear',
  description: 'Clear the terminal screen',
  async execute() {
    process.stdout.write('\x1b[2J\x1b[H');
    return { output: '' };
  },
};
