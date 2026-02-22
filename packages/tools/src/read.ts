import { statSync } from 'fs';
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
      'Read a file from the filesystem. Returns file contents with line numbers (cat -n style). For images returns metadata and file info. For PDF files returns size information and extraction instructions. Supports Jupyter notebooks (.ipynb), offset and limit for partial reads.',
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

      // Handle image files — return metadata only, not raw binary data.
      // Encoding megabytes of pixel data as base64 is wasteful and unhelpful
      // for text-based LLM workflows. Use Bash + an image tool if you need
      // to inspect actual pixel content.
      if (IMAGE_EXTENSIONS.has(ext)) {
        const file = Bun.file(input.file_path);
        const exists = await file.exists();
        if (!exists) {
          throw new Error(`File not found: ${input.file_path}`);
        }
        const stat = statSync(input.file_path);
        const mimeMap: Record<string, string> = {
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.gif': 'image/gif',
          '.webp': 'image/webp',
          '.bmp': 'image/bmp',
          '.svg': 'image/svg+xml',
        };
        const mimeType = mimeMap[ext] ?? 'image/octet-stream';
        const sizeKb = (stat.size / 1024).toFixed(1);

        // For SVG files we can read them as text since they are XML.
        if (ext === '.svg') {
          const content = await file.text();
          const lines = content.split('\n');
          const totalLines = lines.length;
          const startLine = Math.max(1, input.offset ?? 1);
          const lineLimit = input.limit ?? DEFAULT_LINE_LIMIT;
          const sliced = lines.slice(startLine - 1, startLine - 1 + lineLimit);
          return {
            type: 'text' as const,
            file: {
              filePath: input.file_path,
              content: formatWithLineNumbers(sliced, startLine),
              numLines: sliced.length,
              startLine,
              totalLines,
            },
          };
        }

        const message = [
          `Image file found: ${input.file_path}`,
          `Type: ${mimeType}`,
          `Size: ${sizeKb} KB (${stat.size} bytes)`,
          '',
          'This is a binary image file. Its raw contents are not returned to avoid',
          'transmitting large amounts of binary data. To work with this image:',
          '  - Use Bash to run image tools (e.g. `identify`, `exiftool`, `file`)',
          '  - Use Bash with `convert` (ImageMagick) to resize or convert the image',
          '  - If the image contains text, use `tesseract` for OCR extraction',
        ].join('\n');

        return {
          type: 'text' as const,
          file: {
            filePath: input.file_path,
            content: message,
            numLines: message.split('\n').length,
            startLine: 1,
            totalLines: message.split('\n').length,
          },
        };
      }

      // Handle PDF files — return metadata and extraction instructions rather
      // than a raw base64 blob, which is useless as LLM text input.
      if (ext === '.pdf') {
        const file = Bun.file(input.file_path);
        const exists = await file.exists();
        if (!exists) {
          throw new Error(`File not found: ${input.file_path}`);
        }
        const stat = statSync(input.file_path);
        const sizeMb = (stat.size / (1024 * 1024)).toFixed(2);

        const pageHint = input.pages ? ` (requested pages: ${input.pages})` : '';
        const message = [
          `PDF file found: ${input.file_path}${pageHint}`,
          `Size: ${sizeMb} MB (${stat.size} bytes)`,
          '',
          'PDF is a binary format. To extract readable text, use Bash with one of:',
          '  pdftotext "' + input.file_path + '" -    # outputs text to stdout',
          '  pdftotext -f 1 -l 5 "' + input.file_path + '" -  # pages 1-5 only',
          '  mutool draw -F text "' + input.file_path + '"     # alternative (mutool)',
          '',
          'If pdftotext is not installed: brew install poppler  (macOS)',
          '                               apt install poppler-utils  (Debian/Ubuntu)',
        ].join('\n');

        return {
          type: 'text' as const,
          file: {
            filePath: input.file_path,
            content: message,
            numLines: message.split('\n').length,
            startLine: 1,
            totalLines: message.split('\n').length,
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
