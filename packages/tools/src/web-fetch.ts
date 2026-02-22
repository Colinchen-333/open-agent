import type { ToolDefinition } from './types.js';

/**
 * Convert an HTML string to Markdown-flavored plain text.
 * Order matters: block-level conversions run before tag stripping.
 * @internal
 */
export function htmlToMarkdown(html: string): string {
  let text = html;

  // Remove script and style blocks entirely (content included)
  text = text.replace(/<script[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[\s\S]*?<\/style>/gi, '');

  // Pre blocks — wrap content in fenced code blocks
  text = text.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_m, inner) => {
    // Strip any inner tags (e.g. <code>) so we get raw text
    const code = inner.replace(/<[^>]+>/g, '');
    return `\n\`\`\`\n${code}\n\`\`\`\n`;
  });

  // Headings h1–h6
  text = text.replace(/<h1[^>]*>/gi, '\n# ');
  text = text.replace(/<h2[^>]*>/gi, '\n## ');
  text = text.replace(/<h3[^>]*>/gi, '\n### ');
  text = text.replace(/<h4[^>]*>/gi, '\n#### ');
  text = text.replace(/<h5[^>]*>/gi, '\n##### ');
  text = text.replace(/<h6[^>]*>/gi, '\n###### ');
  text = text.replace(/<\/h[1-6]>/gi, '\n');

  // Paragraphs → double newline
  text = text.replace(/<\/p>/gi, '\n\n');
  text = text.replace(/<p[^>]*>/gi, '\n\n');

  // Line breaks
  text = text.replace(/<br\s*\/?>/gi, '\n');

  // List items
  text = text.replace(/<li[^>]*>/gi, '\n- ');
  text = text.replace(/<\/li>/gi, '');

  // Anchors: <a href="URL">text</a> → [text](URL)
  text = text.replace(/<a[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href, inner) => {
    const label = inner.replace(/<[^>]+>/g, '').trim();
    return label ? `[${label}](${href})` : href;
  });

  // Inline code
  text = text.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_m, inner) => `\`${inner}\``);

  // Bold
  text = text.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/(strong|b)>/gi, (_m, _t, inner) => `**${inner}**`);

  // Italic
  text = text.replace(/<(em|i)[^>]*>([\s\S]*?)<\/(em|i)>/gi, (_m, _t, inner) => `*${inner}*`);

  // Strip all remaining tags
  text = text.replace(/<[^>]+>/g, '');

  // Decode common HTML entities
  text = text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');

  // Collapse runs of 3+ newlines to a maximum of 2
  text = text.replace(/\n{3,}/g, '\n\n');

  return text.trim();
}

export function createWebFetchTool(): ToolDefinition {
  return {
    name: 'WebFetch',
    // The `prompt` field is included so the LLM can describe what it wants
    // from the page. The actual content processing is performed by the LLM
    // after it receives the converted text — no secondary LLM call is needed.
    description: 'Fetch content from a URL and convert it to readable Markdown text. ' +
      'The prompt parameter describes what you are looking for; use it to guide ' +
      'your own interpretation of the returned content.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to fetch' },
        prompt: {
          type: 'string',
          description: 'Describe what information you want to extract from the page. ' +
            'This guides your interpretation of the returned content.',
        },
      },
      required: ['url', 'prompt'],
    },
    async execute(input: { url: string; prompt: string }, ctx) {
      const start = Date.now();

      // Upgrade HTTP to HTTPS
      let url = input.url;
      if (url.startsWith('http://')) {
        url = 'https://' + url.slice('http://'.length);
      }

      try {
        const response = await fetch(url, {
          redirect: 'follow',
          headers: {
            'User-Agent':
              'Mozilla/5.0 (compatible; OpenAgent/0.1.0; +https://github.com/open-agent)',
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          },
          signal: ctx.abortSignal,
        });

        const contentType = response.headers.get('content-type') || '';
        let text = await response.text();

        if (contentType.includes('html')) {
          text = htmlToMarkdown(text);
        } else {
          // For plain text / JSON / other, just trim whitespace runs
          text = text.replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n');
        }

        // Truncate to avoid overwhelming the context window
        const LIMIT = 50_000;
        if (text.length > LIMIT) {
          text = text.slice(0, LIMIT) + '\n\n... (content truncated)';
        }

        return {
          bytes: text.length,
          code: response.status,
          codeText: response.statusText,
          result: text,
          durationMs: Date.now() - start,
          url: response.url ?? url, // reflect final URL after redirects
        };
      } catch (error: unknown) {
        return {
          bytes: 0,
          code: 0,
          codeText: 'Error',
          result: `Failed to fetch: ${error instanceof Error ? error.message : String(error)}`,
          durationMs: Date.now() - start,
          url,
        };
      }
    },
  };
}
