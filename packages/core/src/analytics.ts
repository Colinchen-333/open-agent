/**
 * Analytics and telemetry service.
 * Tracks events, token usage, costs, and performance metrics.
 * Designed for local-first operation with optional remote export.
 */

export type EventCategory = 'tool' | 'provider' | 'permission' | 'session' | 'agent' | 'mcp' | 'error' | 'user';

export interface AnalyticsEvent {
  id: string;
  category: EventCategory;
  action: string;
  label?: string;
  value?: number;
  metadata?: Record<string, unknown>;
  timestamp: string;
  sessionId?: string;
  durationMs?: number;
}

export interface SessionMetrics {
  sessionId: string;
  startedAt: string;
  endedAt?: string;
  totalTurns: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCostUsd: number;
  totalDurationMs: number;
  toolUseCounts: Record<string, number>;
  providerCalls: number;
  errors: number;
  permissionPrompts: number;
  permissionApprovals: number;
  permissionDenials: number;
}

export interface PerformanceMetric {
  name: string;
  value: number;
  unit: 'ms' | 'bytes' | 'count' | 'percent';
  timestamp: string;
}

/**
 * Analytics collector — accumulates events and metrics in memory.
 */
export class AnalyticsCollector {
  private events: AnalyticsEvent[] = [];
  private metrics: PerformanceMetric[] = [];
  private sessionMetrics: SessionMetrics;
  private maxEvents: number;
  private nextId = 0;

  constructor(sessionId: string, opts?: { maxEvents?: number }) {
    this.maxEvents = opts?.maxEvents ?? 10000;
    this.sessionMetrics = {
      sessionId,
      startedAt: new Date().toISOString(),
      totalTurns: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCostUsd: 0,
      totalDurationMs: 0,
      toolUseCounts: {},
      providerCalls: 0,
      errors: 0,
      permissionPrompts: 0,
      permissionApprovals: 0,
      permissionDenials: 0,
    };
  }

  /** Log an analytics event. */
  logEvent(event: Omit<AnalyticsEvent, 'id' | 'timestamp'>): void {
    const entry: AnalyticsEvent = {
      ...event,
      id: `evt-${++this.nextId}`,
      timestamp: new Date().toISOString(),
      sessionId: this.sessionMetrics.sessionId,
    };
    this.events.push(entry);

    // Evict oldest when over limit
    if (this.events.length > this.maxEvents) {
      this.events = this.events.slice(-Math.floor(this.maxEvents * 0.8));
    }

    // Update session metrics based on event category
    this.updateMetrics(entry);
  }

  private updateMetrics(event: AnalyticsEvent): void {
    switch (event.category) {
      case 'tool':
        this.sessionMetrics.toolUseCounts[event.action] =
          (this.sessionMetrics.toolUseCounts[event.action] ?? 0) + 1;
        break;
      case 'provider':
        this.sessionMetrics.providerCalls++;
        if (event.metadata?.inputTokens) {
          this.sessionMetrics.totalInputTokens += event.metadata.inputTokens as number;
        }
        if (event.metadata?.outputTokens) {
          this.sessionMetrics.totalOutputTokens += event.metadata.outputTokens as number;
        }
        if (event.metadata?.cacheReadTokens) {
          this.sessionMetrics.totalCacheReadTokens += event.metadata.cacheReadTokens as number;
        }
        if (event.metadata?.costUsd) {
          this.sessionMetrics.totalCostUsd += event.metadata.costUsd as number;
        }
        if (event.durationMs) {
          this.sessionMetrics.totalDurationMs += event.durationMs;
        }
        this.sessionMetrics.totalTurns++;
        break;
      case 'permission':
        this.sessionMetrics.permissionPrompts++;
        if (event.action === 'approved') this.sessionMetrics.permissionApprovals++;
        if (event.action === 'denied') this.sessionMetrics.permissionDenials++;
        break;
      case 'error':
        this.sessionMetrics.errors++;
        break;
    }
  }

  /** Record a performance metric. */
  recordMetric(name: string, value: number, unit: PerformanceMetric['unit']): void {
    this.metrics.push({ name, value, unit, timestamp: new Date().toISOString() });
  }

  /** Get all events, optionally filtered by category. */
  getEvents(category?: EventCategory): AnalyticsEvent[] {
    return category ? this.events.filter(e => e.category === category) : [...this.events];
  }

  /** Get session metrics summary. */
  getSessionMetrics(): SessionMetrics {
    return { ...this.sessionMetrics, toolUseCounts: { ...this.sessionMetrics.toolUseCounts } };
  }

  /** Get performance metrics, optionally filtered by name. */
  getPerformanceMetrics(name?: string): PerformanceMetric[] {
    return name ? this.metrics.filter(m => m.name === name) : [...this.metrics];
  }

  /** Get top N most-used tools. */
  getTopTools(n = 10): Array<{ tool: string; count: number }> {
    return Object.entries(this.sessionMetrics.toolUseCounts)
      .map(([tool, count]) => ({ tool, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, n);
  }

  /** Format a human-readable session summary. */
  formatSummary(): string {
    const m = this.sessionMetrics;
    const lines = [
      `Session: ${m.sessionId}`,
      `Duration: ${(m.totalDurationMs / 1000).toFixed(1)}s`,
      `Turns: ${m.totalTurns}`,
      `Tokens: ${m.totalInputTokens} in / ${m.totalOutputTokens} out (${m.totalCacheReadTokens} cache)`,
      `Cost: $${m.totalCostUsd.toFixed(4)}`,
      `Tools: ${Object.keys(m.toolUseCounts).length} unique, ${Object.values(m.toolUseCounts).reduce((s, c) => s + c, 0)} calls`,
      `Permissions: ${m.permissionApprovals} approved / ${m.permissionDenials} denied / ${m.permissionPrompts} total`,
      `Errors: ${m.errors}`,
    ];
    return lines.join('\n');
  }

  /** End the session (mark endedAt). */
  endSession(): void {
    this.sessionMetrics.endedAt = new Date().toISOString();
  }

  /** Serialize all analytics data for export. */
  serialize(): string {
    return JSON.stringify({
      sessionMetrics: this.sessionMetrics,
      events: this.events,
      performanceMetrics: this.metrics,
    });
  }

  /** Reset all state. */
  reset(sessionId: string): void {
    this.events = [];
    this.metrics = [];
    this.nextId = 0;
    this.sessionMetrics = {
      sessionId,
      startedAt: new Date().toISOString(),
      totalTurns: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCostUsd: 0,
      totalDurationMs: 0,
      toolUseCounts: {},
      providerCalls: 0,
      errors: 0,
      permissionPrompts: 0,
      permissionApprovals: 0,
      permissionDenials: 0,
    };
  }
}

/** Singleton convenience — create a global collector. */
let globalCollector: AnalyticsCollector | null = null;

export function getAnalytics(sessionId?: string): AnalyticsCollector {
  if (!globalCollector) {
    globalCollector = new AnalyticsCollector(sessionId ?? 'default');
  }
  return globalCollector;
}

export function resetAnalytics(sessionId: string): void {
  globalCollector = new AnalyticsCollector(sessionId);
}
