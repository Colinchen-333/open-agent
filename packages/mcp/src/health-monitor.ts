/**
 * MCP server health monitoring with auto-reconnect.
 */

export interface ServerHealthStatus {
  serverName: string;
  healthy: boolean;
  lastCheck: string;
  consecutiveFailures: number;
  lastError?: string;
  latencyMs?: number;
}

export interface HealthMonitorConfig {
  /** Check interval in ms (default: 30000) */
  intervalMs?: number;
  /** Max consecutive failures before marking unhealthy (default: 3) */
  maxFailures?: number;
  /** Timeout for health check in ms (default: 5000) */
  timeoutMs?: number;
}

export class McpHealthMonitor {
  private statuses = new Map<string, ServerHealthStatus>();
  private intervals = new Map<string, ReturnType<typeof setInterval>>();
  private config: Required<HealthMonitorConfig>;
  private checkFn: (serverName: string) => Promise<{ ok: boolean; latencyMs: number; error?: string }>;

  constructor(
    checkFn: (serverName: string) => Promise<{ ok: boolean; latencyMs: number; error?: string }>,
    config?: HealthMonitorConfig,
  ) {
    this.checkFn = checkFn;
    this.config = {
      intervalMs: config?.intervalMs ?? 30000,
      maxFailures: config?.maxFailures ?? 3,
      timeoutMs: config?.timeoutMs ?? 5000,
    };
  }

  /** Start monitoring a server. */
  monitor(serverName: string): void {
    if (this.intervals.has(serverName)) return;

    this.statuses.set(serverName, {
      serverName,
      healthy: true,
      lastCheck: new Date().toISOString(),
      consecutiveFailures: 0,
    });

    const interval = setInterval(() => this.check(serverName), this.config.intervalMs);
    this.intervals.set(serverName, interval);
  }

  /** Stop monitoring a server. */
  unmonitor(serverName: string): void {
    const interval = this.intervals.get(serverName);
    if (interval) clearInterval(interval);
    this.intervals.delete(serverName);
    this.statuses.delete(serverName);
  }

  /** Run a health check for a server. */
  async check(serverName: string): Promise<ServerHealthStatus> {
    const status = this.statuses.get(serverName) ?? {
      serverName,
      healthy: true,
      lastCheck: '',
      consecutiveFailures: 0,
    };

    try {
      const result = await this.checkFn(serverName);
      status.lastCheck = new Date().toISOString();
      status.latencyMs = result.latencyMs;

      if (result.ok) {
        status.healthy = true;
        status.consecutiveFailures = 0;
        status.lastError = undefined;
      } else {
        status.consecutiveFailures++;
        status.lastError = result.error;
        status.healthy = status.consecutiveFailures < this.config.maxFailures;
      }
    } catch (err: any) {
      status.consecutiveFailures++;
      status.lastError = err.message ?? String(err);
      status.lastCheck = new Date().toISOString();
      status.healthy = status.consecutiveFailures < this.config.maxFailures;
    }

    this.statuses.set(serverName, status);
    return { ...status };
  }

  /** Get current status of all monitored servers. */
  getAllStatuses(): ServerHealthStatus[] {
    return [...this.statuses.values()].map(s => ({ ...s }));
  }

  /** Get status of a specific server. */
  getStatus(serverName: string): ServerHealthStatus | null {
    const s = this.statuses.get(serverName);
    return s ? { ...s } : null;
  }

  /** Stop all monitoring. */
  stopAll(): void {
    for (const interval of this.intervals.values()) clearInterval(interval);
    this.intervals.clear();
    this.statuses.clear();
  }
}
