import { randomUUID } from 'crypto';
import { closeSync, openSync, readFileSync } from 'fs';
import { spawn } from 'child_process';
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

// Persistent CWD state across consecutive Bash calls, keyed by sessionId
// to prevent multi-session conflicts.
const persistentCwdBySession = new Map<string, string>();

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

    async execute(input: BashInput & { dangerouslyDisableSandbox?: boolean }, ctx: ToolContext): Promise<string> {
      const timeout = Math.min(input.timeout ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);

      // Determine effective working directory (persistent across calls, per session)
      const effectiveCwd = persistentCwdBySession.get(ctx.sessionId) ?? ctx.cwd;

      // Use a UUID-based sentinel to avoid collisions with command output
      const CWD_SENTINEL = `___CWD_${randomUUID()}___`;
      const wrappedCommand = `cd "${effectiveCwd}" && ${input.command} ; echo "${CWD_SENTINEL}" ; pwd`;

      // Handle background execution
      if (input.run_in_background) {
        const taskId = `bg_${randomUUID().slice(0, 12)}`;
        const backgroundTasks = getBackgroundTasks();
        const commandSummary = summarizeCommand(input.command, input.description);
        const outputFile = getBackgroundTaskOutputFile(taskId);

        // Auto-prune old completed tasks to prevent memory leaks
        pruneBackgroundTasks(backgroundTasks);

        const outputFd = openSync(outputFile, 'a');
        const child = spawn('bash', ['-lc', wrappedCommand], {
          cwd: effectiveCwd,
          env: { ...process.env, TERM: 'dumb' },
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
      const proc = await spawnProcess(['bash', '-c', wrappedCommand], {
        cwd: effectiveCwd,
        env: { TERM: 'dumb' },
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
