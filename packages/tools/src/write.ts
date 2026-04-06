import { mkdir } from 'fs/promises';
import { dirname } from 'path';
import type { ToolDefinition, ToolContext, FileWriteInput } from './types.js';
import { fileExists, writeText, fileHistory, feature } from '@open-agent/core';
import { summarizeFilePath } from './tool-summary.js';
import { withToolDefaults } from './tool-defaults.js';

export function createWriteTool(): ToolDefinition {
  return withToolDefaults({
    name: 'Write',
    description: 'Write content to a file, creating it or overwriting it entirely. Creates parent directories as needed.',
    isConcurrencySafe: false,
    searchHint: 'write create new file',
    annotations: { destructive: true },
    getToolUseSummary(input: FileWriteInput, _result, isError) {
      const file = summarizeFilePath(input.file_path) ?? 'file';
      return isError ? `Write failed for ${file}` : `Wrote ${file}`;
    },
    getActivityDescription(input: unknown) {
      return `Writing ${(input as FileWriteInput)?.file_path ?? 'file'}`;
    },
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
      const exists = await fileExists(input.file_path);

      // Enforce read-before-overwrite safety for existing files:
      // the LLM must have read the file before overwriting it.
      if (exists && ctx.fileReadTracker && !ctx.fileReadTracker.hasBeenRead(input.file_path)) {
        throw new Error(
          `You must use the Read tool to read ${input.file_path} before overwriting it. ` +
          `This ensures you have the current file contents. If this is a new file, it should not already exist.`
        );
      }

      // Snapshot current file state for /rewind support before overwriting.
      if (feature('FILE_HISTORY') && ctx.sessionId && ctx.toolUseId) {
        await fileHistory.trackEdit(ctx.sessionId, ctx.toolUseId, input.file_path);
      }

      // Ensure parent directory exists
      const dir = dirname(input.file_path);
      await mkdir(dir, { recursive: true });

      await writeText(input.file_path, input.content);

      // Mark the file as read so a subsequent Edit doesn't reject it.
      ctx.fileReadTracker?.markRead(input.file_path);

      const lineCount = input.content.split('\n').length;
      return {
        type: exists ? ('update' as const) : ('create' as const),
        filePath: input.file_path,
        lineCount,
      };
    },
  });
}
