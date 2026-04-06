import type { SlashCommand, CommandContext, CommandResult } from './index.js';

export const costCommand: SlashCommand = {
  name: 'cost',
  description: 'Show token usage and estimated cost for this session',
  async execute(_args: string, ctx: CommandContext): Promise<CommandResult> {
    return {
      output: [
        `Session: ${ctx.sessionId}`,
        `Model: ${ctx.model ?? 'unknown'}`,
        '(Token tracking available via getTokenUsage() on ConversationLoop)',
        'Use /stats for detailed breakdown.',
      ].join('\n'),
    };
  },
};
