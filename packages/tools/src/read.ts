import { statSync, readFileSync } from 'fs';
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
      // Track this file as "read" so Edit can enforce read-before-edit safety.
      ctx.fileReadTracker?.markRead(input.file_path);

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

        // Return base64-encoded image data for vision-capable LLMs.
        // The conversation loop detects this structured result and sends it
        // as an actual image content block so the model can "see" the image.
        const imageBytes = readFileSync(input.file_path);
        const base64 = imageBytes.toString('base64');

        return {
          type: 'image' as const,
          source: {
            type: 'base64' as const,
            media_type: mimeType,
            data: base64,
          },
          file_path: input.file_path,
          size_kb: sizeKb,
        };
      }

      // Handle PDF files — try to extract text via pdftotext if available,
      // falling back to metadata + instructions if not installed.
      if (ext === '.pdf') {
        const file = Bun.file(input.file_path);
        const exists = await file.exists();
        if (!exists) {
          throw new Error(`File not found: ${input.file_path}`);
        }

        // Try to extract text using pdftotext
        try {
          const pdfArgs = ['pdftotext'];

          // Parse pages parameter (e.g. "1-5", "3", "10-20")
          if (input.pages) {
            const pageMatch = input.pages.match(/^(\d+)(?:-(\d+))?$/);
            if (pageMatch) {
              pdfArgs.push('-f', pageMatch[1]);
              pdfArgs.push('-l', pageMatch[2] ?? pageMatch[1]);
            }
          }

          pdfArgs.push(input.file_path, '-'); // output to stdout

          const proc = Bun.spawn(pdfArgs, { stdout: 'pipe', stderr: 'pipe' });
          const text = await new Response(proc.stdout).text();
          await proc.exited;

          if (proc.exitCode === 0 && text.trim().length > 0) {
            const allLines = text.split('\n');
            const startLine = Math.max(1, input.offset ?? 1);
            const lineLimit = input.limit ?? DEFAULT_LINE_LIMIT;
            const sliced = allLines.slice(startLine - 1, startLine - 1 + lineLimit);

            return {
              type: 'text' as const,
              file: {
                filePath: input.file_path,
                content: formatWithLineNumbers(sliced, startLine),
                numLines: sliced.length,
                startLine,
                totalLines: allLines.length,
              },
            };
          }
        } catch {
          // pdftotext not available — fall through to instructions
        }

        const stat = statSync(input.file_path);
        const sizeMb = (stat.size / (1024 * 1024)).toFixed(2);
        const pageHint = input.pages ? ` (requested pages: ${input.pages})` : '';
        const message = [
          `PDF file found: ${input.file_path}${pageHint}`,
          `Size: ${sizeMb} MB (${stat.size} bytes)`,
          '',
          'PDF text extraction requires pdftotext. Install with:',
          '  brew install poppler  (macOS)',
          '  apt install poppler-utils  (Debian/Ubuntu)',
          '',
          'Then use Bash:',
          '  pdftotext "' + input.file_path + '" -',
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
        // Render notebook cells as human-readable text
        const parts: string[] = [];
        const language = notebook.metadata?.kernelspec?.language || 'python';
        parts.push(`Jupyter Notebook: ${input.file_path} (${language})`);
        parts.push('');

        const rawCells = (notebook.cells ?? []) as any[];
        for (let i = 0; i < rawCells.length; i++) {
          const cell = rawCells[i];
          const cellType = cell.cell_type as string;
          const source = Array.isArray(cell.source) ? (cell.source as string[]).join('') : (cell.source as string);

          parts.push(`--- Cell ${i + 1} [${cellType}] ---`);
          parts.push(source);

          // Render outputs for code cells
          const outputs = (cell.outputs ?? []) as any[];
          for (const o of outputs) {
            let text = '';
            if (o.text) {
              text = Array.isArray(o.text) ? (o.text as string[]).join('') : (o.text as string);
            } else if (o.data?.['text/plain']) {
              const plain = o.data['text/plain'];
              text = Array.isArray(plain) ? (plain as string[]).join('') : (plain as string);
            }
            if (text) {
              parts.push(`[Output]`);
              parts.push(text);
            } else if (o.output_type === 'error') {
              parts.push(`[Error: ${o.ename ?? 'Unknown'}] ${o.evalue ?? ''}`);
            }
          }
          parts.push('');
        }

        const nbLines = parts.join('\n').split('\n');
        const totalLines = nbLines.length;
        const offset = Math.max(0, (input.offset ?? 1) - 1);
        const limit = input.limit ?? totalLines;
        const sliced = nbLines.slice(offset, offset + limit);
        const nbContent = sliced.map((line, i) => `${String(offset + i + 1).padStart(6)}\t${line}`).join('\n');
        return {
          type: 'text' as const,
          file: {
            filePath: input.file_path,
            content: nbContent,
            numLines: sliced.length,
            startLine: offset + 1,
            totalLines,
          },
        };
      }

      // Handle text files
      const file = Bun.file(input.file_path);
      const exists = await file.exists();
      if (!exists) {
        throw new Error(`File not found: ${input.file_path}`);
      }

      // Binary file detection: read a small sample and check for null bytes.
      // This prevents garbled UTF-8 from being sent to the LLM.
      const stat = statSync(input.file_path);
      const sampleSize = Math.min(8192, stat.size);
      if (sampleSize > 0) {
        const sampleBuf = readFileSync(input.file_path, { flag: 'r' }).subarray(0, sampleSize);
        if (sampleBuf.includes(0)) {
          const sizeKb = (stat.size / 1024).toFixed(1);
          return {
            type: 'text' as const,
            file: {
              filePath: input.file_path,
              content: `Binary file detected: ${input.file_path} (${sizeKb} KB). Use appropriate tools to process binary files.`,
              numLines: 1,
              startLine: 1,
              totalLines: 1,
            },
          };
        }
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
