import type { SlashCommand } from './index.js';
export const permissionsCommand: SlashCommand = {
  name: 'permissions',
  aliases: ['perms'],
  description: 'View current permission rules and mode',
  async execute(_args, ctx) {
    return { output: `Permission mode: ${ctx.permissionMode ?? 'default'}\nUse the PermissionEngine API to view/modify rules.` };
  },
};
