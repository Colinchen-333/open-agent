import { readFileSync, writeFileSync } from 'fs';
import type { ToolDefinition } from './types.js';

interface NotebookCell {
  id?: string;
  cell_type: string;
  source: string[];
  metadata: Record<string, unknown>;
  outputs?: unknown[];
  execution_count?: number | null;
}

interface Notebook {
  cells: NotebookCell[];
  metadata?: {
    kernelspec?: {
      language?: string;
    };
  };
  nbformat?: number;
  nbformat_minor?: number;
}

export function createNotebookEditTool(): ToolDefinition {
  return {
    name: 'NotebookEdit',
    description: 'Edit a Jupyter notebook cell',
    inputSchema: {
      type: 'object',
      properties: {
        notebook_path: { type: 'string', description: 'Path to the .ipynb file' },
        cell_id: { type: 'string', description: 'Cell ID to edit' },
        new_source: { type: 'string', description: 'New cell source code' },
        cell_type: { type: 'string', enum: ['code', 'markdown'] },
        edit_mode: { type: 'string', enum: ['replace', 'insert', 'delete'] },
      },
      required: ['notebook_path', 'new_source'],
    },
    async execute(
      input: {
        notebook_path: string;
        cell_id?: string;
        new_source: string;
        cell_type?: 'code' | 'markdown';
        edit_mode?: 'replace' | 'insert' | 'delete';
      },
      _ctx,
    ) {
      const originalFile = readFileSync(input.notebook_path, 'utf-8');
      const notebook: Notebook = JSON.parse(originalFile);
      const cells = notebook.cells || [];
      const editMode = input.edit_mode || 'replace';

      let targetIdx = -1;
      if (input.cell_id) {
        targetIdx = cells.findIndex((c) => c.id === input.cell_id);
      }

      const cellType = input.cell_type || 'code';

      // Split source into lines, preserving newline characters on all but the last line
      const sourceLines = input.new_source
        .split('\n')
        .map((line, i, arr) => (i < arr.length - 1 ? line + '\n' : line));

      const newCell: NotebookCell = {
        cell_type: cellType,
        source: sourceLines,
        metadata: {},
        ...(cellType !== 'markdown' ? { outputs: [], execution_count: null } : {}),
        id: input.cell_id || randomId(),
      };

      if (editMode === 'insert') {
        if (targetIdx >= 0) {
          cells.splice(targetIdx + 1, 0, newCell);
        } else {
          cells.push(newCell);
        }
      } else if (editMode === 'delete') {
        if (targetIdx >= 0) {
          cells.splice(targetIdx, 1);
        }
      } else {
        // replace
        if (targetIdx >= 0) {
          cells[targetIdx] = {
            ...cells[targetIdx],
            source: newCell.source,
            cell_type: newCell.cell_type,
          };
        } else if (cells.length > 0) {
          cells[0] = { ...cells[0], source: newCell.source };
        }
      }

      notebook.cells = cells;
      const updatedFile = JSON.stringify(notebook, null, 1);
      writeFileSync(input.notebook_path, updatedFile, 'utf-8');

      return {
        new_source: input.new_source,
        cell_id: input.cell_id,
        cell_type: cellType,
        language: notebook.metadata?.kernelspec?.language || 'python',
        edit_mode: editMode,
        notebook_path: input.notebook_path,
        original_file: originalFile,
        updated_file: updatedFile,
      };
    },
  };
}

function randomId(): string {
  // Use crypto.randomUUID() for proper uniqueness, then take 8 chars from the
  // hex representation.  This is collision-resistant unlike Math.random().
  try {
    return require('crypto').randomUUID().replace(/-/g, '').slice(0, 8);
  } catch {
    // Fallback for environments without crypto
    return Math.random().toString(36).slice(2, 10);
  }
}
