import type { ConversationLoop } from '@open-agent/core';

export interface SlashCommandContext {
  loop: ConversationLoop;
  cwd: string;
  model: string;
  sessionId: string;
  /** Names of all registered tools available to the agent. */
  tools?: string[];
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
  '/cost': {
    description: 'Show cumulative cost and token usage for this session',
    handler: async (_args, ctx) => {
      const { totalCostUsd, totalInputTokens, totalOutputTokens } = ctx.loop.getTotalCost();
      const totalTokens = totalInputTokens + totalOutputTokens;
      const costStr = totalCostUsd > 0
        ? `$${totalCostUsd.toFixed(6)}`
        : '$0.000000';
      return {
        handled: true,
        output: [
          'Session cost:',
          `  Total cost:     ${costStr}`,
          `  Input tokens:   ${totalInputTokens.toLocaleString()}`,
          `  Output tokens:  ${totalOutputTokens.toLocaleString()}`,
          `  Total tokens:   ${totalTokens.toLocaleString()}`,
        ].join('\n'),
      };
    },
  },
  '/tools': {
    description: 'List all registered tools available to the agent',
    handler: async (_args, ctx) => {
      const tools = ctx.tools ?? [];
      if (tools.length === 0) {
        return { handled: true, output: 'No tools registered.' };
      }
      const lines = tools.map((name, i) => `  ${String(i + 1).padStart(2)}. ${name}`);
      return {
        handled: true,
        output: `Registered tools (${tools.length}):\n${lines.join('\n')}`,
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
