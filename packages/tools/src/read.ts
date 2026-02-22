import { readFileSync } from 'fs';
import type { ToolDefinition, ToolContext, FileReadInput } from './types.js';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const DEFAULT_LINE_LIMIT = 2000;
const MAX_LINE_LENGTH = 2000;

function getExtension(filePath: string): string {
  const idx = filePath.lastIndexOf('.');
  return idx >= 0 ? filePath.slice(idx).toLowerCase() : '';
}

function formatWithLineNumbers(lines: string[], startLine: number): string {
  const width = String(startLine + lines.length - 1).length;
  return lines
    .map((line, i) => {
      const lineNum = String(startLine + i).padStart(width, ' ');
      const truncated = line.length > MAX_LINE_LENGTH ? line.slice(0, MAX_LINE_LENGTH) : line;
      return `${lineNum}\t${truncated}`;
    })
    .join('\n');
}

export function createReadTool(): ToolDefinition {
  return {
    name: 'Read',
    description: 'Read a file from the filesystem. Returns file contents with line numbers (cat -n style). For images returns base64 data. Supports offset and limit for partial reads.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Absolute path to the file to read',
        },
        offset: {
          type: 'number',
          description: 'Line number to start reading from (1-indexed). Defaults to 1.',
        },
        limit: {
          type: 'number',
          description: 'Number of lines to read. Defaults to 2000.',
        },
      },
      required: ['file_path'],
    },

    async execute(input: FileReadInput, ctx: ToolContext) {
      const ext = getExtension(input.file_path);

      // Handle image files
      if (IMAGE_EXTENSIONS.has(ext)) {
        const file = Bun.file(input.file_path);
        const exists = await file.exists();
        if (!exists) {
          throw new Error(`File not found: ${input.file_path}`);
        }
        const buffer = await file.arrayBuffer();
        const base64 = Buffer.from(buffer).toString('base64');
        const mimeMap: Record<string, string> = {
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.gif': 'image/gif',
          '.webp': 'image/webp',
        };
        return {
          type: 'image' as const,
          file: {
            base64,
            type: mimeMap[ext] ?? 'image/png',
            originalSize: buffer.byteLength,
          },
        };
      }

      // Handle text files
      const file = Bun.file(input.file_path);
      const exists = await file.exists();
      if (!exists) {
        throw new Error(`File not found: ${input.file_path}`);
      }

      const raw = await file.text();
      const allLines = raw.split('\n');
      const totalLines = allLines.length;

      // offset is 1-indexed; default to 1
      const startLine = Math.max(1, input.offset ?? 1);
      const lineLimit = input.limit ?? DEFAULT_LINE_LIMIT;

      // Slice the requested window (convert to 0-indexed)
      const sliced = allLines.slice(startLine - 1, startLine - 1 + lineLimit);
      const content = formatWithLineNumbers(sliced, startLine);

      return {
        type: 'text' as const,
        file: {
          filePath: input.file_path,
          content,
          numLines: sliced.length,
          startLine,
          totalLines,
        },
      };
    },
  };
}
