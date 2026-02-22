import type { ToolDefinition } from './types.js';

export function createWebFetchTool(): ToolDefinition {
  return {
    name: 'WebFetch',
    description: 'Fetch content from a URL and process it',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to fetch' },
        prompt: { type: 'string', description: 'Prompt to process the fetched content' },
      },
      required: ['url', 'prompt'],
    },
    async execute(input: { url: string; prompt: string }, ctx) {
      const start = Date.now();
      try {
        const response = await fetch(input.url, {
          headers: { 'User-Agent': 'OpenAgent/0.1.0' },
          signal: ctx.abortSignal,
        });

        const contentType = response.headers.get('content-type') || '';
        let text = await response.text();

        // Simple HTML → plain text conversion
        if (contentType.includes('html')) {
          text = text
            .replace(/<script[\s\S]*?<\/script>/gi, '')
            .replace(/<style[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        }

        // Truncate overly long content
        if (text.length > 50000) {
          text = text.slice(0, 50000) + '\n... (content truncated)';
        }

        return {
          bytes: text.length,
          code: response.status,
          codeText: response.statusText,
          result: text,
          durationMs: Date.now() - start,
          url: input.url,
        };
      } catch (error: unknown) {
        return {
          bytes: 0,
          code: 0,
          codeText: 'Error',
          result: `Failed to fetch: ${error instanceof Error ? error.message : String(error)}`,
          durationMs: Date.now() - start,
          url: input.url,
        };
      }
    },
  };
}
