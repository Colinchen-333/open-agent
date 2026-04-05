import type { HookEvent } from './types.js';

export interface RuntimeHookSurfaceSummary {
  event: string;
  count: number;
  sources: string[];
}

export interface RuntimeHookSurfaceConfig {
  source: string;
  config?: Partial<Record<HookEvent, unknown[]>>;
}

export function buildRuntimeHookSurfaceSummary(
  existing: RuntimeHookSurfaceSummary[] = [],
  ...configs: RuntimeHookSurfaceConfig[]
): RuntimeHookSurfaceSummary[] {
  const merged = new Map<string, { count: number; sources: Set<string> }>();

  for (const summary of existing) {
    merged.set(summary.event, {
      count: summary.count,
      sources: new Set(summary.sources),
    });
  }

  for (const { source, config } of configs) {
    if (!config) continue;
    for (const [event, entries] of Object.entries(config) as [HookEvent, unknown[]][]) {
      if (!Array.isArray(entries) || entries.length === 0) continue;
      const current = merged.get(event) ?? { count: 0, sources: new Set<string>() };
      current.count += entries.length;
      current.sources.add(source);
      merged.set(event, current);
    }
  }

  return [...merged.entries()]
    .map(([event, summary]) => ({
      event,
      count: summary.count,
      sources: [...summary.sources].sort(),
    }))
    .sort((a, b) => a.event.localeCompare(b.event));
}
