import type { SlashCommand } from './index.js';

export const memoryCommand: SlashCommand = {
  name: 'memory',
  description: 'View or manage session memory entries',
  usage: '/memory [list|set <key> <value>|delete <key>]',
  async execute(args) {
    if (!args.trim() || args.trim() === 'list') {
      return { output: 'Session memory: (use SessionMemory API to manage entries)' };
    }
    return { output: `Memory command: ${args}` };
  },
};
