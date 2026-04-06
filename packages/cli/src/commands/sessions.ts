import type { SlashCommand } from './index.js';

export const sessionsCommand: SlashCommand = {
  name: 'sessions',
  aliases: ['session'],
  description: 'List or manage sessions',
  async execute(_args) {
    return { output: 'Sessions listing: use /resume to pick a session, or SessionManager.listSessions()' };
  },
};
