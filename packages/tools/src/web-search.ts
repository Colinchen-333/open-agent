import type { ToolDefinition, ToolContext } from './types.js';

export function createWebSearchTool(): ToolDefinition {
  return {
    name: 'WebSearch',
    description: 'Search the web and return results. Use this for current events and recent information.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query to use' },
        allowed_domains: {
          type: 'array',
          items: { type: 'string' },
          description: 'Only include results from these domains',
        },
        blocked_domains: {
          type: 'array',
          items: { type: 'string' },
          description: 'Exclude results from these domains',
        },
      },
      required: ['query'],
    },
    async execute(input: any, _ctx: ToolContext) {
      const { query, allowed_domains, blocked_domains } = input;

      const applyDomainFilters = (
        results: { title: string; url: string; description: string }[],
      ) => {
        let filtered = results;
        if (allowed_domains?.length) {
          filtered = filtered.filter((r) =>
            (allowed_domains as string[]).some((d) => r.url.includes(d)),
          );
        }
        if (blocked_domains?.length) {
          filtered = filtered.filter(
            (r) => !(blocked_domains as string[]).some((d) => r.url.includes(d)),
          );
        }
        return filtered.slice(0, 10);
      };

      // Brave Search API
      const braveKey = process.env.BRAVE_SEARCH_API_KEY;
      if (braveKey) {
        const params = new URLSearchParams({ q: query, count: '10' });
        const resp = await fetch(
          `https://api.search.brave.com/res/v1/web/search?${params}`,
          {
            headers: {
              'X-Subscription-Token': braveKey,
              Accept: 'application/json',
            },
          },
        );
        if (!resp.ok) throw new Error(`Search API error: ${resp.status}`);
        const data = (await resp.json()) as any;
        const results = (data.web?.results ?? []).map((r: any) => ({
          title: r.title,
          url: r.url,
          description: r.description,
        }));

        return {
          results: applyDomainFilters(results),
          durationSeconds: 0,
        };
      }

      // Fallback: DuckDuckGo lite HTML scraping
      try {
        const params = new URLSearchParams({ q: query });
        const resp = await fetch(`https://lite.duckduckgo.com/lite/?${params}`, {
          headers: { 'User-Agent': 'OpenAgent/0.1' },
        });
        const html = await resp.text();

        const linkRegex =
          /<a[^>]+class="result-link"[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/gi;
        const snippetRegex =
          /<td[^>]+class="result-snippet"[^>]*>([\s\S]*?)<\/td>/gi;
        const results: { title: string; url: string; description: string }[] = [];

        let match;
        while ((match = linkRegex.exec(html)) !== null && results.length < 10) {
          results.push({ title: match[2].trim(), url: match[1], description: '' });
        }

        let i = 0;
        while ((match = snippetRegex.exec(html)) !== null && i < results.length) {
          results[i].description = match[1].replace(/<[^>]+>/g, '').trim();
          i++;
        }

        return { results: applyDomainFilters(results), durationSeconds: 0 };
      } catch {
        return {
          results: [],
          durationSeconds: 0,
          error: 'Search unavailable. Set BRAVE_SEARCH_API_KEY for web search.',
        };
      }
    },
  };
}
