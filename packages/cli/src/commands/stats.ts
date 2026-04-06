import type { SlashCommand } from './index.js';

export const statsCommand: SlashCommand = {
  name: 'stats',
  description: 'Show session statistics (turns, tokens, tools used)',
  async execute(_args, ctx) {
    return { output: `Session ${ctx.sessionId} — use getTokenUsage() for detailed stats` };
  },
};
