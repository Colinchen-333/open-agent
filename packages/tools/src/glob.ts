import fg from 'fast-glob';
import { statSync } from 'fs';
import type { ToolDefinition, ToolContext, GlobInput, GlobOutput } from './types.js';

const MAX_FILES = 100;

export function createGlobTool(): ToolDefinition {
  return {
    name: 'Glob',
    description: 'Find files matching a glob pattern, sorted by modification time (newest first). Returns up to 100 results.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Glob pattern to match (e.g. "**/*.ts", "src/**/*.{js,ts}")',
        },
        path: {
          type: 'string',
          description: 'Directory to search in. Defaults to the current working directory.',
        },
      },
      required: ['pattern'],
    },

    async execute(input: GlobInput, ctx: ToolContext): Promise<GlobOutput> {
      const start = Date.now();
      const cwd = input.path || ctx.cwd;

      let files = await fg(input.pattern, {
        cwd,
        absolute: true,
        dot: true,
        ignore: ['**/node_modules/**', '**/.git/**'],
      });

      // Sort by modification time, newest first
      files.sort((a, b) => {
        try {
          return statSync(b).mtimeMs - statSync(a).mtimeMs;
        } catch {
          return 0;
        }
      });

      const truncated = files.length > MAX_FILES;
      if (truncated) {
        files = files.slice(0, MAX_FILES);
      }

      return {
        durationMs: Date.now() - start,
        numFiles: files.length,
        filenames: files,
        truncated,
      };
    },
  };
}
