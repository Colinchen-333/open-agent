import type { ToolDefinition, ToolContext, FileEditInput } from './types.js';

/**
 * Generate a simple unified-style diff showing the changed lines and up to
 * 3 lines of context before/after the change.  The output is intentionally
 * minimal — it exists purely for human-readable terminal display, not for
 * machine consumption via `patch`.
 */
function generateSimplePatch(filePath: string, oldContent: string, newContent: string): string {
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');

  // Find the first line that differs.
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) {
    start++;
  }

  // Find the last differing line (working backwards from the end).
  let oldEnd = oldLines.length - 1;
  let newEnd = newLines.length - 1;
  while (oldEnd > start && newEnd > start && oldLines[oldEnd] === newLines[newEnd]) {
    oldEnd--;
    newEnd--;
  }

  // Context window: up to 3 lines before and after the change.
  const contextBefore = Math.max(0, start - 3);
  const contextAfter = newEnd + 3;

  const lines: string[] = [`--- ${filePath}`, `+++ ${filePath}`];

  // Emit context lines before the change.
  for (let i = contextBefore; i < start; i++) {
    if (i < newLines.length) {
      lines.push(`  ${newLines[i]}`);
    }
  }

  // Emit removed lines (present in old but not in new).
  for (let i = start; i <= oldEnd; i++) {
    if (i < oldLines.length) {
      lines.push(`- ${oldLines[i]}`);
    }
  }

  // Emit added lines (present in new but not in old).
  for (let i = start; i <= newEnd; i++) {
    if (i < newLines.length) {
      lines.push(`+ ${newLines[i]}`);
    }
  }

  // Emit context lines after the change.
  for (let i = newEnd + 1; i <= contextAfter; i++) {
    if (i < newLines.length) {
      lines.push(`  ${newLines[i]}`);
    }
  }

  return lines.join('\n');
}

export function createEditTool(): ToolDefinition {
  return {
    name: 'Edit',
    description: 'Perform an exact string replacement in a file. By default ensures old_string appears exactly once (use replace_all to replace every occurrence).',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Absolute path to the file to edit',
        },
        old_string: {
          type: 'string',
          description: 'The exact text to find and replace',
        },
        new_string: {
          type: 'string',
          description: 'The replacement text',
        },
        replace_all: {
          type: 'boolean',
          default: false,
          description: 'Replace all occurrences instead of requiring uniqueness',
        },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },

    async execute(input: FileEditInput, ctx: ToolContext) {
      // Reject no-op edits where old and new strings are identical.
      if (input.old_string === input.new_string) {
        throw new Error(
          'old_string and new_string are identical. No changes to make.'
        );
      }

      // Enforce read-before-edit safety: the LLM must have read the file
      // at least once in this conversation before it can edit it.  This
      // prevents blind edits that could silently corrupt files.
      if (ctx.fileReadTracker && !ctx.fileReadTracker.hasBeenRead(input.file_path)) {
        throw new Error(
          `You must use the Read tool to read ${input.file_path} before editing it. ` +
          `This ensures you have the current file contents and can make accurate edits.`
        );
      }

      const file = Bun.file(input.file_path);
      const exists = await file.exists();
      if (!exists) {
        throw new Error(`File not found: ${input.file_path}`);
      }

      const content = await file.text();

      if (!input.replace_all) {
        // Count occurrences to enforce uniqueness
        const count = content.split(input.old_string).length - 1;
        if (count === 0) {
          throw new Error(`old_string not found in ${input.file_path}`);
        }
        if (count > 1) {
          throw new Error(
            `old_string found ${count} times in ${input.file_path}. Provide more context to make it unique, or set replace_all: true.`
          );
        }
      }

      const newContent = input.replace_all
        ? content.replaceAll(input.old_string, input.new_string)
        : content.replace(input.old_string, input.new_string);

      await Bun.write(input.file_path, newContent);

      const replacements = input.replace_all
        ? content.split(input.old_string).length - 1
        : 1;

      // Generate a human-readable unified diff for terminal display.
      const patch = generateSimplePatch(input.file_path, content, newContent);

      return {
        filePath: input.file_path,
        oldString: input.old_string.slice(0, 100),
        newString: input.new_string.slice(0, 100),
        replacements,
        patch,
        originalFile: content,
        structuredPatch: [] as any[],
        userModified: false,
        replaceAll: input.replace_all ?? false,
      };
    },
  };
}
