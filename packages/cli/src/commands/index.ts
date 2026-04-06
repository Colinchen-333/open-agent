/**
 * Extended slash command registry.
 * Each command exports: { name, description, execute(args, context) }
 */

export interface CommandContext {
  cwd: string;
  sessionId: string;
  model?: string;
  permissionMode?: string;
}

export interface CommandResult {
  output: string;
  exitCode?: number;
}

export interface SlashCommand {
  name: string;
  aliases?: string[];
  description: string;
  usage?: string;
  execute(args: string, context: CommandContext): Promise<CommandResult>;
}

// Import all commands
import { costCommand } from './cost.js';
import { statsCommand } from './stats.js';
import { configCommand } from './config.js';
import { diffCommand } from './diff.js';
import { statusCommand } from './status.js';
import { memoryCommand } from './memory.js';
import { sessionsCommand } from './sessions.js';
import { permissionsCommand } from './permissions.js';
import { modelsCommand } from './models.js';
import { clearCommand } from './clear.js';
import { exportCommand } from './export.js';
import { versionCommand } from './version.js';

export const EXTENDED_COMMANDS: SlashCommand[] = [
  costCommand,
  statsCommand,
  configCommand,
  diffCommand,
  statusCommand,
  memoryCommand,
  sessionsCommand,
  permissionsCommand,
  modelsCommand,
  clearCommand,
  exportCommand,
  versionCommand,
];

/** Find a command by name or alias */
export function findCommand(name: string): SlashCommand | null {
  const lower = name.toLowerCase();
  return EXTENDED_COMMANDS.find(c =>
    c.name === lower || c.aliases?.includes(lower),
  ) ?? null;
}
