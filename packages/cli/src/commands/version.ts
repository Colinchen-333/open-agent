import type { SlashCommand } from './index.js';
export const versionCommand: SlashCommand = {
  name: 'version',
  description: 'Show OpenAgent version',
  async execute() {
    return { output: `open-agent v0.1.0 (Bun ${typeof Bun !== 'undefined' ? Bun.version : 'N/A'})` };
  },
};
