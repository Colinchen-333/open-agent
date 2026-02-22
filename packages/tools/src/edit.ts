import type { ToolDefinition, ToolContext, FileEditInput } from './types.js';

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

      return {
        filePath: input.file_path,
        oldString: input.old_string.slice(0, 100),
        newString: input.new_string.slice(0, 100),
        replacements,
        originalFile: content,
        // Structured patch left as empty array; diff can be computed downstream if needed
        structuredPatch: [] as any[],
        userModified: false,
        replaceAll: input.replace_all ?? false,
      };
    },
  };
}
