import type { SlashCommand } from './index.js';
export const exportCommand: SlashCommand = {
  name: 'export',
  description: 'Export session transcript as JSON or markdown',
  usage: '/export [json|md] [path]',
  async execute(args) {
    const format = args.trim().split(/\s+/)[0] || 'json';
    return { output: `Export as ${format}: use SessionManager.exportSession() API` };
  },
};
