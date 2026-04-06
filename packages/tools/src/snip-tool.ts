import { withToolDefaults } from './tool-defaults.js';
import type { ToolDefinition, ToolContext } from './types.js';

export function createSnipTool(): ToolDefinition {
  return withToolDefaults({
    name: 'Snip',
    description:
      'Force-trim the conversation history by removing the oldest N messages. ' +
      'Use when the context window is nearly full and the automatic compact pass ' +
      'is not sufficient.',
    inputSchema: {
      type: 'object',
      properties: {
        count: {
          type: 'number',
          description: 'Number of oldest messages to remove (default: 10, min: 1)',
        },
      },
    },
    capability: { category: 'utility', risk: 'low' },
    annotations: { readOnly: false },
    shouldDefer: true,
    async execute(input: { count?: number }, _ctx: ToolContext) {
      const count = Math.max(1, Math.floor(input.count ?? 10));
      // The _action field is a signal for ConversationLoop to trim its message
      // array after receiving this tool result.
      return {
        snipCount: count,
        _action: 'snip' as const,
        message: `Requested removal of ${count} oldest message${count === 1 ? '' : 's'} from conversation history.`,
      };
    },
  });
}
