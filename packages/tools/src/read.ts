import { readFileSync, statSync } from 'fs';
import type { ToolDefinition, ToolContext, FileReadInput } from './types.js';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']);
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
    description:
      'Read a file from the filesystem. Returns file contents with line numbers (cat -n style). For images returns base64 data. Supports PDF files, Jupyter notebooks (.ipynb), offset and limit for partial reads.',
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
        pages: {
          type: 'string',
          description: 'Page range for PDF files (e.g. "1-5", "3", "10-20"). Max 20 pages per request.',
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
          '.bmp': 'image/bmp',
          '.svg': 'image/svg+xml',
        };
        return {
          type: 'image' as const,
          file: {
            filePath: input.file_path,
            base64,
            type: mimeMap[ext] ?? 'image/png',
            originalSize: buffer.byteLength,
          },
        };
      }

      // Handle PDF files
      if (ext === '.pdf') {
        const file = Bun.file(input.file_path);
        const exists = await file.exists();
        if (!exists) {
          throw new Error(`File not found: ${input.file_path}`);
        }
        const buffer = await file.arrayBuffer();
        const base64 = Buffer.from(buffer).toString('base64');
        const stat = statSync(input.file_path);
        return {
          type: 'pdf' as const,
          file: {
            filePath: input.file_path,
            base64,
            pages: input.pages,
            originalSize: stat.size,
          },
        };
      }

      // Handle Jupyter Notebook files
      if (ext === '.ipynb') {
        const file = Bun.file(input.file_path);
        const exists = await file.exists();
        if (!exists) {
          throw new Error(`File not found: ${input.file_path}`);
        }
        const content = await file.text();
        let notebook: any;
        try {
          notebook = JSON.parse(content);
        } catch {
          throw new Error(`Failed to parse Jupyter notebook: ${input.file_path}`);
        }
        const cells = ((notebook.cells ?? []) as any[]).map((cell: any, i: number) => ({
          index: i,
          cell_type: cell.cell_type as string,
          source: Array.isArray(cell.source) ? (cell.source as string[]).join('') : (cell.source as string),
          outputs: ((cell.outputs ?? []) as any[]).map((o: any) => {
            if (o.text) {
              return {
                type: 'text' as const,
                text: Array.isArray(o.text) ? (o.text as string[]).join('') : (o.text as string),
              };
            }
            if (o.data?.['text/plain']) {
              const plain = o.data['text/plain'];
              return {
                type: 'text' as const,
                text: Array.isArray(plain) ? (plain as string[]).join('') : (plain as string),
              };
            }
            return { type: o.output_type as string };
          }),
        }));
        return {
          type: 'notebook' as const,
          file: { filePath: input.file_path, cells },
        };
      }

      // Handle text files
      const file = Bun.file(input.file_path);
      const exists = await file.exists();
      if (!exists) {
        throw new Error(`File not found: ${input.file_path}`);
      }

      const raw = await file.text();

      // Empty file detection
      if (raw.length === 0) {
        return {
          type: 'text' as const,
          file: {
            filePath: input.file_path,
            content: '[File exists but is empty]',
            numLines: 0,
            startLine: 1,
            totalLines: 0,
          },
        };
      }

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
