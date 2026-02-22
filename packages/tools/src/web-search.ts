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
 * DuckDuckGo HTML search — scrapes the lite HTML page for actual web results.
 * More reliable than the Instant Answer API which only returns curated results.
 */
async function duckDuckGoSearch(query: string): Promise<SearchResult[]> {
  // Try the lite HTML version first for actual web results
  try {
    const params = new URLSearchParams({ q: query });
    const resp = await fetch(`https://lite.duckduckgo.com/lite/?${params}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; OpenAgent/0.1.0)',
      },
    });
    if (resp.ok) {
      const html = await resp.text();
      const results: SearchResult[] = [];
      // Parse result links from the lite HTML page
      const linkRegex = /<a[^>]+class="result-link"[^>]*href="([^"]+)"[^>]*>([^<]*)<\/a>/g;
      let match;
      while ((match = linkRegex.exec(html)) !== null && results.length < 10) {
        results.push({
          title: match[2].trim(),
          url: match[1],
          description: '',
        });
      }
      // Also try the snippet pattern
      const snippetRegex = /<td[^>]*class="result-snippet"[^>]*>([\s\S]*?)<\/td>/g;
      let snippetIdx = 0;
      while ((match = snippetRegex.exec(html)) !== null && snippetIdx < results.length) {
        results[snippetIdx].description = match[1].replace(/<[^>]+>/g, '').trim();
        snippetIdx++;
      }
      if (results.length > 0) return results;
    }
  } catch {
    // Fall through to JSON API
  }

  // Fallback: DuckDuckGo Instant Answer JSON API
  const params = new URLSearchParams({
    q: query,
    format: 'json',
    no_html: '1',
    skip_disambig: '1',
  });
  const resp = await fetch(`https://api.duckduckgo.com/?${params}`, {
    headers: {
      'User-Agent': 'OpenAgent/0.1.0',
      Accept: 'application/json',
    },
  });
  if (!resp.ok) throw new Error(`DuckDuckGo API error: ${resp.status} ${resp.statusText}`);

  const data = (await resp.json()) as any;
  const results: SearchResult[] = [];

  if (data.AbstractText && data.AbstractURL) {
    results.push({
      title: data.Heading ?? query,
      url: data.AbstractURL,
      description: data.AbstractText,
    });
  }

  const flatTopics: any[] = [];
  for (const topic of data.RelatedTopics ?? []) {
    if (Array.isArray(topic.Topics)) {
      flatTopics.push(...topic.Topics);
    } else {
      flatTopics.push(topic);
    }
  }

  for (const topic of flatTopics) {
    if (!topic.FirstURL || !topic.Text) continue;
    results.push({
      title: topic.Text.split(' - ')[0].trim(),
      url: topic.FirstURL,
      description: topic.Text,
    });
    if (results.length >= 10) break;
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
            note: braveKey || serpKey
              ? `${engine} returned no results for this query.`
              : 'No results. For better web search, set BRAVE_SEARCH_API_KEY or SERPAPI_KEY.',
          };
        }

        return { results, durationSeconds: 0, engine };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          results: [],
          durationSeconds: 0,
          error: `Search failed: ${message}. ${
            braveKey ? '' : 'Set BRAVE_SEARCH_API_KEY for more reliable web search.'
          }`.trim(),
        };
      }
    },
  };
}
