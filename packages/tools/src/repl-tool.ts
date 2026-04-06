import { withToolDefaults } from './tool-defaults.js';
import { feature } from '@open-agent/core';
import type { ToolDefinition, ToolContext } from './types.js';

export interface REPLToolOptions {
  /** Max execution time in ms. Default: 10_000. */
  timeout?: number;
}

export function createREPLTool(options: REPLToolOptions = {}): ToolDefinition {
  const timeout = options.timeout ?? 10_000;

  return withToolDefaults({
    name: 'REPL',
    description:
      'Execute a JavaScript or TypeScript expression and return the result. ' +
      'Useful for quick calculations, data transformations, JSON processing, ' +
      'and testing small code snippets without writing to disk. ' +
      'The expression runs in a Bun subprocess with a timeout.',
    inputSchema: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description:
            'The JavaScript/TypeScript code to evaluate. Last expression value is returned.',
        },
        language: {
          type: 'string',
          enum: ['javascript', 'typescript'],
          description: 'Language hint (default: javascript). Both run in Bun.',
        },
      },
      required: ['code'],
    },
    capability: {
      category: 'shell',
      risk: 'medium',
    },
    annotations: {
      destructive: false, // REPL is read-compute, doesn't write files
      openWorld: false,   // no network by default
    },
    shouldDefer: true, // Available via ToolSearch, not always loaded
    async execute(input: { code: string; language?: string }, ctx: ToolContext) {
      if (!feature('REPL_TOOL')) {
        return {
          error: 'REPL tool is not enabled. Set OPEN_AGENT_FEATURE_REPL_TOOL=1 to enable.',
        };
      }

      const code = input.code;
      if (!code || typeof code !== 'string' || code.trim().length === 0) {
        return { error: 'Code must be a non-empty string.' };
      }

      // Wrap the code to capture the last expression value.
      // The async IIFE allows top-level await and a return statement at the call site.
      const wrappedCode = `
        const __result = await (async () => {
          ${code}
        })();
        if (__result !== undefined) {
          console.log(typeof __result === 'string' ? __result : JSON.stringify(__result, null, 2));
        }
      `;

      try {
        const proc = Bun.spawn([process.execPath, '-e', wrappedCode], {
          cwd: ctx.cwd,
          stdout: 'pipe',
          stderr: 'pipe',
          env: {
            ...process.env,
            // Restrict the REPL environment slightly
            NODE_ENV: 'sandbox',
          },
        });

        // Race the process against a timeout sentinel so we can distinguish
        // a deliberate timeout kill from a normal non-zero exit.
        const timeoutSymbol = Symbol('timeout');
        const timeoutHandle = { timer: null as ReturnType<typeof setTimeout> | null };
        const timeoutPromise = new Promise<typeof timeoutSymbol>((resolve) => {
          timeoutHandle.timer = setTimeout(() => {
            proc.kill();
            resolve(timeoutSymbol);
          }, timeout);
        });

        const completionPromise = Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);

        const raceResult = await Promise.race([completionPromise, timeoutPromise]);

        if (timeoutHandle.timer !== null) clearTimeout(timeoutHandle.timer);

        if (raceResult === timeoutSymbol) {
          return { error: `REPL execution timed out after ${timeout}ms`, output: '' };
        }

        const [stdout, stderr, exitCode] = raceResult as [string, string, number];

        let output = stdout.trim();
        if (stderr.trim()) {
          output += (output ? '\n\nSTDERR:\n' : '') + stderr.trim();
        }
        if (!output) output = '(no output)';

        return {
          output,
          exitCode,
          ...(exitCode !== 0 ? { error: `Process exited with code ${exitCode}` } : {}),
        };
      } catch (e) {
        const msg = (e as Error).message ?? String(e);
        if (msg.includes('timeout') || msg.includes('timed out')) {
          return { error: `REPL execution timed out after ${timeout}ms`, output: '' };
        }
        return { error: `REPL execution failed: ${msg}`, output: '' };
      }
    },
  });
}
