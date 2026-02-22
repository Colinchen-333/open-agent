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
 * DuckDuckGo Instant Answer JSON API.
 *
 * Endpoint: https://api.duckduckgo.com/?q=QUERY&format=json&no_html=1
 *
 * The API returns an `AbstractText` summary and a `RelatedTopics` array.
 * Each topic has a `Text` field and a `FirstURL`. Nested topics (those with
 * a `Topics` sub-array instead of `Text`) are flattened one level deep.
 *
 * Note: DDG's Instant Answer API is not a full web-search API — it returns
 * curated results (Wikipedia summaries, Wikidata facts, etc.) and may return
 * empty results for very specific or recent queries.
 */
async function duckDuckGoSearch(query: string): Promise<SearchResult[]> {
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

  // Top abstract (e.g. Wikipedia summary)
  if (data.AbstractText && data.AbstractURL) {
    results.push({
      title: data.Heading ?? query,
      url: data.AbstractURL,
      description: data.AbstractText,
    });
  }

  // Flatten RelatedTopics (some entries have nested Topics arrays)
  const flatTopics: any[] = [];
  for (const topic of data.RelatedTopics ?? []) {
    if (Array.isArray(topic.Topics)) {
      // Category group — flatten one level
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

      try {
        let rawResults: SearchResult[];

        if (braveKey) {
          // Preferred path: full web search via Brave
          rawResults = await braveSearch(query, braveKey);
        } else {
          // Fallback: DuckDuckGo Instant Answer JSON API (no key required)
          rawResults = await duckDuckGoSearch(query);
        }

        const results = applyDomainFilters(rawResults, allowed_domains, blocked_domains);

        if (results.length === 0) {
          return {
            results: [],
            durationSeconds: 0,
            note: braveKey
              ? 'Brave Search returned no results for this query.'
              : 'DuckDuckGo returned no results. For full web search, set the ' +
                'BRAVE_SEARCH_API_KEY environment variable.',
          };
        }

        return { results, durationSeconds: 0 };
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
