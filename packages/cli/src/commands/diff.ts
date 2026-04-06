import type { SlashCommand } from './index.js';

export const diffCommand: SlashCommand = {
  name: 'diff',
  description: 'Show git diff of changes made in this session',
  async execute(_args, ctx) {
    try {
      const proc = Bun.spawn(['git', 'diff', '--stat'], { cwd: ctx.cwd, stdout: 'pipe', stderr: 'pipe' });
      const output = await new Response(proc.stdout).text();
      return { output: output.trim() || 'No changes detected.' };
    } catch {
      return { output: 'Not a git repository or git not available.' };
    }
  },
};
