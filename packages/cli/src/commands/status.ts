import type { SlashCommand } from './index.js';

export const statusCommand: SlashCommand = {
  name: 'status',
  description: 'Show system and session status',
  async execute(_args, ctx) {
    const lines = [
      `Session: ${ctx.sessionId}`,
      `CWD: ${ctx.cwd}`,
      `Model: ${ctx.model ?? 'not set'}`,
      `Permission mode: ${ctx.permissionMode ?? 'default'}`,
      `Platform: ${process.platform} ${process.arch}`,
      `Bun: ${typeof Bun !== 'undefined' ? Bun.version : 'N/A'}`,
      `Memory: ${Math.round(process.memoryUsage().heapUsed / 1048576)}MB heap`,
    ];
    return { output: lines.join('\n') };
  },
};
