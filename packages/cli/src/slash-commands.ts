import type { ConversationLoop } from '@open-agent/core';

export interface SlashCommandContext {
  loop: ConversationLoop;
  cwd: string;
  model: string;
  sessionId: string;
}

export interface SlashCommandResult {
  handled: boolean;
  output?: string;
  shouldExit?: boolean;
  shouldClear?: boolean;
}

const SLASH_COMMANDS: Record<
  string,
  {
    description: string;
    handler: (args: string, ctx: SlashCommandContext) => Promise<SlashCommandResult>;
  }
> = {
  '/exit': {
    description: 'Exit the REPL',
    handler: async () => ({ handled: true, shouldExit: true }),
  },
  '/quit': {
    description: 'Exit the REPL',
    handler: async () => ({ handled: true, shouldExit: true }),
  },
  '/clear': {
    description: 'Clear the terminal screen',
    handler: async () => ({ handled: true, shouldClear: true }),
  },
  '/compact': {
    description: 'Compact conversation history to save context',
    handler: async (_args, _ctx) => {
      return { handled: true, output: 'Compacting conversation history...' };
    },
  },
  '/model': {
    description: 'Show or change the current model',
    handler: async (args, ctx) => {
      if (!args.trim()) {
        return { handled: true, output: `Current model: ${ctx.model}` };
      }
      ctx.loop.setModel(args.trim());
      return { handled: true, output: `Model changed to: ${args.trim()}` };
    },
  },
  '/help': {
    description: 'Show available slash commands',
    handler: async () => {
      const lines = Object.entries(SLASH_COMMANDS)
        .filter(([name]) => name !== '/quit') // dedupe quit/exit
        .map(([name, cmd]) => `  ${name.padEnd(12)} ${cmd.description}`);
      return {
        handled: true,
        output: `Available commands:\n${lines.join('\n')}`,
      };
    },
  },
  '/status': {
    description: 'Show session status',
    handler: async (_args, ctx) => {
      const turns = ctx.loop.getTurnCount();
      return {
        handled: true,
        output: `Session: ${ctx.sessionId}\nModel: ${ctx.model}\nTurns: ${turns}\nCWD: ${ctx.cwd}`,
      };
    },
  },
  '/memory': {
    description: 'Show auto-memory status',
    handler: async (_args, ctx) => {
      const { AutoMemory } = await import('@open-agent/core');
      const memory = new AutoMemory(ctx.cwd);
      const content = memory.readMemory();
      const topics = memory.listTopics();

      if (!content && topics.length === 0) {
        return {
          handled: true,
          output: 'No memory saved yet. Memory is stored at: ' + memory.getDir(),
        };
      }

      let output = `Memory directory: ${memory.getDir()}\n`;
      output += `MEMORY.md: ${content ? `${content.split('\n').length} lines` : 'empty'}\n`;
      if (topics.length > 0) {
        output += `Topics: ${topics.join(', ')}`;
      }
      return { handled: true, output };
    },
  },
  '/permissions': {
    description: 'Show current permission mode',
    handler: async (_args, _ctx) => {
      return {
        handled: true,
        output: 'Permission mode management is handled via --permission-mode flag.',
      };
    },
  },
};

/**
 * Try to handle a user input as a slash command.
 * Returns null if the input is not a slash command.
 */
export async function handleSlashCommand(
  input: string,
  ctx: SlashCommandContext,
): Promise<SlashCommandResult | null> {
  if (!input.startsWith('/')) return null;

  const spaceIdx = input.indexOf(' ');
  const cmdName = spaceIdx === -1 ? input : input.slice(0, spaceIdx);
  const args = spaceIdx === -1 ? '' : input.slice(spaceIdx + 1);

  const cmd = SLASH_COMMANDS[cmdName];
  if (!cmd) {
    return {
      handled: true,
      output: `Unknown command: ${cmdName}. Type /help for available commands.`,
    };
  }

  return cmd.handler(args, ctx);
}

export function getSlashCommands(): { name: string; description: string }[] {
  return Object.entries(SLASH_COMMANDS).map(([name, cmd]) => ({
    name,
    description: cmd.description,
  }));
}
