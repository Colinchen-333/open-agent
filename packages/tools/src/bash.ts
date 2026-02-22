import { randomUUID } from 'crypto';
import type { ToolDefinition, ToolContext, BashInput } from './types.js';
import { getBackgroundTasks } from './task-management.js';

const MAX_OUTPUT_LENGTH = 30000;
const MAX_TIMEOUT_MS = 600_000;
const DEFAULT_TIMEOUT_MS = 120_000;

// Persistent CWD state across consecutive Bash calls, keyed by sessionId
// to prevent multi-session conflicts.
const persistentCwdBySession = new Map<string, string>();

export function createBashTool(): ToolDefinition {
  return {
    name: 'Bash',
    description:
      'Execute a bash command in the current working directory. Stdout is captured and returned. Output exceeding 30 000 characters is truncated. Working directory persists between commands; shell state (everything else) does not.',
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
        const taskId = `bg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const backgroundTasks = getBackgroundTasks();

        const proc = Bun.spawn(['bash', '-c', wrappedCommand], {
          cwd: effectiveCwd,
          stdout: 'pipe',
          stderr: 'pipe',
          env: { ...process.env, TERM: 'dumb' } as Record<string, string>,
        });

        backgroundTasks.set(taskId, {
          process: proc,
          output: '',
          status: 'running',
          startTime: Date.now(),
        });

        // Async collection of output
        (async () => {
          const task = backgroundTasks.get(taskId)!;
          try {
            const [stdout, stderr] = await Promise.all([
              new Response(proc.stdout).text(),
              new Response(proc.stderr).text(),
            ]);
            // Strip CWD sentinel from output and update persistentCwd
            const { cleanOutput, finalCwd } = extractCwd(stdout, CWD_SENTINEL);
            if (finalCwd) persistentCwdBySession.set(ctx.sessionId, finalCwd);
            task.output =
              truncate(cleanOutput) + (stderr ? '\nSTDERR:\n' + truncate(stderr) : '');
            task.status = 'completed';
          } catch {
            task.status = 'error';
          }
        })();

        return `Background task started (id: ${taskId})`;
      }

      // Foreground execution
      const proc = Bun.spawn(['bash', '-c', wrappedCommand], {
        cwd: effectiveCwd,
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, TERM: 'dumb' } as Record<string, string>,
      });

      let killed = false;
      const timer = setTimeout(() => {
        killed = true;
        proc.kill();
      }, timeout);

      const [rawStdout, rawStderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);

      clearTimeout(timer);
      await proc.exited;

      // Extract final CWD from stdout and update persistent state
      const { cleanOutput: stdout, finalCwd } = extractCwd(rawStdout, CWD_SENTINEL);
      if (finalCwd) persistentCwdBySession.set(ctx.sessionId, finalCwd);

      // Truncate long output with informative message
      const truncatedStdout = truncate(stdout);
      const truncatedStderr = truncate(rawStderr);

      // interrupted = killed by our timer OR non-zero exit with a signal
      const interrupted = killed || (proc.exitCode !== 0 && proc.signalCode !== null);

      // Return a clean string that the LLM can read directly.
      // Prefer stdout; fall back to stderr if there was no stdout output.
      const output = truncatedStdout || truncatedStderr || '(no output)';
      const exitInfo =
        proc.exitCode !== 0 ? `\n(exit code: ${proc.exitCode})` : '';
      const interruptedNote = interrupted ? '\n(command was interrupted)' : '';
      return output + exitInfo + interruptedNote;
    },
  };
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
