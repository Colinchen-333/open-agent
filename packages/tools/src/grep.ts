import type { ToolDefinition, ToolContext, GrepInput, GrepOutput } from './types.js';
import { exec } from '@open-agent/core';

export function createGrepTool(): ToolDefinition {
  return {
    name: 'Grep',
    description: 'Search file contents using ripgrep (rg). Supports content, files_with_matches, and count output modes.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Regular expression pattern to search for',
        },
        path: {
          type: 'string',
          description: 'File or directory to search in. Defaults to cwd.',
        },
        glob: {
          type: 'string',
          description: 'Glob pattern to filter files (e.g. "*.ts")',
        },
        output_mode: {
          type: 'string',
          enum: ['content', 'files_with_matches', 'count'],
          description: 'Output mode. Defaults to "files_with_matches".',
        },
        '-B': {
          type: 'number',
          description: 'Lines of context before each match (content mode only)',
        },
        '-A': {
          type: 'number',
          description: 'Lines of context after each match (content mode only)',
        },
        '-C': {
          type: 'number',
          description: 'Lines of context before and after each match (content mode only)',
        },
        context: {
          type: 'number',
          description: 'Alias for -C',
        },
        '-n': {
          type: 'boolean',
          description: 'Show line numbers (default true in content mode)',
        },
        '-i': {
          type: 'boolean',
          description: 'Case-insensitive matching',
        },
        type: {
          type: 'string',
          description: 'File type filter (e.g. "js", "py", "rust")',
        },
        head_limit: {
          type: 'number',
          description: 'Limit output to first N entries after applying offset',
        },
        offset: {
          type: 'number',
          description: 'Skip first N entries before applying head_limit',
        },
        multiline: {
          type: 'boolean',
          description: 'Enable multiline mode (. matches newlines)',
        },
      },
      required: ['pattern'],
    },

    async execute(input: GrepInput, ctx: ToolContext): Promise<GrepOutput> {
      const args: string[] = [];
      const mode = input.output_mode ?? 'files_with_matches';

      // Output mode flags
      if (mode === 'files_with_matches') args.push('-l');
      else if (mode === 'count') args.push('-c');

      // Matching flags
      if (input['-i']) args.push('-i');
      if (input.multiline) args.push('-U', '--multiline-dotall');

      // File filters
      if (input.glob) args.push('--glob', input.glob);
      if (input.type) args.push('--type', input.type);

      // Context flags (content mode only)
      if (mode === 'content') {
        // -n: show line numbers — default true unless explicitly set to false
        if (input['-n'] !== false) args.push('-n');

        const contextVal = input['-C'] ?? input.context;
        if (contextVal !== undefined) {
          args.push('-C', String(contextVal));
        } else {
          if (input['-B'] !== undefined) args.push('-B', String(input['-B']));
          if (input['-A'] !== undefined) args.push('-A', String(input['-A']));
        }
      }

      // Limit the number of results at the rg level for performance.
      // For files_with_matches mode, --max-count=1 makes rg stop after the
      // first match per file (it already does this with -l, but we use -m to
      // cap the total output).  For content/count we don't limit via rg
      // because head_limit applies to output lines, not matches.
      // We do apply --max-count for content mode when head_limit is set to
      // avoid reading entire large files when only a few matches are needed.
      if (input.head_limit && input.head_limit > 0 && mode === 'content') {
        // Over-fetch slightly to account for offset, then trim post-hoc.
        const fetchCount = (input.offset ?? 0) + input.head_limit;
        args.push('--max-count', String(fetchCount));
      }

      // Pattern and path — always last
      args.push('--', input.pattern);
      args.push(input.path ?? ctx.cwd);

      const { stdout: rawOutput } = await exec(['rg', ...args], { cwd: ctx.cwd });

      // Split into non-empty lines
      let lines = rawOutput.trimEnd().split('\n').filter(l => l.length > 0);

      // Apply offset then head_limit
      if (input.offset && input.offset > 0) {
        lines = lines.slice(input.offset);
      }
      if (input.head_limit && input.head_limit > 0) {
        lines = lines.slice(0, input.head_limit);
      }

      // Derive list of unique file paths depending on mode
      let filenames: string[];
      if (mode === 'files_with_matches') {
        filenames = lines;
      } else if (mode === 'count') {
        // count lines look like "path/to/file:N"
        filenames = [...new Set(lines.map(l => l.split(':')[0]).filter(Boolean))];
      } else {
        // content lines look like "path/to/file:linenum:content" or separator "--"
        filenames = [
          ...new Set(
            lines
              .filter(l => l !== '--')
              .map(l => l.split(':')[0])
              .filter(Boolean)
          ),
        ];
      }

      return {
        mode,
        numFiles: filenames.length,
        filenames,
        content: (mode === 'content' || mode === 'count') ? lines.join('\n') : undefined,
        numLines: lines.length,
      };
    },
  };
}
