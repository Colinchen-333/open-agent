import { randomUUID } from 'crypto';
import { closeSync, existsSync, openSync, readFileSync } from 'fs';
import { spawn } from 'child_process';
import { resolve, sep } from 'path';
import type { ToolDefinition, ToolContext, BashInput } from './types.js';
import { getBackgroundTasks } from './task-management.js';
import {
  getBackgroundTask,
  registerBackgroundTask,
  updateBackgroundTask,
} from './background-registry.js';
import { spawnProcess } from '@open-agent/core';
import { summarizeCommand } from './tool-summary.js';
import { getBackgroundTaskOutputFile } from './background-task-store.js';

const MAX_OUTPUT_LENGTH = 30000;
const MAX_TIMEOUT_MS = 600_000;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_BACKGROUND_TASKS = 100;
const BACKGROUND_TASK_TTL_MS = 30 * 60 * 1000; // 30 minutes
// Keep in sync with @open-agent/permissions/sandbox-adapter.ts
const BASH_SANDBOX_POLICY_FIELD = '__openAgentBashSandboxPolicy';

// Persistent CWD state across consecutive Bash calls, keyed by sessionId
// to prevent multi-session conflicts.
const persistentCwdBySession = new Map<string, string>();

interface BashSandboxExecutionPolicy {
  enforce: boolean;
  executionEngine: 'none' | 'darwin-sandbox-exec';
  boundaryKind: 'none' | 'policy_only' | 'mixed' | 'hard';
  enforcedFeatures: {
    network: boolean;
    writePaths: boolean;
    readPaths: boolean;
  };
  hardEnforcedFeatures: Array<'network' | 'writePaths' | 'readPaths'>;
  policyOnlyFeatures: Array<'network' | 'writePaths' | 'readPaths'>;
  allowWritePaths: string[];
  denyReadPaths: string[];
  denyWritePaths: string[];
  networkDisabled: boolean;
  bypassRequested: boolean;
  bypassAllowed: boolean;
  reason?: string;
}

interface BashSandboxViolation {
  phase: 'preflight';
  code: 'bypass_not_approved' | 'network_disabled' | 'write_denied' | 'write_outside_allowed_paths';
  feature: 'bypass' | 'network' | 'writePaths';
  message: string;
  target?: string;
  executionEngine: BashSandboxExecutionPolicy['executionEngine'];
  boundaryKind: BashSandboxExecutionPolicy['boundaryKind'];
}

type BashSandboxError = Error & { sandboxViolation?: BashSandboxViolation };

const DARWIN_SANDBOX_EXEC = '/usr/bin/sandbox-exec';

/** Prune completed background tasks older than TTL or exceeding max count. */
function pruneBackgroundTasks(tasks: Map<string, { status: string; startTime: number }>): void {
  const now = Date.now();
  const expired: string[] = [];
  for (const [id, task] of tasks) {
    if (task.status !== 'running' && now - task.startTime > BACKGROUND_TASK_TTL_MS) {
      expired.push(id);
    }
  }
  for (const id of expired) tasks.delete(id);

  // If still over limit, remove oldest completed tasks
  if (tasks.size > MAX_BACKGROUND_TASKS) {
    const completed = [...tasks.entries()]
      .filter(([, t]) => t.status !== 'running')
      .sort((a, b) => a[1].startTime - b[1].startTime);
    const toRemove = tasks.size - MAX_BACKGROUND_TASKS;
    for (let i = 0; i < Math.min(toRemove, completed.length); i++) {
      tasks.delete(completed[i][0]);
    }
  }
}

export function createBashTool(): ToolDefinition {
  return {
    name: 'Bash',
    isConcurrencySafe: false,
    description:
      'Execute a bash command in the current working directory. Stdout is captured and returned. Output exceeding 30 000 characters is truncated. Working directory persists between commands; shell state (everything else) does not.',
    getToolUseSummary(input: BashInput, _result, isError) {
      const summary = summarizeCommand(input.command, input.description);
      return isError ? `Command failed: ${summary}` : `Ran ${summary}`;
    },
    inputSchema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The bash command to execute',
        },
        timeout: {
          type: 'number',
          description: 'Timeout in milliseconds (max 600 000). Defaults to 120 000.',
        },
        description: {
          type: 'string',
          description: 'Human-readable description of what the command does',
        },
        run_in_background: {
          type: 'boolean',
          description: 'Run the command in the background (fire-and-forget)',
        },
        dangerouslyDisableSandbox: {
          type: 'boolean',
          description: 'Bypass sandbox restrictions for this command (requires explicit user approval)',
        },
      },
      required: ['command'],
    },

    async execute(
      input: BashInput & { dangerouslyDisableSandbox?: boolean; [key: string]: unknown },
      ctx: ToolContext,
    ): Promise<string> {
      const timeout = Math.min(input.timeout ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);

      // Determine effective working directory (persistent across calls, per session)
      const effectiveCwd = persistentCwdBySession.get(ctx.sessionId) ?? ctx.cwd;
      const sandboxPolicy = readSandboxPolicy(input);
      const preflightViolation = validateBashPreflight(input.command, effectiveCwd, sandboxPolicy);
      if (preflightViolation) {
        const error: BashSandboxError = new Error(preflightViolation.message);
        error.sandboxViolation = preflightViolation;
        throw error;
      }
      const sandboxEnv = buildSandboxEnv(sandboxPolicy);

      // Use a UUID-based sentinel to avoid collisions with command output
      const CWD_SENTINEL = `___CWD_${randomUUID()}___`;
      const wrappedCommand = `cd "${effectiveCwd}" && ${input.command} ; echo "${CWD_SENTINEL}" ; pwd`;
      const sandboxedCommand = wrapWithSandboxExec(
        ['bash', '-lc', wrappedCommand],
        sandboxPolicy,
      );

      // Handle background execution
      if (input.run_in_background) {
        const taskId = `bg_${randomUUID().slice(0, 12)}`;
        const backgroundTasks = getBackgroundTasks();
        const commandSummary = summarizeCommand(input.command, input.description);
        const outputFile = getBackgroundTaskOutputFile(taskId);

        // Auto-prune old completed tasks to prevent memory leaks
        pruneBackgroundTasks(backgroundTasks);

        const outputFd = openSync(outputFile, 'a');
        const child = spawn(sandboxedCommand.command, sandboxedCommand.args, {
          cwd: effectiveCwd,
          env: { ...process.env, TERM: 'dumb', ...sandboxEnv },
          detached: true,
          stdio: ['ignore', outputFd, outputFd],
        });
        closeSync(outputFd);
        child.unref();

        registerBackgroundTask({
          task_id: taskId,
          command: input.command,
          summary: commandSummary,
          session_id: ctx.sessionId,
          cwd: effectiveCwd,
          process: child,
          output: '',
          status: 'running',
          start_time: Date.now(),
          output_file: outputFile,
          pid: child.pid,
        });

        // Async collection of output
        child.on('exit', (code) => {
          const rawOutput = safeReadBackgroundOutput(outputFile);
          const { cleanOutput, finalCwd } = extractCwd(rawOutput, CWD_SENTINEL);
          if (finalCwd) persistentCwdBySession.set(ctx.sessionId, finalCwd);
          updateBackgroundTask(taskId, {
            output: truncate(cleanOutput),
            status: code === 0 ? 'completed' : 'error',
            summary: `${code === 0 ? 'Completed' : 'Errored'}: ${commandSummary}`,
            completed_time: Date.now(),
          });
        });

        return `Background task started (id: ${taskId})`;
      }

      // Foreground execution
      const proc = await spawnProcess([sandboxedCommand.command, ...sandboxedCommand.args], {
        cwd: effectiveCwd,
        env: { TERM: 'dumb', ...sandboxEnv },
      });

      let killed = false;
      let aborted = false;
      const timer = setTimeout(() => {
        killed = true;
        proc.kill();
      }, timeout);

      // Listen for abort signal (Ctrl+C) to kill the process promptly
      const onAbort = () => {
        aborted = true;
        proc.kill();
      };
      ctx.abortSignal?.addEventListener('abort', onAbort, { once: true });

      let rawStdout: string;
      let rawStderr: string;
      try {
        [rawStdout, rawStderr] = await Promise.all([
          proc.stdoutText(),
          proc.stderrText(),
        ]);
      } finally {
        clearTimeout(timer);
        ctx.abortSignal?.removeEventListener('abort', onAbort);
      }

      const exitCode = await proc.exited;

      if (aborted) {
        throw new DOMException('Bash command aborted', 'AbortError');
      }

      // Extract final CWD from stdout and update persistent state
      const { cleanOutput: stdout, finalCwd } = extractCwd(rawStdout, CWD_SENTINEL);
      if (finalCwd) persistentCwdBySession.set(ctx.sessionId, finalCwd);

      // Truncate long output with informative message
      const truncatedStdout = truncate(stdout);
      const truncatedStderr = truncate(rawStderr);

      // Assemble output: prefer stdout; always include non-empty stderr.
      let output = truncatedStdout || '';
      if (rawStderr.trim()) {
        if (output) output += '\nSTDERR:\n' + truncatedStderr;
        else output = truncatedStderr; // Only stderr — use it directly
      }
      if (!output) output = '(no output)';

      // Exit info: only show numeric exit code if we have one.
      const exitInfo = (exitCode !== null && exitCode !== 0)
        ? `\n(exit code: ${exitCode})` : '';
      const interruptedNote = killed ? '\n(command timed out and was killed)' : '';
      return output + exitInfo + interruptedNote;
    },
  };
}

function safeReadBackgroundOutput(path: string): string {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return '';
  }
}

/**
 * Extract the final CWD from stdout that contains the sentinel line.
 * Returns the cleaned output (sentinel + pwd line removed) and the parsed CWD.
 */
function extractCwd(
  stdout: string,
  sentinel: string
): { cleanOutput: string; finalCwd: string | null } {
  const sentinelIdx = stdout.lastIndexOf(sentinel);
  if (sentinelIdx === -1) {
    return { cleanOutput: stdout, finalCwd: null };
  }

  // Everything before the sentinel is the real output
  const cleanOutput = stdout.slice(0, sentinelIdx).replace(/\n$/, '');

  // The line after the sentinel is the pwd result
  const afterSentinel = stdout.slice(sentinelIdx + sentinel.length).trim();
  const pwdLine = afterSentinel.split('\n')[0]?.trim() ?? null;
  const finalCwd = pwdLine && pwdLine.length > 0 ? pwdLine : null;

  return { cleanOutput, finalCwd };
}

function truncate(s: string): string {
  if (s.length > MAX_OUTPUT_LENGTH) {
    return (
      s.slice(0, MAX_OUTPUT_LENGTH) +
      '\n\n[Output truncated. Use head/tail/grep for large outputs.]'
    );
  }
  return s;
}

function readSandboxPolicy(
  input: BashInput & { [key: string]: unknown },
): BashSandboxExecutionPolicy | undefined {
  const raw = input[BASH_SANDBOX_POLICY_FIELD];
  if (!raw || typeof raw !== 'object') return undefined;
  const policy = raw as Partial<BashSandboxExecutionPolicy>;
  if (typeof policy.enforce !== 'boolean') return undefined;
  return {
    enforce: policy.enforce,
    executionEngine: policy.executionEngine === 'darwin-sandbox-exec' ? 'darwin-sandbox-exec' : 'none',
    boundaryKind: policy.boundaryKind === 'policy_only'
      ? 'policy_only'
      : policy.boundaryKind === 'mixed'
        ? 'mixed'
        : policy.boundaryKind === 'hard'
          ? 'hard'
          : 'none',
    enforcedFeatures: {
      network: policy.enforcedFeatures?.network === true,
      writePaths: policy.enforcedFeatures?.writePaths === true,
      readPaths: policy.enforcedFeatures?.readPaths === true,
    },
    hardEnforcedFeatures: Array.isArray(policy.hardEnforcedFeatures)
      ? policy.hardEnforcedFeatures.filter((feature): feature is 'network' | 'writePaths' | 'readPaths' =>
        feature === 'network' || feature === 'writePaths' || feature === 'readPaths')
      : [],
    policyOnlyFeatures: Array.isArray(policy.policyOnlyFeatures)
      ? policy.policyOnlyFeatures.filter((feature): feature is 'network' | 'writePaths' | 'readPaths' =>
        feature === 'network' || feature === 'writePaths' || feature === 'readPaths')
      : [],
    allowWritePaths: Array.isArray(policy.allowWritePaths)
      ? policy.allowWritePaths.filter((path): path is string => typeof path === 'string')
      : [],
    denyReadPaths: Array.isArray(policy.denyReadPaths)
      ? policy.denyReadPaths.filter((path): path is string => typeof path === 'string')
      : [],
    denyWritePaths: Array.isArray(policy.denyWritePaths)
      ? policy.denyWritePaths.filter((path): path is string => typeof path === 'string')
      : [],
    networkDisabled: policy.networkDisabled === true,
    bypassRequested: policy.bypassRequested === true,
    bypassAllowed: policy.bypassAllowed === true,
    ...(typeof policy.reason === 'string' ? { reason: policy.reason } : {}),
  };
}

function validateBashPreflight(
  command: string,
  cwd: string,
  policy: BashSandboxExecutionPolicy | undefined,
) : BashSandboxViolation | null {
  if (!policy?.enforce) return null;

  if (policy.bypassRequested) {
    if (policy.bypassAllowed) return null;
    return {
      phase: 'preflight',
      code: 'bypass_not_approved',
      feature: 'bypass',
      message: policy.reason ?? 'Sandbox bypass requested but not explicitly approved.',
      executionEngine: policy.executionEngine,
      boundaryKind: policy.boundaryKind,
    };
  }

  if (policy.networkDisabled && usesNetwork(command)) {
    return {
      phase: 'preflight',
      code: 'network_disabled',
      feature: 'network',
      message: 'Sandbox policy blocked command: network access is disabled.',
      executionEngine: policy.executionEngine,
      boundaryKind: policy.boundaryKind,
    };
  }

  const hasPathRules = policy.allowWritePaths.length > 0 || policy.denyWritePaths.length > 0;
  if (!hasPathRules) return null;

  const writeTargets = extractWriteTargets(command, cwd);
  for (const target of writeTargets) {
    if (policy.denyWritePaths.some((denied) => isPathInside(target, denied))) {
      return {
        phase: 'preflight',
        code: 'write_denied',
        feature: 'writePaths',
        message: `Sandbox policy blocked write to denied path: ${target}`,
        target,
        executionEngine: policy.executionEngine,
        boundaryKind: policy.boundaryKind,
      };
    }
    if (
      policy.allowWritePaths.length > 0 &&
      !policy.allowWritePaths.some((allowed) => isPathInside(target, allowed))
    ) {
      return {
        phase: 'preflight',
        code: 'write_outside_allowed_paths',
        feature: 'writePaths',
        message: `Sandbox policy blocked write outside allowed paths: ${target}`,
        target,
        executionEngine: policy.executionEngine,
        boundaryKind: policy.boundaryKind,
      };
    }
  }

  return null;
}

function buildSandboxEnv(policy: BashSandboxExecutionPolicy | undefined): Record<string, string> {
  if (!policy) return {};
  return {
    OPEN_AGENT_SANDBOX: policy.enforce ? '1' : '0',
    OPEN_AGENT_SANDBOX_EXECUTION_ENGINE: policy.executionEngine,
    OPEN_AGENT_SANDBOX_BOUNDARY_KIND: policy.boundaryKind,
    OPEN_AGENT_SANDBOX_ENFORCED_FEATURES: [
      policy.enforcedFeatures.network ? 'network' : '',
      policy.enforcedFeatures.writePaths ? 'write-paths' : '',
      policy.enforcedFeatures.readPaths ? 'read-paths' : '',
    ].filter(Boolean).join(','),
    OPEN_AGENT_SANDBOX_HARD_ENFORCED_FEATURES: policy.hardEnforcedFeatures.join(','),
    OPEN_AGENT_SANDBOX_POLICY_ONLY_FEATURES: policy.policyOnlyFeatures.join(','),
    OPEN_AGENT_SANDBOX_NETWORK_DISABLED: policy.networkDisabled ? '1' : '0',
    OPEN_AGENT_SANDBOX_ALLOW_WRITE_PATHS: policy.allowWritePaths.join(':'),
    OPEN_AGENT_SANDBOX_DENY_READ_PATHS: policy.denyReadPaths.join(':'),
    OPEN_AGENT_SANDBOX_DENY_WRITE_PATHS: policy.denyWritePaths.join(':'),
    OPEN_AGENT_SANDBOX_BYPASS_REQUESTED: policy.bypassRequested ? '1' : '0',
    OPEN_AGENT_SANDBOX_BYPASS_ALLOWED: policy.bypassAllowed ? '1' : '0',
    OPEN_AGENT_SANDBOX_REASON: policy.reason ?? '',
  };
}

function wrapWithSandboxExec(
  command: string[],
  policy: BashSandboxExecutionPolicy | undefined,
): { command: string; args: string[] } {
  if (!policy?.enforce || policy.bypassRequested || policy.executionEngine !== 'darwin-sandbox-exec') {
    return { command: command[0]!, args: command.slice(1) };
  }
  if (!existsSync(DARWIN_SANDBOX_EXEC)) {
    return { command: command[0]!, args: command.slice(1) };
  }

  const profile = buildDarwinSandboxProfile(policy);
  return {
    command: DARWIN_SANDBOX_EXEC,
    args: ['-p', profile, ...command],
  };
}

function buildDarwinSandboxProfile(policy: BashSandboxExecutionPolicy): string {
  const rules = [
    '(version 1)',
    '(allow default)',
  ];

  if (policy.networkDisabled) {
    rules.push('(deny network*)');
  }

  if (policy.allowWritePaths.length > 0) {
    rules.push('(deny file-write*)');
    for (const allowedPath of policy.allowWritePaths) {
      rules.push(`(allow file-write* (subpath "${escapeSandboxString(allowedPath)}"))`);
    }
  }

  for (const deniedPath of policy.denyWritePaths) {
    rules.push(`(deny file-write* (subpath "${escapeSandboxString(deniedPath)}"))`);
  }

  return rules.join('\n');
}

function escapeSandboxString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function usesNetwork(command: string): boolean {
  const directNetwork = /\b(curl|wget|ssh|scp|sftp|nc|ncat|telnet|ping|ftp|rsync)\b/i;
  const gitRemote = /\bgit\s+(clone|fetch|pull|push|ls-remote|remote|submodule)\b/i;
  const urlLike = /\b(?:https?|ftp):\/\//i;
  return directNetwork.test(command) || gitRemote.test(command) || urlLike.test(command);
}

function extractWriteTargets(command: string, cwd: string): string[] {
  const candidates = new Set<string>();
  const segments = command.split(/(?:&&|\|\||;|\n)/).map((segment) => segment.trim()).filter(Boolean);

  for (const segment of segments) {
    const tokens = tokenizeShell(segment);
    if (tokens.length === 0) continue;

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (isRedirectionToken(token)) {
        const next = tokens[i + 1];
        if (next) addWriteTarget(candidates, next, cwd);
        continue;
      }
      const inlineRedirect = extractInlineRedirectTarget(token);
      if (inlineRedirect) addWriteTarget(candidates, inlineRedirect, cwd);
      if (/^of=/.test(token)) {
        addWriteTarget(candidates, token.slice(3), cwd);
      }
    }

    const commandName = stripWrappingQuotes(tokens[0]);
    const args = tokens.slice(1);
    switch (commandName) {
      case 'touch':
      case 'mkdir':
      case 'rm':
      case 'rmdir':
      case 'truncate':
      case 'chmod':
      case 'chown':
        for (const arg of args) {
          if (isOptionToken(arg)) continue;
          addWriteTarget(candidates, arg, cwd);
        }
        break;
      case 'tee':
        for (const arg of args) {
          if (isOptionToken(arg) || arg === '-') continue;
          addWriteTarget(candidates, arg, cwd);
        }
        break;
      case 'cp':
      case 'mv':
      case 'install':
      case 'ln': {
        const targets = args.filter((arg) => !isOptionToken(arg));
        const destination = targets[targets.length - 1];
        if (destination) addWriteTarget(candidates, destination, cwd);
        break;
      }
      case 'sed': {
        const hasInPlace = args.some((arg) => /^-i($|['"])/.test(arg) || arg === '--in-place');
        if (hasInPlace) {
          for (const arg of args) {
            if (isOptionToken(arg)) continue;
            addWriteTarget(candidates, arg, cwd);
          }
        }
        break;
      }
      default:
        break;
    }
  }

  return [...candidates];
}

function tokenizeShell(segment: string): string[] {
  const matches = segment.match(/"[^"\\]*(?:\\.[^"\\]*)*"|'[^'\\]*(?:\\.[^'\\]*)*'|[^\s]+/g);
  return matches ?? [];
}

function addWriteTarget(targets: Set<string>, raw: string, cwd: string): void {
  const cleaned = stripWrappingQuotes(raw.trim());
  if (!cleaned || cleaned === '-') return;
  if (
    cleaned.includes('$') ||
    cleaned.includes('*') ||
    cleaned.includes('?') ||
    cleaned.includes('[') ||
    cleaned.includes('`')
  ) {
    return;
  }
  const normalized = resolve(cwd, cleaned);
  targets.add(normalized);
}

function stripWrappingQuotes(token: string): string {
  if (token.length < 2) return token;
  if (
    (token.startsWith('"') && token.endsWith('"')) ||
    (token.startsWith('\'') && token.endsWith('\''))
  ) {
    return token.slice(1, -1);
  }
  return token;
}

function isRedirectionToken(token: string): boolean {
  return /^(?:\d?>>?|&>|2>|1>)$/.test(token);
}

function extractInlineRedirectTarget(token: string): string | null {
  const match = token.match(/^(?:\d?>>?|&>)(.+)$/);
  if (!match) return null;
  return match[1];
}

function isOptionToken(token: string): boolean {
  return token.startsWith('-');
}

function isPathInside(candidatePath: string, basePath: string): boolean {
  const normalizedCandidate = resolve(candidatePath);
  const normalizedBase = resolve(basePath);
  return (
    normalizedCandidate === normalizedBase ||
    normalizedCandidate.startsWith(normalizedBase.endsWith(sep) ? normalizedBase : `${normalizedBase}${sep}`)
  );
}
