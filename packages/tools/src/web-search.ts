import type { ToolDefinition, ToolContext } from './types.js';

interface SearchResult {
  title: string;
  url: string;
  description: string;
}

/**
 * Apply allowed/blocked domain filters and cap the list at 10 results.
 */
function applyDomainFilters(
  results: SearchResult[],
  allowedDomains?: string[],
  blockedDomains?: string[],
): SearchResult[] {
  let filtered = results;
  if (allowedDomains?.length) {
    filtered = filtered.filter((r) => allowedDomains.some((d) => r.url.includes(d)));
  }
  if (blockedDomains?.length) {
    filtered = filtered.filter((r) => !blockedDomains.some((d) => r.url.includes(d)));
  }
  return filtered.slice(0, 10);
}

/**
 * Brave Search — requires BRAVE_SEARCH_API_KEY environment variable.
 */
async function braveSearch(query: string, apiKey: string): Promise<SearchResult[]> {
  const params = new URLSearchParams({ q: query, count: '10' });
  const resp = await fetch(`https://api.search.brave.com/res/v1/web/search?${params}`, {
    headers: {
      'X-Subscription-Token': apiKey,
      Accept: 'application/json',
    },
  });
  if (!resp.ok) throw new Error(`Brave Search API error: ${resp.status} ${resp.statusText}`);
  const data = (await resp.json()) as any;
  return (data.web?.results ?? []).map((r: any) => ({
    title: r.title ?? '',
    url: r.url ?? '',
    description: r.description ?? '',
  }));
}

/**
 * SerpAPI Google Search — requires SERPAPI_KEY environment variable.
 */
async function serpApiSearch(query: string, apiKey: string): Promise<SearchResult[]> {
  const params = new URLSearchParams({
    q: query,
    api_key: apiKey,
    engine: 'google',
    num: '10',
  });
  const resp = await fetch(`https://serpapi.com/search?${params}`);
  if (!resp.ok) throw new Error(`SerpAPI error: ${resp.status} ${resp.statusText}`);
  const data = (await resp.json()) as any;
  return (data.organic_results ?? []).map((r: any) => ({
    title: r.title ?? '',
    url: r.link ?? '',
    description: r.snippet ?? '',
  }));
}

/**
 * DuckDuckGo HTML search — POST to html.duckduckgo.com for actual web results.
 * Uses the full HTML version (not lite) with a realistic User-Agent for reliability.
 */
async function duckDuckGoSearch(query: string): Promise<SearchResult[]> {
  // html.duckduckgo.com/html/ is the non-JS results page, POST is more reliable
  const body = new URLSearchParams({ q: query, b: '' });
  const resp = await fetch('https://html.duckduckgo.com/html/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      Accept: 'text/html',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    body,
  });
  if (!resp.ok) throw new Error(`DuckDuckGo search error: ${resp.status}`);

  const html = await resp.text();
  const results: SearchResult[] = [];

  // Match result links: <a rel="nofollow" class="result__a" href="...">title</a>
  const linkRegex = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let match;
  while ((match = linkRegex.exec(html)) !== null && results.length < 10) {
    const url = match[1].trim();
    const title = match[2].replace(/<[^>]+>/g, '').trim();
    if (!url || !title) continue;
    // Skip DuckDuckGo internal redirect URLs, extract the actual URL
    let finalUrl = url;
    if (url.startsWith('//duckduckgo.com/l/?')) {
      try {
        const uddg = new URL(`https:${url}`).searchParams.get('uddg');
        if (uddg) finalUrl = uddg;
      } catch { /* use original */ }
    }
    results.push({ title, url: finalUrl, description: '' });
  }

  // Match snippets: <a class="result__snippet" ...>description</a>
  // or <td class="result-snippet">...</td> (lite version)
  const snippetRegex = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let snippetIdx = 0;
  while ((match = snippetRegex.exec(html)) !== null && snippetIdx < results.length) {
    results[snippetIdx].description = match[1].replace(/<[^>]+>/g, '').trim();
    snippetIdx++;
  }

  // If html.duckduckgo.com parsing failed, try lite version as fallback
  if (results.length === 0) {
    try {
      const liteParams = new URLSearchParams({ q: query });
      const liteResp = await fetch(`https://lite.duckduckgo.com/lite/?${liteParams}`, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        },
      });
      if (liteResp.ok) {
        const liteHtml = await liteResp.text();
        // Lite uses different class names
        const liteLinkRegex = /<a[^>]+class="result-link"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
        while ((match = liteLinkRegex.exec(liteHtml)) !== null && results.length < 10) {
          const url = match[1].trim();
          const title = match[2].replace(/<[^>]+>/g, '').trim();
          if (url && title) results.push({ title, url, description: '' });
        }
        const liteSnippetRegex = /<td[^>]*class="result-snippet"[^>]*>([\s\S]*?)<\/td>/g;
        snippetIdx = 0;
        while ((match = liteSnippetRegex.exec(liteHtml)) !== null && snippetIdx < results.length) {
          results[snippetIdx].description = match[1].replace(/<[^>]+>/g, '').trim();
          snippetIdx++;
        }
      }
    } catch { /* ignore lite fallback errors */ }
  }

  return results;
}

export function createWebSearchTool(): ToolDefinition {
  return {
    name: 'WebSearch',
    description:
      'Search the web and return results. Use this for current events and recent information.',
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
      const { query, allowed_domains, blocked_domains } = input as {
        query: string;
        allowed_domains?: string[];
        blocked_domains?: string[];
      };

      const braveKey = process.env.BRAVE_SEARCH_API_KEY;
      const serpKey = process.env.SERPAPI_KEY;

      try {
        let rawResults: SearchResult[];
        let engine: string;

        if (braveKey) {
          rawResults = await braveSearch(query, braveKey);
          engine = 'brave';
        } else if (serpKey) {
          rawResults = await serpApiSearch(query, serpKey);
          engine = 'serpapi';
        } else {
          rawResults = await duckDuckGoSearch(query);
          engine = 'duckduckgo';
        }

        const results = applyDomainFilters(rawResults, allowed_domains, blocked_domains);

        if (results.length === 0) {
          return {
            results: [],
            durationSeconds: 0,
            engine,
            note: `No results found for "${query}". Try rephrasing or using different keywords.`,
          };
        }

        return { results, durationSeconds: 0, engine };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          results: [],
          durationSeconds: 0,
          error: `Search failed: ${message}. Try rephrasing the query.`,
        };
      }
    },
  };
}
