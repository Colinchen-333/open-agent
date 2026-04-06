import { withToolDefaults } from './tool-defaults.js';
import type { ToolDefinition } from './types.js';

const MAX_SLEEP_SECONDS = 300;

export function createSleepTool(): ToolDefinition {
  return withToolDefaults({
    name: 'Sleep',
    description:
      'Pause execution for a specified duration. Useful for waiting between operations ' +
      'or polling for external state changes.',
    inputSchema: {
      type: 'object',
      properties: {
        seconds: {
          type: 'number',
          description: `Duration to sleep in seconds (max ${MAX_SLEEP_SECONDS})`,
        },
      },
      required: ['seconds'],
    },
    capability: { category: 'utility', risk: 'low' },
    annotations: { readOnly: true, idempotent: true },
    shouldDefer: true,
    // Custom timeout: max sleep + 5 s buffer so ConversationLoop doesn't abort first
    timeout: (MAX_SLEEP_SECONDS + 5) * 1000,
    async execute(input: { seconds: number }) {
      const seconds = Math.min(Math.max(0, input.seconds), MAX_SLEEP_SECONDS);
      await new Promise<void>(resolve => setTimeout(resolve, seconds * 1000));
      return {
        slept: seconds,
        message: `Paused for ${seconds} second${seconds === 1 ? '' : 's'}.`,
      };
    },
  });
}
