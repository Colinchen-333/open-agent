/**
 * Per-server enable/disable state that persists across reconnections.
 * Claude Code tracks user overrides separately from config so disabling a
 * server once keeps it off even after `setServers()` is called again.
 */
export class McpServerState {
  private userDisabled = new Set<string>();
  private policyBlocked = new Set<string>();

  /** User explicitly disabled this server via /mcp or config. */
  disable(serverName: string): void {
    this.userDisabled.add(serverName);
  }

  /** User re-enabled a previously disabled server. */
  enable(serverName: string): void {
    this.userDisabled.delete(serverName);
  }

  /** Policy (enterprise managed settings) blocks this server. Cannot be overridden by user. */
  policyBlock(serverName: string): void {
    this.policyBlocked.add(serverName);
  }

  policyUnblock(serverName: string): void {
    this.policyBlocked.delete(serverName);
  }

  /** Returns true if the server should NOT be started. Policy wins over user. */
  isDisabled(serverName: string): boolean {
    return this.policyBlocked.has(serverName) || this.userDisabled.has(serverName);
  }

  /** For debug / UI: reason for disable. */
  disabledReason(serverName: string): 'policy' | 'user' | null {
    if (this.policyBlocked.has(serverName)) return 'policy';
    if (this.userDisabled.has(serverName)) return 'user';
    return null;
  }

  /** Snapshot for serialization. */
  snapshot(): { userDisabled: string[]; policyBlocked: string[] } {
    return {
      userDisabled: [...this.userDisabled],
      policyBlocked: [...this.policyBlocked],
    };
  }

  /** Restore from snapshot. */
  restore(snap: { userDisabled?: string[]; policyBlocked?: string[] }): void {
    this.userDisabled = new Set(snap.userDisabled ?? []);
    this.policyBlocked = new Set(snap.policyBlocked ?? []);
  }
}
