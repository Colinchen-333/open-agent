import type { SlashCommand } from './index.js';
export const modelsCommand: SlashCommand = {
  name: 'models',
  aliases: ['model'],
  description: 'List available models or switch model',
  async execute(args, ctx) {
    if (!args.trim()) {
      return { output: `Current model: ${ctx.model ?? 'not set'}\nAvailable: claude-sonnet-4, claude-opus-4, gpt-4o, gpt-4o-mini, o3` };
    }
    return { output: `Model switch to "${args.trim()}" — set via CLI --model flag or provider config.` };
  },
};
