import type {
  McpServerConfig,
  McpStdioServerConfig,
  McpSSEServerConfig,
  McpHttpServerConfig,
} from '@open-agent/core';
import { McpStdioClient } from './stdio-transport';
import { McpHttpClient } from './http-transport';
import type { McpServerConnection, McpToolInfo, McpResourceInfo } from './types';

// Union type of all client types we maintain
type AnyMcpClient = McpStdioClient | McpHttpClient;

export class McpManager {
  private connections: Map<string, McpServerConnection> = new Map();
  private clients: Map<string, AnyMcpClient> = new Map();

  // ── Server lifecycle ──────────────────────────────────────────────────────

  /**
   * Add a single server by name and config, then attempt to connect.
   * Returns the resulting connection record.
   */
  async addServer(name: string, config: McpServerConfig): Promise<McpServerConnection> {
    const connection: McpServerConnection = {
      name,
      config,
      status: 'connecting',
      tools: [],
      enabled: true,
    };
    this.connections.set(name, connection);

    try {
      const client = this.createClient(name, config);

      if (client) {
        this.clients.set(name, client);
        const serverInfo = await client.connect();
        connection.serverInfo = serverInfo
          ? { name: serverInfo.name, version: serverInfo.version }
          : undefined;
        connection.tools = await client.listTools();
        connection.status = 'connected';
      } else {
        // sdk type or unknown — mark connected with no tools (in-process server)
        connection.status = 'connected';
        connection.tools = [];
      }
    } catch (error: unknown) {
      connection.status = 'error';
      connection.error = error instanceof Error ? error.message : String(error);
    }

    this.connections.set(name, connection);
    return connection;
  }

  /**
   * Set the full server configuration, connecting new servers and
   * disconnecting servers no longer present in the config.
   */
  async setServers(servers: Record<string, McpServerConfig>): Promise<{
    added: string[];
    removed: string[];
    errors: Record<string, string>;
  }> {
    const result = {
      added: [] as string[],
      removed: [] as string[],
      errors: {} as Record<string, string>,
    };

    // Remove servers not in the new config
    for (const name of [...this.connections.keys()]) {
      if (!(name in servers)) {
        await this.removeServer(name);
        result.removed.push(name);
      }
    }

    // Add new servers (skip already-connected ones)
    for (const [name, config] of Object.entries(servers)) {
      if (!this.connections.has(name)) {
        const conn = await this.addServer(name, config);
        result.added.push(name);
        if (conn.error) result.errors[name] = conn.error;
      }
    }

    return result;
  }

  /**
   * Disconnect and remove a server by name.
   */
  async removeServer(name: string): Promise<void> {
    const client = this.clients.get(name);
    if (client) {
      try {
        await client.disconnect();
      } catch {
        // ignore disconnect errors
      }
      this.clients.delete(name);
    }
    this.connections.delete(name);
  }

  /**
   * Reconnect a specific server (disconnect → connect).
   * Alias: `reconnectServer(name)`
   */
  async reconnect(name: string): Promise<void> {
    const conn = this.connections.get(name);
    if (!conn) throw new Error(`MCP server '${name}' not found`);
    const savedConfig = conn.config;
    await this.removeServer(name);
    await this.addServer(name, savedConfig);
  }

  /** Alias for `reconnect` — matches Claude Code's API */
  async reconnectServer(name: string): Promise<void> {
    return this.reconnect(name);
  }

  /**
   * Enable or disable a server without removing its config.
   * Disabling disconnects the transport but preserves the config for re-enabling.
   * Alias: `toggleServer(name, enabled)`
   */
  async toggle(name: string, enabled: boolean): Promise<void> {
    const conn = this.connections.get(name);
    if (!conn) throw new Error(`MCP server '${name}' not found`);

    if (enabled && conn.status === 'disabled') {
      // Re-enable: restore connection using saved config
      const savedConfig = conn.config;
      await this.removeServer(name);
      await this.addServer(name, savedConfig);
      const refreshed = this.connections.get(name);
      if (refreshed) refreshed.enabled = true;
    } else if (!enabled && conn.status !== 'disabled') {
      // Disable: disconnect transport but keep connection record
      const client = this.clients.get(name);
      if (client) {
        try {
          await client.disconnect();
        } catch {
          // ignore
        }
        this.clients.delete(name);
      }
      conn.status = 'disabled';
      conn.enabled = false;
      this.connections.set(name, conn);
    }
  }

  /** Alias for `toggle` — matches Claude Code's API */
  async toggleServer(name: string, enabled: boolean): Promise<void> {
    return this.toggle(name, enabled);
  }

  /**
   * Disconnect all servers (graceful shutdown).
   */
  async disconnectAll(): Promise<void> {
    for (const name of [...this.clients.keys()]) {
      await this.removeServer(name);
    }
  }

  // ── Status ────────────────────────────────────────────────────────────────

  /**
   * Return status records for all configured servers.
   * Alias: `getServerStatus()`
   */
  getStatus(): McpServerConnection[] {
    return Array.from(this.connections.values());
  }

  /** Alias for `getStatus` — matches Claude Code's API */
  getServerStatus(): McpServerConnection[] {
    return this.getStatus();
  }

  // ── Tool discovery ────────────────────────────────────────────────────────

  /**
   * Return all tools from all connected servers.
   */
  getAllTools(): McpToolInfo[] {
    const tools: McpToolInfo[] = [];
    for (const conn of this.connections.values()) {
      if (conn.status === 'connected') {
        tools.push(...conn.tools);
      }
    }
    return tools;
  }

  /**
   * Execute a tool on a specific server.
   */
  async callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<any> {
    const client = this.clients.get(serverName);
    if (!client) throw new Error(`MCP server '${serverName}' not connected`);
    return client.callTool(toolName, args);
  }

  // ── Resource access ───────────────────────────────────────────────────────

  /**
   * List resources from all connected servers.
   */
  async getAllResources(): Promise<McpResourceInfo[]> {
    const resources: McpResourceInfo[] = [];
    for (const [name, client] of this.clients.entries()) {
      const conn = this.connections.get(name);
      if (conn?.status === 'connected') {
        try {
          const serverResources = await client.listResources();
          resources.push(...serverResources);
        } catch {
          // skip servers that don't support resources
        }
      }
    }
    return resources;
  }

  /**
   * Read the content of a specific resource from a named server.
   */
  async readResource(serverName: string, uri: string): Promise<any> {
    const client = this.clients.get(serverName);
    if (!client) throw new Error(`MCP server '${serverName}' not connected`);
    return client.readResource(uri);
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /**
   * Instantiate the correct transport client for the given config.
   * Returns null for sdk-type (in-process) servers.
   */
  private createClient(name: string, config: McpServerConfig): AnyMcpClient | null {
    const type = (config as any).type;

    if (!type || type === 'stdio') {
      const stdioConfig = config as McpStdioServerConfig;
      return new McpStdioClient(name, stdioConfig);
    }

    if (type === 'http') {
      const httpConfig = config as McpHttpServerConfig;
      return new McpHttpClient(name, httpConfig.url, httpConfig.headers);
    }

    if (type === 'sse') {
      // SSE servers use the same HTTP JSON-RPC discovery protocol.
      // Streaming notifications are not proxied — only tool/resource calls matter.
      const sseConfig = config as McpSSEServerConfig;
      return new McpHttpClient(name, sseConfig.url, sseConfig.headers);
    }

    if (type === 'sdk') {
      // In-process MCP server — no client needed; tools registered separately.
      return null;
    }

    throw new Error(`Unsupported MCP transport type: '${type}' for server '${name}'`);
  }
}
