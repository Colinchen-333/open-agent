import type { ToolDefinition } from './types.js';

// Simple in-memory cache with 15-minute TTL for fetched URL content.
const CACHE_TTL_MS = 15 * 60 * 1000;
const MAX_CACHE_SIZE = 50;

interface CacheEntry {
  result: unknown;
  timestamp: number;
}

const fetchCache = new Map<string, CacheEntry>();

function getCached(url: string): unknown | null {
  const entry = fetchCache.get(url);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    fetchCache.delete(url);
    return null;
  }
  return entry.result;
}

function setCache(url: string, result: unknown): void {
  // Evict oldest entries if over limit
  if (fetchCache.size >= MAX_CACHE_SIZE) {
    const oldest = [...fetchCache.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp);
    for (let i = 0; i < Math.max(1, Math.floor(MAX_CACHE_SIZE / 4)); i++) {
      fetchCache.delete(oldest[i][0]);
    }
  }
  fetchCache.set(url, { result, timestamp: Date.now() });
}

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

      // Check cache first — return cached result if available
      const cached = getCached(url);
      if (cached) {
        return { ...(cached as Record<string, unknown>), fromCache: true };
      }

      try {
        // Create a timeout signal (30s) combined with user abort signal
        const timeoutController = new AbortController();
        const timeout = setTimeout(() => timeoutController.abort(), 30000);
        const combinedSignal = ctx.abortSignal
          ? AbortSignal.any([ctx.abortSignal, timeoutController.signal])
          : timeoutController.signal;

        // Manual redirect handling to enforce max redirect limit
        let currentUrl = url;
        let response: Response | null = null;
        const MAX_REDIRECTS = 10;
        for (let i = 0; i <= MAX_REDIRECTS; i++) {
          response = await fetch(currentUrl, {
            redirect: 'manual',
            headers: {
              'User-Agent':
                'Mozilla/5.0 (compatible; OpenAgent/0.1.0; +https://github.com/open-agent)',
              Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            },
            signal: combinedSignal,
          });
          const location = response.headers.get('location');
          if (location && response.status >= 300 && response.status < 400) {
            // Resolve relative URLs
            currentUrl = new URL(location, currentUrl).href;
            if (i === MAX_REDIRECTS) {
              clearTimeout(timeout);
              return {
                bytes: 0, code: 0, codeText: 'Error',
                result: `Too many redirects (>${MAX_REDIRECTS}) for ${url}`,
                durationMs: Date.now() - start, url,
              };
            }
            continue;
          }
          break;
        }
        clearTimeout(timeout);

        const contentType = response!.headers.get('content-type') || '';
        let text = await response!.text();

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

        const result = {
          bytes: text.length,
          code: response!.status,
          codeText: response!.statusText,
          result: text,
          durationMs: Date.now() - start,
          url: currentUrl, // reflect final URL after redirects
        };

        // Cache successful responses
        if (response!.status >= 200 && response!.status < 400) {
          setCache(url, result);
        }

        return result;
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
