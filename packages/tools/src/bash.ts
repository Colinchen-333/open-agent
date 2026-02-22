import type { ToolDefinition, ToolContext, BashInput, BashOutput } from './types.js';

const MAX_OUTPUT_LENGTH = 30000;
const MAX_TIMEOUT_MS = 600_000;
const DEFAULT_TIMEOUT_MS = 120_000;

export function createBashTool(): ToolDefinition {
  return {
    name: 'Bash',
    description: 'Execute a bash command in the current working directory. Stdout is captured and returned. Output exceeding 30 000 characters is truncated.',
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
      },
      required: ['command'],
    },

    async execute(input: BashInput, ctx: ToolContext): Promise<BashOutput> {
      const timeout = Math.min(input.timeout ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);

      const proc = Bun.spawn(['bash', '-c', input.command], {
        cwd: ctx.cwd,
        stdout: 'pipe',
        stderr: 'pipe',
        env: process.env as Record<string, string>,
      });

      let killed = false;
      const timer = setTimeout(() => {
        killed = true;
        proc.kill();
      }, timeout);

      // If running in background, detach immediately
      if (input.run_in_background) {
        clearTimeout(timer);
        return {
          stdout: '',
          stderr: '',
          interrupted: false,
          backgroundTaskId: `bg_${Date.now()}`,
        };
      }

      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);

      clearTimeout(timer);
      await proc.exited;

      // Truncate long output
      const truncate = (s: string) =>
        s.length > MAX_OUTPUT_LENGTH
          ? s.slice(0, MAX_OUTPUT_LENGTH) + '\n... (output truncated)'
          : s;

      // interrupted = killed by our timer OR non-zero exit with a signal
      const interrupted = killed || (proc.exitCode !== 0 && proc.signalCode !== null);

      return {
        stdout: truncate(stdout),
        stderr: truncate(stderr),
        interrupted,
      };
    },
  };
}
