import type { ConversationLoop, FileCheckpoint, SessionManager } from '@open-agent/core';

export interface SlashCommandContext {
  loop: ConversationLoop;
  cwd: string;
  model: string;
  sessionId: string;
  /** Names of all registered tools available to the agent. */
  tools?: string[];
  /** File checkpoint instance for /rewind support. */
  checkpoint?: FileCheckpoint;
  /** Session manager for /sessions listing. */
  sessionMgr?: SessionManager;
  /** Current effective permission mode. */
  permissionMode?: string;
  /** Current thinking mode. */
  thinking?: string;
  /** Current effort level. */
  effort?: string;
  /** Available agent types with descriptions. */
  agentTypes?: { name: string; description: string }[];
  /** MCP server status. */
  mcpStatus?: { name: string; status: string }[];
  /** Permission engine instance for detailed rule display. */
  permissionEngine?: {
    getSummary(): {
      mode: string;
      allowRules: { toolName: string; ruleContent?: string }[];
      denyRules: { toolName: string; ruleContent?: string }[];
      askRules: { toolName: string; ruleContent?: string }[];
      allowedPaths: string[];
      deniedPaths: string[];
    };
    setMode(mode: string): void;
  };
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
    handler: async (_args, ctx) => {
      await ctx.loop.compact();
      return { handled: true, output: 'Conversation history compacted.' };
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
      const output = [
        'Available commands:',
        '',
        '  Session',
        '    /status          Show session status',
        '    /sessions        List recent sessions',
        '    /cost            Show session cost',
        '    /compact         Compact conversation history',
        '    /rewind [n]      Rewind file changes',
        '',
        '  Tools & Config',
        '    /tools           List registered tools',
        '    /model [name]    Show or change model',
        '    /thinking [mode] Show or change thinking (adaptive/enabled/disabled)',
        '    /effort [level]  Show or change effort (low/medium/high/max)',
        '    /config          Show current configuration',
        '    /permissions     Show permission mode and rules',
        '    /memory          Show auto-memory status',
        '    /agents          List available agent types',
        '    /mcp             Show MCP server status',
        '',
        '  General',
        '    /help            Show this help',
        '    /clear           Clear the terminal',
        '    /exit, /quit     Exit the REPL',
      ].join('\n');
      return { handled: true, output };
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
  '/sessions': {
    description: 'List recent sessions for the current directory',
    handler: async (_args, ctx) => {
      const sessions = ctx.sessionMgr?.listSessions(ctx.cwd) ?? [];
      if (sessions.length === 0) return { handled: true, output: 'No sessions found.' };
      const lines = sessions.slice(0, 10).map((s, i) =>
        `  ${i + 1}. ${s.id.slice(0, 8)}… | ${s.model} | ${new Date(s.lastActiveAt).toLocaleString()}`
      );
      return {
        handled: true,
        output: `Recent sessions:\n${lines.join('\n')}\n\nUse --resume <id> to resume.`,
      };
    },
  },
  '/config': {
    description: 'Show current effective configuration',
    handler: async (_args, ctx) => {
      const lines = [
        `  Model:           ${ctx.model}`,
        `  Permission mode: ${ctx.permissionMode ?? 'default'}`,
        `  Thinking:        ${ctx.thinking ?? 'adaptive'}`,
        `  Effort:          ${ctx.effort ?? 'high'}`,
        `  CWD:             ${ctx.cwd}`,
        `  Session:         ${ctx.sessionId}`,
      ];
      return { handled: true, output: `Current configuration:\n${lines.join('\n')}` };
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
    description: 'Show current permission mode and rules',
    handler: async (_args, ctx) => {
      const lines: string[] = [];

      if (ctx.permissionEngine) {
        const summary = ctx.permissionEngine.getSummary();
        lines.push(`Permission mode: ${summary.mode}`);
        lines.push('');

        const formatRule = (r: { toolName: string; ruleContent?: string }) =>
          r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName;

        if (summary.allowRules.length > 0) {
          lines.push('Allow rules:');
          for (const r of summary.allowRules) lines.push(`  + ${formatRule(r)}`);
          lines.push('');
        }
        if (summary.denyRules.length > 0) {
          lines.push('Deny rules:');
          for (const r of summary.denyRules) lines.push(`  - ${formatRule(r)}`);
          lines.push('');
        }
        if (summary.askRules.length > 0) {
          lines.push('Ask rules:');
          for (const r of summary.askRules) lines.push(`  ? ${formatRule(r)}`);
          lines.push('');
        }
        if (summary.allowedPaths.length > 0) {
          lines.push('Allowed paths:');
          for (const p of summary.allowedPaths) lines.push(`  ${p}`);
          lines.push('');
        }
        if (summary.deniedPaths.length > 0) {
          lines.push('Denied paths:');
          for (const p of summary.deniedPaths) lines.push(`  ${p}`);
          lines.push('');
        }
        if (
          summary.allowRules.length === 0 &&
          summary.denyRules.length === 0 &&
          summary.askRules.length === 0 &&
          summary.allowedPaths.length === 0 &&
          summary.deniedPaths.length === 0
        ) {
          lines.push('No custom rules configured.');
          lines.push('');
        }
      } else {
        lines.push(`Permission mode: ${ctx.permissionMode ?? 'default'}`);
        lines.push('');
      }

      lines.push('Modes:');
      lines.push('  default           Ask for dangerous operations');
      lines.push('  acceptEdits       Auto-accept file edits');
      lines.push('  bypassPermissions Skip all permission checks');
      lines.push('  plan              Read-only planning mode');
      lines.push('  dontAsk           Deny unpermitted, never prompt');
      lines.push('');
      lines.push('Use --permission-mode <mode> to change.');

      return { handled: true, output: lines.join('\n') };
    },
  },
  '/thinking': {
    description: 'Show or change thinking mode (adaptive/enabled/disabled)',
    handler: async (args, ctx) => {
      if (!args.trim()) {
        return { handled: true, output: `Current thinking: ${ctx.thinking ?? 'adaptive'}` };
      }
      const mode = args.trim().toLowerCase();
      if (!['adaptive', 'enabled', 'disabled'].includes(mode)) {
        return { handled: true, output: 'Invalid mode. Use: adaptive, enabled, disabled' };
      }
      ctx.loop.setThinking({ type: mode as 'adaptive' | 'enabled' | 'disabled' });
      return { handled: true, output: `Thinking set to: ${mode}` };
    },
  },
  '/effort': {
    description: 'Show or change effort level (low/medium/high/max)',
    handler: async (args, ctx) => {
      if (!args.trim()) {
        return { handled: true, output: `Current effort: ${ctx.effort ?? 'high'}` };
      }
      const level = args.trim().toLowerCase();
      if (!['low', 'medium', 'high', 'max'].includes(level)) {
        return { handled: true, output: 'Invalid level. Use: low, medium, high, max' };
      }
      // Effort is set on the loop options for the next LLM call.
      ctx.loop.setEffort(level as 'low' | 'medium' | 'high' | 'max');
      return { handled: true, output: `Effort set to: ${level}` };
    },
  },
  '/agents': {
    description: 'List available agent types',
    handler: async (_args, ctx) => {
      const agents = ctx.agentTypes ?? [];
      if (agents.length === 0) {
        return { handled: true, output: 'No agent types loaded.' };
      }
      const lines = agents.map((a) => `  ${a.name.padEnd(28)} ${a.description.slice(0, 50)}`);
      return {
        handled: true,
        output: `Available agent types (${agents.length}):\n${lines.join('\n')}`,
      };
    },
  },
  '/mcp': {
    description: 'Show MCP server connection status',
    handler: async (_args, ctx) => {
      const servers = ctx.mcpStatus ?? [];
      if (servers.length === 0) {
        return { handled: true, output: 'No MCP servers configured.' };
      }
      const lines = servers.map((s) => `  ${s.name.padEnd(24)} ${s.status}`);
      return {
        handled: true,
        output: `MCP servers (${servers.length}):\n${lines.join('\n')}`,
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
  '/rewind': {
    description: 'List checkpoints or restore a prior file state (/rewind <number>)',
    handler: async (args, ctx) => {
      const checkpoints = ctx.checkpoint?.list() ?? [];
      if (checkpoints.length === 0) {
        return { handled: true, output: 'No checkpoints available.' };
      }

      const n = args.trim() ? parseInt(args.trim(), 10) : NaN;

      // No argument — list available checkpoints.
      if (isNaN(n)) {
        const lines = checkpoints.map((cp, i) =>
          `  ${i + 1}. [${cp.toolUseId.slice(0, 8)}] ${cp.filePath} (${new Date(cp.timestamp).toLocaleTimeString()})`,
        );
        return {
          handled: true,
          output: `Checkpoints:\n${lines.join('\n')}\n\nUse /rewind <number> to restore.`,
        };
      }

      // Argument provided — restore to the selected checkpoint.
      if (n < 1 || n > checkpoints.length) {
        return {
          handled: true,
          output: `Invalid checkpoint number. Must be between 1 and ${checkpoints.length}.`,
        };
      }

      const target = checkpoints[n - 1];
      const { restored, errors } = ctx.checkpoint!.rewindTo(target.toolUseId);

      const lines: string[] = [];
      if (restored.length > 0) {
        lines.push(`Restored ${restored.length} file(s):`);
        for (const f of restored) lines.push(`  - ${f}`);
      }
      if (errors.length > 0) {
        lines.push(`Errors (${errors.length}):`);
        for (const e of errors) lines.push(`  - ${e}`);
      }
      if (lines.length === 0) {
        lines.push('Nothing to restore.');
      }

      return { handled: true, output: lines.join('\n') };
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
