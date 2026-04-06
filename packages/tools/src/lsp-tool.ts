import { withToolDefaults } from './tool-defaults.js';
import { feature } from '@open-agent/core';
import type { ToolDefinition, ToolContext } from './types.js';

export type LSPAction = 'definition' | 'references' | 'completion' | 'diagnostics' | 'hover';

export function createLSPTool(): ToolDefinition {
  return withToolDefaults({
    name: 'LSP',
    description:
      'Query the Language Server Protocol for code intelligence: go-to-definition, ' +
      'find-references, completions, diagnostics, and hover info. Requires an LSP ' +
      'server to be configured via OPEN_AGENT_FEATURE_ENABLE_LSP_TOOL=1.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['definition', 'references', 'completion', 'diagnostics', 'hover'],
          description: 'LSP action to perform',
        },
        file: {
          type: 'string',
          description: 'Absolute or cwd-relative file path',
        },
        line: {
          type: 'number',
          description: 'Line number (1-based)',
        },
        character: {
          type: 'number',
          description: 'Character/column offset (0-based)',
        },
      },
      required: ['action', 'file'],
    },
    capability: { category: 'search', risk: 'low' },
    annotations: { readOnly: true },
    shouldDefer: true,
    async execute(
      input: { action: LSPAction; file: string; line?: number; character?: number },
      _ctx: ToolContext,
    ) {
      if (!feature('ENABLE_LSP_TOOL')) {
        return {
          error: 'LSP tool is not enabled. Set OPEN_AGENT_FEATURE_ENABLE_LSP_TOOL=1 to activate.',
        };
      }

      // Stub: returns a structured placeholder so callers can pattern-match
      // the response shape.  Wire a real LSP client here when ready.
      return {
        action: input.action,
        file: input.file,
        line: input.line ?? null,
        character: input.character ?? null,
        result: null,
        message:
          `LSP ${input.action} for ${input.file}` +
          (input.line != null ? `:${input.line}` : '') +
          ' — LSP server not configured. Wire an LSP client to populate result.',
      };
    },
  });
}
