import type { SlashCommand } from './index.js';

export const configCommand: SlashCommand = {
  name: 'config',
  aliases: ['settings'],
  description: 'View or modify configuration',
  usage: '/config [key] [value]',
  async execute(args, ctx) {
    if (!args.trim()) {
      return { output: `Current config:\n  cwd: ${ctx.cwd}\n  model: ${ctx.model}\n  mode: ${ctx.permissionMode}` };
    }
    return { output: `Config modification via CLI coming soon. Edit ~/.claude/settings.json directly.` };
  },
};
