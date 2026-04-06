import { withToolDefaults } from './tool-defaults.js';
import type { ToolDefinition, ToolContext } from './types.js';

export function createBriefTool(): ToolDefinition {
  return withToolDefaults({
    name: 'Brief',
    description:
      'Toggle brief mode for this session. When active, prefer concise output: ' +
      'skip explanations, lead with code, minimize prose.',
    inputSchema: {
      type: 'object',
      properties: {
        enable: {
          type: 'boolean',
          description: 'true to enable brief mode, false to disable',
        },
      },
      required: ['enable'],
    },
    capability: { category: 'configuration', risk: 'low' },
    annotations: { readOnly: true, idempotent: true },
    async execute(input: { enable: boolean }, ctx: ToolContext) {
      // Store brief mode in app state if available
      if (ctx.setAppState) {
        try {
          ctx.setAppState((prev: any) => ({ ...prev, briefMode: input.enable }));
        } catch {
          // swallow — state update is best-effort
        }
      }

      return {
        briefMode: input.enable,
        message: input.enable
          ? 'Brief mode ON. Output will be concise: code-first, no explanations unless asked.'
          : 'Brief mode OFF. Output will be normal verbosity.',
      };
    },
  });
}
