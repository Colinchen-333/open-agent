import { mkdir } from 'fs/promises';
import { dirname } from 'path';
import type { ToolDefinition, ToolContext, FileWriteInput } from './types.js';

export function createWriteTool(): ToolDefinition {
  return {
    name: 'Write',
    description: 'Write content to a file, creating it or overwriting it entirely. Creates parent directories as needed.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Absolute path to the file to write',
        },
        content: {
          type: 'string',
          description: 'Full content to write to the file',
        },
      },
      required: ['file_path', 'content'],
    },

    async execute(input: FileWriteInput, ctx: ToolContext) {
      const file = Bun.file(input.file_path);
      const exists = await file.exists();

      // Enforce read-before-overwrite safety for existing files:
      // the LLM must have read the file before overwriting it.
      if (exists && ctx.fileReadTracker && !ctx.fileReadTracker.hasBeenRead(input.file_path)) {
        throw new Error(
          `You must use the Read tool to read ${input.file_path} before overwriting it. ` +
          `This ensures you have the current file contents. If this is a new file, it should not already exist.`
        );
      }

      // Ensure parent directory exists
      const dir = dirname(input.file_path);
      await mkdir(dir, { recursive: true });

      await Bun.write(input.file_path, input.content);

      const lineCount = input.content.split('\n').length;
      return {
        type: exists ? ('update' as const) : ('create' as const),
        filePath: input.file_path,
        lineCount,
      };
    },
  };
}
