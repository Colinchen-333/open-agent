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
      'Execute JavaScript/TypeScript code and return the result. ' +
      'Useful for quick calculations, data transformations, JSON processing, ' +
      'and testing small code snippets. The last expression value is captured ' +
      'automatically — no explicit return needed. Runs in a Bun subprocess with a timeout.',
    inputSchema: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description:
            'The JavaScript/TypeScript code to evaluate. Last expression value is returned.',
        },
      },
      required: ['code'],
    },
    capability: {
      category: 'shell',
      risk: 'medium',
    },
    annotations: {
      destructive: true,  // can execute arbitrary code (file writes, process spawning)
      openWorld: true,    // inherits process.env; can make network calls
    },
    shouldDefer: true, // Available via ToolSearch, not always loaded
    async execute(input: { code: string }, ctx: ToolContext) {
      if (!feature('REPL_TOOL')) {
        return {
          error: 'REPL tool is not enabled. Set OPEN_AGENT_FEATURE_REPL_TOOL=1 to enable.',
        };
      }

      const code = input.code;
      if (!code || typeof code !== 'string' || code.trim().length === 0) {
        return { error: 'Code must be a non-empty string.' };
      }

      // Capture the last expression value without requiring an explicit `return`.
      //
      // We use the AsyncFunction constructor to create a proper async function whose
      // body IS the user's code. This gives us:
      //   1. Native `await` support — the function body is truly async.
      //   2. `return value` in user code is captured as the function's resolved value.
      //   3. For expression-only snippets (e.g. `2 + 3`, `arr.map(f)`), we use eval()
      //      OUTSIDE the async function to capture the completion value of the last
      //      statement — eval always returns the last expression's value.
      //
      // The two-phase approach:
      //   - If user code contains `await`, run it via AsyncFunction (supports await).
      //   - Otherwise, use eval() for automatic last-expression capture.
      //   - In both cases the result is printed if non-undefined.
      //
      // We detect `await` by checking the serialized code string; false positives
      // (e.g. variable named `awaiting`) are acceptable — AsyncFunction works for all.
      const codeJson = JSON.stringify(code);
      const wrappedCode = `(async () => {
  const __hasAwait = /\\bawait\\b/.test(${codeJson});
  let __r;
  if (__hasAwait) {
    // AsyncFunction body: user code runs in a real async function scope.
    const __AsyncFn = Object.getPrototypeOf(async function(){}).constructor;
    __r = await new __AsyncFn(${codeJson})();
  } else {
    // eval() returns the completion value of the last statement without needing return.
    __r = eval(${codeJson});
    if (__r && typeof __r.then === 'function') __r = await __r;
  }
  if (__r !== undefined) {
    const __out = typeof __r === 'string' ? __r : JSON.stringify(__r, null, 2);
    process.stdout.write(__out + '\\n');
  }
})()`;

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
