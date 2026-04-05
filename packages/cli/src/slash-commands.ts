import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import type { ConversationLoop, FileCheckpoint, SessionManager } from '@open-agent/core';
import { loadMarkdownConfig } from '@open-agent/core';
import {
  createTaskOutputTool,
  createTaskStopTool,
  listPersistedBackgroundTasks,
  type BackgroundAgentInfo,
} from '@open-agent/tools';
import {
  buildBackgroundAgentListEntries,
  buildTaskInspection,
  formatTaskInspectionForDisplay,
  listBackgroundTasksForDisplay,
} from './task-command-helpers.js';
import {
  buildCapabilitySnapshotFromTools,
  formatCapabilitySnapshotForDisplay,
  serializeCapabilitySnapshot,
  type CapabilitySnapshot,
} from './capability-command-helpers.js';

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
  /** Available skills with descriptions and source labels. */
  skills?: { name: string; description: string; source?: string; userInvocable?: boolean }[];
  /** MCP server status. */
  mcpStatus?: { name: string; status: string }[];
  /** Tool capability snapshot, when provided by the caller. */
  capabilities?: CapabilitySnapshot;
  /** Permission engine instance for detailed rule display. */
  permissionEngine?: {
    getSummary(): {
      mode: string;
      allowRules: { toolName: string; ruleContent?: string }[];
      suspendedAllowRules: { toolName: string; ruleContent?: string }[];
      denyRules: { toolName: string; ruleContent?: string }[];
      askRules: { toolName: string; ruleContent?: string }[];
      allowedPaths: string[];
      deniedPaths: string[];
    };
    setMode(mode: string): void;
  };
  listBackgroundAgents?: () => Array<{ task_id: string; info: BackgroundAgentInfo }>;
  getBackgroundAgent?: (taskId: string) => BackgroundAgentInfo | null;
  stopBackgroundAgent?: (taskId: string) => boolean;
}

export interface SlashCommandResult {
  handled: boolean;
  output?: string;
  shouldExit?: boolean;
  shouldClear?: boolean;
}

// ---------------------------------------------------------------------------
// User slash commands — loaded from ~/.claude/commands/*.md and
// <cwd>/.claude/commands/*.md at startup (or lazily on first dispatch).
// ---------------------------------------------------------------------------

export interface UserSlashCommand {
  /** Command name without the leading `/`. */
  name: string;
  description: string;
  /** The markdown body that becomes the prompt when the command is invoked. */
  body: string;
}

/**
 * Load user-defined slash commands from:
 *   - `<home>/.claude/commands/*.md`  (user layer)
 *   - `<cwd>/.claude/commands/*.md`   (project layer, takes precedence)
 *
 * The `name` of each command is either the frontmatter `name` field or the
 * filename stem (without `.md`). When the user types `/<name>`, the body is
 * emitted as a user message to the agent loop.
 *
 * Callers should cache the returned array; this function performs file I/O on
 * every call.
 */
export async function loadUserSlashCommands(
  cwd: string,
  home?: string,
): Promise<UserSlashCommand[]> {
  const entries = await loadMarkdownConfig({ subdir: 'commands', cwd, home });
  return entries.map((entry) => {
    const fm = entry.frontmatter;
    return {
      name: (fm.name as string | undefined) ?? entry.name,
      description: (fm.description as string | undefined) ?? '',
      body: entry.body,
    };
  });
}

// Module-level cache keyed by cwd so it is populated once per project root.
const _userCommandCache = new Map<string, UserSlashCommand[]>();

async function getUserCommands(cwd: string): Promise<UserSlashCommand[]> {
  if (!_userCommandCache.has(cwd)) {
    const cmds = await loadUserSlashCommands(cwd);
    _userCommandCache.set(cwd, cmds);
  }
  return _userCommandCache.get(cwd)!;
}

/** Clear the user command cache (useful in tests). */
export function clearUserCommandCache(): void {
  _userCommandCache.clear();
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
        '    /resume [query]  Search and resume a session, with cross-project hints',
        '    /cost            Show session cost',
        '    /compact         Compact conversation history',
        '    /rewind [n]      Rewind file changes',
        '    /tasks [all]             List background tasks',
        '    /tasks session <id>      List tasks for one session',
        '    /tasks <id>              Inspect a background task',
        '    /tasks logs <id>         Show logs view with log path',
        '    /tasks attach <id> [ms]  Wait and inspect task output',
        '    /tasks stop <id>         Stop a background task',
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
        '    /skills          List available skills',
        '    /capabilities    Show tool capability layers and presets',
        '    /mcp             Show MCP server status',
        '',
        '  Git',
        '    /commit          Create a git commit with AI message',
        '    /review          Review current git diff',
        '',
        '  Project',
        '    /init            Create AGENT.md for this project',
        '    /doctor          Diagnose environment issues',
        '',
        '  Info',
        '    /insights        Session insights: turns, tokens, cost',
        '    /version         Print open-agent version',
        '    /env             Print non-sensitive environment info',
        '    /upgrade         Check for newer versions',
        '    /plugins         List loaded plugins',
        '    /workflow        Show workflow status',
        '    /keybindings     Show keybindings',
        '    /output-style [name]  List or set response output style',
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
  '/tasks': {
    description: 'List, inspect, or stop background tasks',
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      const persistedBashTasks = listPersistedBackgroundTasks().map((task) => ({
        task_id: task.taskId,
        type: 'bash' as const,
        status: task.status,
        summary: task.summary ?? task.error ?? task.status,
        session_id: task.sessionId,
        cwd: task.cwd,
        output_file: task.outputFile,
        command: task.command,
        started_at: task.startTime,
      }));
      const agentTasks = buildBackgroundAgentListEntries(ctx.listBackgroundAgents?.() ?? []);
      const allTasks = [...persistedBashTasks, ...agentTasks].sort(
        (left, right) => (right.started_at ?? 0) - (left.started_at ?? 0),
      );

      if (!trimmed) {
        const result = listBackgroundTasksForDisplay({
          tasks: allTasks,
          sessionId: ctx.sessionId,
        });
        return { handled: true, output: result.output };
      }

      const [verb, maybeTaskId, maybeTimeout] = trimmed.split(/\s+/, 3);
      if (verb === 'all') {
        const result = listBackgroundTasksForDisplay({
          tasks: allTasks,
          sessionFilter: 'all',
        });
        return { handled: true, output: result.output };
      }
      if (verb === 'session') {
        if (!maybeTaskId) {
          return { handled: true, output: 'Usage: /tasks session <session-id>' };
        }
        const result = listBackgroundTasksForDisplay({
          tasks: allTasks,
          sessionFilter: maybeTaskId,
        });
        return { handled: true, output: result.output };
      }

      if (verb === 'stop') {
        const taskId = maybeTaskId;
        if (!taskId) {
          return { handled: true, output: 'Usage: /tasks stop <task-id>' };
        }
        const stopTool = createTaskStopTool({
          getBackgroundAgent: ctx.getBackgroundAgent,
          stopBackgroundAgent: ctx.stopBackgroundAgent,
        });
        const raw = await stopTool.execute({ task_id: taskId }, {
          cwd: ctx.cwd,
          sessionId: ctx.sessionId,
        });
        return { handled: true, output: raw };
      }

      const mode = verb === 'logs' || verb === 'attach' ? verb : 'inspect';
      const taskId = mode === 'inspect' ? verb : maybeTaskId;
      if (!taskId) {
        return {
          handled: true,
          output: 'Usage: /tasks | /tasks all | /tasks session <id> | /tasks <task-id> | /tasks logs <task-id> | /tasks attach <task-id> [timeoutMs] | /tasks stop <task-id>',
        };
      }

      const parsedTimeout = Number.parseInt(mode === 'attach' ? (maybeTimeout ?? '') : '', 10);
      const timeoutMs = mode === 'attach'
        ? (Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? Math.min(parsedTimeout, 600000) : 30000)
        : 1000;

      const outputTool = createTaskOutputTool({
        getBackgroundAgent: ctx.getBackgroundAgent,
        stopBackgroundAgent: ctx.stopBackgroundAgent,
      });
      const raw = await outputTool.execute({ task_id: taskId, block: mode === 'attach', timeout: timeoutMs }, {
        cwd: ctx.cwd,
        sessionId: ctx.sessionId,
      });
      if (typeof raw === 'string' && raw.startsWith('Error: No task found')) {
        return { handled: true, output: raw };
      }

      const inspection = buildTaskInspection(raw, taskId);
      if (!inspection) {
        return { handled: true, output: raw };
      }
      return {
        handled: true,
        output: formatTaskInspectionForDisplay(
          inspection,
          { view: mode === 'inspect' ? 'inspect' : mode },
        ),
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
        if (summary.suspendedAllowRules.length > 0) {
          lines.push('Suspended allow rules:');
          for (const r of summary.suspendedAllowRules) lines.push(`  ~ ${formatRule(r)}`);
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
  '/skills': {
    description: 'List available skills',
    handler: async (_args, ctx) => {
      const allSkills = ctx.skills ?? [];
      const visibleSkills = allSkills.filter((s) => s.userInvocable !== false);
      if (visibleSkills.length === 0) {
        return { handled: true, output: 'No skills loaded.' };
      }
      const lines = visibleSkills.map((skill) =>
        `  ${skill.name.padEnd(28)} ${skill.description || '(no description)'}${skill.source ? ` [${skill.source}]` : ''}`
      );
      return {
        handled: true,
        output: `Available skills (${visibleSkills.length}):\n${lines.join('\n')}`,
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
        output: `Registered tools (${tools.length}):\n${lines.join('\n')}\n\nUse /capabilities to view layered presets.`,
      };
    },
  },
  '/capabilities': {
    description: 'Show tool capability layers and presets',
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      const snapshot = ctx.capabilities ?? buildCapabilitySnapshotFromTools(ctx.tools ?? []);

      if (trimmed.length === 0) {
        return { handled: true, output: formatCapabilitySnapshotForDisplay(snapshot) };
      }

      const [mode, maybePath] = trimmed.split(/\s+/, 2);
      if (mode === 'json') {
        return { handled: true, output: serializeCapabilitySnapshot(snapshot) };
      }
      if (mode === 'export') {
        if (!maybePath) {
          return { handled: true, output: 'Usage: /capabilities export <path>' };
        }
        mkdirSync(dirname(maybePath), { recursive: true });
        writeFileSync(maybePath, serializeCapabilitySnapshot(snapshot), 'utf-8');
        return { handled: true, output: `Wrote capability snapshot to ${maybePath}` };
      }

      return {
        handled: true,
        output: [
          'Usage: /capabilities',
          '  /capabilities json',
          '  /capabilities export <path>',
        ].join('\n'),
      };
    },
  },
  '/init': {
    description: 'Create an AGENT.md file for this project',
    handler: async (_args, ctx) => {
      const agentMdPath = join(ctx.cwd, 'AGENT.md');
      if (existsSync(agentMdPath)) {
        return { handled: true, output: `AGENT.md already exists at ${agentMdPath}` };
      }
      const template = [
        '# Agent Instructions',
        '',
        '## Project',
        '',
        '<!-- Describe this project: what it does, the tech stack, and key conventions -->',
        '',
        '## Commands',
        '',
        '<!-- Common commands the agent should know about -->',
        '<!-- Example: -->',
        '<!-- - Build: `npm run build` -->',
        '<!-- - Test: `npm test` -->',
        '<!-- - Lint: `npm run lint` -->',
        '',
        '## Code Style',
        '',
        '<!-- Describe coding conventions, naming patterns, file organization -->',
        '',
        '## Notes',
        '',
        '<!-- Any gotchas, important context, or constraints the agent should know -->',
        '',
      ].join('\n');
      writeFileSync(agentMdPath, template);
      return { handled: true, output: `Created AGENT.md at ${agentMdPath}\nEdit it to describe your project.` };
    },
  },
  '/commit': {
    description: 'Stage and commit changes with an AI-generated message',
    handler: async (_args, ctx) => {
      // Delegate to the agent loop — the system prompt already has detailed
      // commit instructions. This approach lets the LLM inspect the diff,
      // write a proper message, and handle edge cases.
      return {
        handled: false,
        output: 'Create a git commit for all the current changes. Follow the commit instructions in the system prompt.',
      };
    },
  },
  '/review': {
    description: 'Review the current git diff',
    handler: async (_args, ctx) => {
      return {
        handled: false,
        output: 'Review the current git diff (both staged and unstaged changes). Provide feedback on code quality, potential bugs, and suggestions for improvement.',
      };
    },
  },
  '/doctor': {
    description: 'Diagnose environment and configuration issues',
    handler: async (_args, ctx) => {
      const checks: string[] = [];
      // Check git
      try {
        const { execSync } = require('child_process');
        const gitVersion = execSync('git --version', { encoding: 'utf-8' }).trim();
        checks.push(`  ✓ ${gitVersion}`);
      } catch { checks.push('  ✗ git not found'); }
      // Check ripgrep
      try {
        const { execSync } = require('child_process');
        const rgVersion = execSync('rg --version', { encoding: 'utf-8' }).split('\n')[0].trim();
        checks.push(`  ✓ ${rgVersion}`);
      } catch { checks.push('  ✗ ripgrep (rg) not found — Grep tool will not work'); }
      // Check Node/Bun
      const { runtimeVersion } = await import('@open-agent/core');
      const runtimeLabel = ('Bun' in globalThis) ? `Bun ${runtimeVersion}` : `Node.js ${runtimeVersion}`;
      checks.push(`  ✓ ${runtimeLabel}`);
      checks.push(`  ✓ CWD: ${ctx.cwd}`);
      checks.push(`  ✓ Model: ${ctx.model}`);
      checks.push(`  ✓ Permission mode: ${ctx.permissionMode ?? 'default'}`);
      if (ctx.tools?.length) {
        const snapshot = ctx.capabilities ?? buildCapabilitySnapshotFromTools(ctx.tools);
        checks.push(`  ✓ Tool capability presets: ${snapshot.presets.map((preset) => `${preset.name}(${preset.toolCount})`).join(', ')}`);
      }
      return { handled: true, output: `Environment check:\n${checks.join('\n')}` };
    },
  },
  '/plugins': {
    description: 'List loaded plugins',
    handler: async (_args, ctx) => {
      // The context may carry a plugin list if the caller wires one in. For now
      // there is no plugin infrastructure, so we report a clean informational
      // message rather than a vague placeholder.
      const plugins = (ctx as unknown as Record<string, unknown>).plugins as
        | { name: string; version?: string; description?: string }[]
        | undefined;

      if (plugins && plugins.length > 0) {
        const lines = plugins.map(
          (p) =>
            `  - ${p.name}${p.version ? `@${p.version}` : ''}${p.description ? `  (${p.description})` : ''}`,
        );
        return {
          handled: true,
          output: `Plugins loaded (${plugins.length}):\n${lines.join('\n')}`,
        };
      }

      return {
        handled: true,
        output: 'Plugin system not fully wired; see Round 4 follow-up. No plugins currently loaded.',
      };
    },
  },
  '/workflow': {
    description: 'Show workflow status',
    handler: async (_args, _ctx) => {
      return {
        handled: true,
        output: 'Workflow system not yet implemented (Round 3 scope).',
      };
    },
  },
  '/keybindings': {
    description: 'Show current keybindings',
    handler: async (_args, _ctx) => {
      return {
        handled: true,
        output: 'Keybindings configuration not yet implemented (Round 3 scope).',
      };
    },
  },
  '/output-style': {
    description: 'List or set the response output style',
    handler: async (args, ctx) => {
      const name = args?.trim();
      const { loadOutputStyles, mergeOutputStyles, findOutputStyle, BUILTIN_OUTPUT_STYLES } =
        await import('@open-agent/core');
      const loaded = await loadOutputStyles(ctx.cwd);
      const all = mergeOutputStyles(loaded, BUILTIN_OUTPUT_STYLES);
      if (!name) {
        // List available styles
        const lines = ['Available output styles:'];
        for (const s of all) {
          lines.push(`  ${s.name.padEnd(12)} ${s.description}`);
        }
        return { handled: true, output: lines.join('\n') };
      }
      const picked = findOutputStyle(name, all);
      return {
        handled: true,
        output: `Output style set to: ${picked.name}\n${picked.description}`,
      };
    },
  },
  '/outputstyle': {
    description: 'Alias for /output-style',
    handler: async (args, ctx) => {
      // Delegate to /output-style handler
      const name = args?.trim();
      const { loadOutputStyles, mergeOutputStyles, findOutputStyle, BUILTIN_OUTPUT_STYLES } =
        await import('@open-agent/core');
      const loaded = await loadOutputStyles(ctx.cwd);
      const all = mergeOutputStyles(loaded, BUILTIN_OUTPUT_STYLES);
      if (!name) {
        const lines = ['Available output styles:'];
        for (const s of all) {
          lines.push(`  ${s.name.padEnd(12)} ${s.description}`);
        }
        return { handled: true, output: lines.join('\n') };
      }
      const picked = findOutputStyle(name, all);
      return {
        handled: true,
        output: `Output style set to: ${picked.name}\n${picked.description}`,
      };
    },
  },
  '/style': {
    description: 'Alias for /output-style',
    handler: async (args, ctx) => {
      const name = args?.trim();
      const { loadOutputStyles, mergeOutputStyles, findOutputStyle, BUILTIN_OUTPUT_STYLES } =
        await import('@open-agent/core');
      const loaded = await loadOutputStyles(ctx.cwd);
      const all = mergeOutputStyles(loaded, BUILTIN_OUTPUT_STYLES);
      if (!name) {
        const lines = ['Available output styles:'];
        for (const s of all) {
          lines.push(`  ${s.name.padEnd(12)} ${s.description}`);
        }
        return { handled: true, output: lines.join('\n') };
      }
      const picked = findOutputStyle(name, all);
      return {
        handled: true,
        output: `Output style set to: ${picked.name}\n${picked.description}`,
      };
    },
  },
  '/insights': {
    description: 'Show session insights: turns, token usage, cost',
    handler: async (_args, ctx) => {
      const turns = ctx.loop.getTurnCount();
      const { totalCostUsd, totalInputTokens, totalOutputTokens } = ctx.loop.getTotalCost();
      const totalTokens = totalInputTokens + totalOutputTokens;
      const costStr = totalCostUsd > 0 ? `$${totalCostUsd.toFixed(6)}` : '$0.000000';
      const lines = [
        'Session insights:',
        `  Turns:           ${turns}`,
        `  Input tokens:    ${totalInputTokens.toLocaleString()}`,
        `  Output tokens:   ${totalOutputTokens.toLocaleString()}`,
        `  Total tokens:    ${totalTokens.toLocaleString()}`,
        `  Estimated cost:  ${costStr}`,
        '',
        '  Per-tool call breakdown: not yet available (Round 3 scope).',
      ];
      return { handled: true, output: lines.join('\n') };
    },
  },
  '/upgrade': {
    description: 'Check for newer open-agent versions',
    handler: async (_args, _ctx) => {
      return {
        handled: true,
        output: 'Version check not yet implemented (Round 3 scope). Check https://github.com/Colinchen-333/open-agent for updates.',
      };
    },
  },
  '/version': {
    description: 'Print the open-agent version',
    handler: async (_args, _ctx) => {
      // Resolve version from the monorepo root package.json at runtime.
      // Strategy (in order of preference):
      //   1. ESM-safe URL resolution relative to this source file.
      //   2. Walk up from import.meta.dir (Bun) for 3–4 ancestor levels.
      //   3. Fallback to process.cwd() — works during dev but not in a bundled binary.
      let version = 'unknown';
      try {
        const { readFileSync } = await import('fs');
        const { fileURLToPath } = await import('url');
        const { join } = await import('path');

        // Build ESM-safe candidates
        const esmCandidates: string[] = [];
        try {
          // new URL relative to import.meta.url climbs the directory tree safely
          // regardless of whether the file is loaded as ESM or bundled.
          esmCandidates.push(fileURLToPath(new URL('../../../../package.json', import.meta.url)));
          esmCandidates.push(fileURLToPath(new URL('../../../package.json', import.meta.url)));
          esmCandidates.push(fileURLToPath(new URL('../../package.json', import.meta.url)));
        } catch { /* URL construction not available in this runtime */ }

        const candidates = [
          ...esmCandidates,
          // Bun-specific import.meta.dir fallbacks
          join(import.meta.dir, '../../../../package.json'),
          join(import.meta.dir, '../../../package.json'),
          join(process.cwd(), 'package.json'),
        ];

        for (const p of candidates) {
          try {
            const pkg = JSON.parse(readFileSync(p, 'utf-8'));
            if (typeof pkg.version === 'string') {
              version = pkg.version;
              break;
            }
          } catch { /* keep trying */ }
        }
      } catch { /* ignore */ }

      // Include the Bun runtime version when the version is unknown, so the
      // user still has actionable context even in a bundled binary.
      const { runtimeVersion } = await import('@open-agent/core');
      const suffix =
        version === 'unknown' && runtimeVersion
          ? ` (bun ${runtimeVersion})`
          : '';

      return { handled: true, output: `open-agent ${version}${suffix}` };
    },
  },
  '/env': {
    description: 'Print non-sensitive environment info',
    handler: async (_args, ctx) => {
      const { runtimeVersion } = await import('@open-agent/core');
      const runtime = ('Bun' in globalThis) ? `Bun ${runtimeVersion}` : `Node.js ${runtimeVersion}`;
      const lines = [
        'Environment:',
        `  CWD:       ${ctx.cwd}`,
        `  Platform:  ${process.platform}`,
        `  Runtime:   ${runtime}`,
        `  Model:     ${ctx.model}`,
        `  Provider:  ${(ctx as unknown as Record<string, unknown>).provider as string ?? 'unknown'}`,
      ];
      return { handled: true, output: lines.join('\n') };
    },
  },
  '/resume': {
    description: 'Search sessions and resume one, with cross-project hints',
    handler: async (args, ctx) => {
      const query = args?.trim() ?? '';
      const smgr = ctx.sessionMgr;
      if (!smgr) {
        return { handled: true, output: 'No session manager available.' };
      }

      // listSessions accepts a cwd; call with current cwd to get accessible sessions.
      // Each SessionInfo carries its own .cwd so cross-project detection still works.
      const sessions = smgr.listSessions(ctx.cwd);
      if (sessions.length === 0) {
        return { handled: true, output: 'No sessions found.' };
      }

      const { searchSessions, buildCrossProjectResumeHint } = await import('@open-agent/core');
      const results = searchSessions(sessions, { text: query || undefined, limit: 10 }, ctx.cwd);

      if (results.length === 0) {
        return {
          handled: true,
          output: query ? `No sessions matching "${query}".` : 'No matching sessions.',
        };
      }

      const lines: string[] = [
        `Found ${results.length} session(s)${query ? ` matching "${query}"` : ''}:`,
      ];
      for (const r of results) {
        const marker = r.crossProject ? '\u21b1' : ' ';
        const title = r.title ?? '(untitled)';
        const score = query ? ` [${r.score.toFixed(2)}]` : '';
        lines.push(`${marker} ${r.sessionId.slice(0, 8)} ${title}${score}`);
        if (r.crossProject) {
          const hint = buildCrossProjectResumeHint(r, ctx.cwd);
          if (hint) lines.push(`    ${hint}`);
        }
      }
      return { handled: true, output: lines.join('\n') };
    },
  },
  '/rewind': {
    description: 'Restore files to their state N turns ago (/rewind <n>, default 1)',
    handler: async (args, ctx) => {
      const turnsArg = args?.trim() ?? '1';
      const turns = turnsArg === '' ? 1 : parseInt(turnsArg, 10);
      if (isNaN(turns) || turns < 1) {
        return {
          handled: true,
          output: 'Usage: /rewind <n> where n is the number of turns to rewind (default 1)',
        };
      }
      const { fileHistory } = await import('@open-agent/core');
      // sessionId is always present on SlashCommandContext (required field).
      const sessionId = ctx.sessionId ?? 'default';
      const restored = await fileHistory.rewind(sessionId, turns);
      if (restored.length === 0) {
        return {
          handled: true,
          output: `Nothing to rewind (no file history snapshots for session ${sessionId}).\n\nNote: file history tracking requires the FILE_HISTORY feature flag to be enabled.`,
        };
      }
      return {
        handled: true,
        output: `Rewound ${turns} turn(s). Restored ${restored.length} file(s):\n${restored.map((f) => `  - ${f}`).join('\n')}`,
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
    const nameWithoutSlash = cmdName.slice(1);

    // Check if the input matches a known skill name.
    const matchedSkill = ctx.skills?.find((s) => s.name === nameWithoutSlash);
    if (matchedSkill && matchedSkill.userInvocable === false) {
      return {
        handled: true,
        output: `Skill '${nameWithoutSlash}' is not user-invocable.`,
      };
    }

    // Check user-loaded markdown commands.
    const userCmds = await getUserCommands(ctx.cwd);
    const matchedUserCmd = userCmds.find((c) => c.name === nameWithoutSlash);
    if (matchedUserCmd) {
      // Emit the command body as a new user message to the agent loop.
      // `handled: false` causes the REPL to forward the output string as user input.
      return {
        handled: false,
        output: matchedUserCmd.body,
      };
    }

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
