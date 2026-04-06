import type {
  McpServerConfig,
  McpStdioServerConfig,
  McpSSEServerConfig,
  McpHttpServerConfig,
  McpWsServerConfig,
} from '@open-agent/core';
import { isDeepStrictEqual } from 'util';
import {
  ResourceListChangedNotificationSchema,
  ResourceUpdatedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { McpStdioClient } from './stdio-transport';
import { McpHttpClient } from './http-transport';
import { McpSseClient } from './sse-transport';
import { McpWsClient } from './ws-transport';
import { expandConfigEnvVars } from './config-scope.js';
import type { McpServerConnection, McpToolInfo, McpResourceInfo, McpPromptInfo, McpPromptMessage } from './types';
import { normalizeMcpToolInfo } from './tool-info';
import { McpServerState } from './server-state';
import { ElicitationManager, type ElicitationAdapter, type ElicitationRequest } from './elicitation';

function isAuthError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const lowered = message.toLowerCase();
  return (
    lowered.includes('auth') ||
    lowered.includes('unauthorized') ||
    lowered.includes('forbidden') ||
    lowered.includes('login')
  );
}

function normalizedServerType(config: McpServerConfig): 'stdio' | 'http' | 'sse' | 'ws' | 'sdk' {
  const type = (config as { type?: string }).type;
  if (!type || type === 'stdio') return 'stdio';
  if (type === 'http') return 'http';
  if (type === 'sse') return 'sse';
  if (type === 'ws') return 'ws';
  return 'sdk';
}

function hasServerConfigChanged(
  prev: McpServerConfig,
  next: McpServerConfig,
): boolean {
  const prevType = normalizedServerType(prev);
  const nextType = normalizedServerType(next);
  if (prevType !== nextType) return true;

  if (prevType === 'stdio') {
    const a = prev as McpStdioServerConfig;
    const b = next as McpStdioServerConfig;
    return a.command !== b.command
      || !isDeepStrictEqual(a.args ?? [], b.args ?? [])
      || !isDeepStrictEqual(a.env ?? {}, b.env ?? {});
  }

  if (prevType === 'http') {
    const a = prev as McpHttpServerConfig;
    const b = next as McpHttpServerConfig;
    return a.url !== b.url || !isDeepStrictEqual(a.headers ?? {}, b.headers ?? {});
  }

  if (prevType === 'sse') {
    const a = prev as McpSSEServerConfig;
    const b = next as McpSSEServerConfig;
    return a.url !== b.url || !isDeepStrictEqual(a.headers ?? {}, b.headers ?? {});
  }

  if (prevType === 'ws') {
    const a = prev as McpWsServerConfig;
    const b = next as McpWsServerConfig;
    return a.url !== b.url || !isDeepStrictEqual(a.headers ?? {}, b.headers ?? {});
  }

  return !isDeepStrictEqual(
    {
      name: (prev as { name?: string }).name,
      instance: (prev as { instance?: unknown }).instance,
    },
    {
      name: (next as { name?: string }).name,
      instance: (next as { instance?: unknown }).instance,
    },
  );
}

// Union type of all client types we maintain
type AnyMcpClient = McpStdioClient | McpHttpClient | McpSseClient | McpWsClient;

/** Payload delivered to a resource subscription callback. */
export type ResourceNotificationEvent =
  | { type: 'updated'; uri: string }
  | { type: 'list_changed' };

interface ResourceSubscription {
  serverName: string;
  uri: string;
  callback: (event: ResourceNotificationEvent) => void;
}

export interface McpManagerOptions {
  /** Server names that are blocked by enterprise policy. Cannot be overridden by users. */
  policyBlockedServers?: string[];
}

export class McpManager {
  private connections: Map<string, McpServerConnection> = new Map();
  private clients: Map<string, AnyMcpClient> = new Map();
  /** SDK-type servers store tool handlers here (keyed by serverName → toolName → handler) */
  private _sdkToolHandlers: Map<string, Map<string, (args: Record<string, unknown>, extra: unknown) => Promise<unknown>>> = new Map();
  private _setupChain: Promise<void> = Promise.resolve();
  /** Active resource subscriptions. Key: `${serverName}:${uri}` */
  private _subscriptions: Map<string, ResourceSubscription> = new Map();
  /** Per-server enable/disable state, survives reconnections. */
  private serverState = new McpServerState();
  /** Elicitation protocol handler — routes server input-requests to the UI adapter. */
  private elicitationManager = new ElicitationManager();

  constructor(options?: McpManagerOptions) {
    if (options?.policyBlockedServers) {
      for (const name of options.policyBlockedServers) {
        this.serverState.policyBlock(name);
      }
    }
  }

  // ── Server lifecycle ──────────────────────────────────────────────────────

  /**
   * Add a single server by name and config, then attempt to connect.
   * Returns the resulting connection record.
   */
  async addServer(name: string, config: McpServerConfig): Promise<McpServerConnection> {
    // Check per-server disable state before attempting any connection.
    if (this.serverState.isDisabled(name)) {
      const reason = this.serverState.disabledReason(name);
      const connection: McpServerConnection = {
        name,
        config,
        status: 'disabled',
        tools: [],
        enabled: false,
        error: reason === 'policy'
          ? 'Server is blocked by enterprise policy'
          : 'Server has been disabled by the user',
      };
      this.connections.set(name, connection);
      return connection;
    }

    // Expand ${VAR} references in the config before connecting.
    const expandedConfig = expandConfigEnvVars(config as unknown as Record<string, unknown>) as unknown as McpServerConfig;

    const connection: McpServerConnection = {
      name,
      config: expandedConfig,
      status: 'connecting',
      tools: [],
      enabled: true,
    };
    this.connections.set(name, connection);

    try {
      const client = this.createClient(name, expandedConfig);

      if (client) {
        this.clients.set(name, client);
        const serverInfo = await client.connect();
        connection.serverInfo = serverInfo
          ? { name: serverInfo.name, version: serverInfo.version }
          : undefined;
        connection.tools = await client.listTools();
        connection.status = 'connected';
        this._attachNotificationHandlers(name, client);
      } else {
        // SDK-type in-process server — extract tools from the instance property
        connection.status = 'connected';
        const instance = (config as any).instance;
        if (instance?.tools && Array.isArray(instance.tools)) {
          const handlerMap = new Map<string, (args: Record<string, unknown>, extra: unknown) => Promise<unknown>>();
          connection.tools = instance.tools.map((t: any) => {
            handlerMap.set(t.name, t.handler);
            return normalizeMcpToolInfo(name, {
              name: t.name,
              description: t.description ?? '',
              inputSchema: t.inputSchema,
              annotations: t.annotations,
            }) as McpToolInfo;
          });
          this._sdkToolHandlers.set(name, handlerMap);
        } else {
          connection.tools = [];
        }
      }
    } catch (error: unknown) {
      connection.status = isAuthError(error) ? 'needs-auth' : 'failed';
      connection.error = error instanceof Error ? error.message : String(error);
    }

    this.connections.set(name, connection);
    return connection;
  }

  /**
   * Set the full server configuration, connecting new servers and
   * disconnecting servers no longer present in the config.
   * Calls are serialized via a promise chain to prevent race conditions.
   */
  async setServers(servers: Record<string, McpServerConfig>): Promise<{
    added: string[];
    removed: string[];
    errors: Record<string, string>;
  }> {
    let resolve!: (result: { added: string[]; removed: string[]; errors: Record<string, string> }) => void;
    let reject!: (err: unknown) => void;
    const resultPromise = new Promise<{ added: string[]; removed: string[]; errors: Record<string, string> }>(
      (res, rej) => { resolve = res; reject = rej; }
    );

    this._setupChain = this._setupChain
      .then(() => this._doSetServers(servers))
      .then(resolve, reject)
      .catch(() => {});

    return resultPromise;
  }

  private async _doSetServers(servers: Record<string, McpServerConfig>): Promise<{
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

    // Add new servers and hot-reload changed configs.
    for (const [name, config] of Object.entries(servers)) {
      const existing = this.connections.get(name);
      if (!existing) {
        const conn = await this.addServer(name, config);
        result.added.push(name);
        if (conn.error) result.errors[name] = conn.error;
        continue;
      }

      if (hasServerConfigChanged(existing.config, config)) {
        await this.removeServer(name);
        result.removed.push(name);
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
    this._sdkToolHandlers.delete(name);
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
      // Re-enable: restore connection using saved config.
      // Save config before removal so we can restore it after.
      const savedConfig = conn.config;
      await this.removeServer(name);
      const refreshed = await this.addServer(name, savedConfig);
      // If connection failed during re-enable, mark as error (not enabled)
      // to avoid contradictory enabled=true + status=error state.
      if (refreshed.status === 'failed' || refreshed.status === 'needs-auth' || refreshed.status === 'error') {
        refreshed.enabled = false;
      } else {
        refreshed.enabled = true;
      }
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

  // ── Per-server state (disable/enable/policy) ──────────────────────────────

  /**
   * Disable a server. If it is currently connected, the next call to
   * `addServer` or `setServers` will skip connecting it and record it as
   * 'disabled' instead.
   */
  disableServer(serverName: string): void {
    this.serverState.disable(serverName);
  }

  /**
   * Re-enable a user-disabled server. Policy blocks cannot be lifted by this
   * method — call `getServerState().policyUnblock()` for that.
   */
  enableServer(serverName: string): void {
    this.serverState.enable(serverName);
  }

  /** Returns true when the server is blocked (by user or policy). */
  isServerDisabled(serverName: string): boolean {
    return this.serverState.isDisabled(serverName);
  }

  /** Expose the underlying state object for snapshot / restore / UI. */
  getServerState(): McpServerState {
    return this.serverState;
  }

  // ── Elicitation ───────────────────────────────────────────────────────────

  /**
   * Replace the UI adapter used to present elicitation requests to the user.
   * Call this once the UI layer is initialized (e.g. the CLI sets up a stdin adapter).
   */
  setElicitationAdapter(adapter: ElicitationAdapter): void {
    this.elicitationManager.setAdapter(adapter);
  }

  /** Expose the ElicitationManager for advanced use (e.g. cancellation, in-flight inspection). */
  getElicitationManager(): ElicitationManager {
    return this.elicitationManager;
  }

  /**
   * Route an elicitation request originating from a named server through the
   * ElicitationManager. External code (e.g. a custom SDK notification wiring)
   * can call this directly to simulate or forward server-initiated input requests.
   */
  async onServerElicitation(
    serverName: string,
    params: Omit<ElicitationRequest, 'serverName'>,
  ): Promise<ReturnType<ElicitationManager['handle']>> {
    return this.elicitationManager.handle({ ...params, serverName });
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
    // SDK-type servers: call the handler directly (no transport client)
    const sdkHandlers = this._sdkToolHandlers.get(serverName);
    if (sdkHandlers) {
      const handler = sdkHandlers.get(toolName);
      if (!handler) throw new Error(`Tool '${toolName}' not found on SDK server '${serverName}'`);
      return handler(args, {});
    }
    const client = this.clients.get(serverName);
    if (!client) throw new Error(`MCP server '${serverName}' not connected`);
    return client.callTool(toolName, args);
  }

  // ── Prompt discovery ──────────────────────────────────────────────────────

  /**
   * List prompts from a specific connected server.
   * Returns an empty array if the server is not connected or does not support prompts.
   */
  async listPrompts(serverName: string): Promise<McpPromptInfo[]> {
    const conn = this.connections.get(serverName);
    if (!conn || conn.status !== 'connected') return [];

    const client = this.clients.get(serverName);
    if (!client) return []; // SDK-type servers don't expose prompts

    try {
      const prompts = await client.listPrompts();
      return prompts.map(p => ({ ...p, serverName }));
    } catch {
      return []; // Server may not support prompts
    }
  }

  /**
   * Get a specific prompt from a server, optionally with arguments.
   * Returns an empty array if the server is not connected or the prompt is not found.
   */
  async getPrompt(serverName: string, name: string, args?: Record<string, string>): Promise<McpPromptMessage[]> {
    const conn = this.connections.get(serverName);
    if (!conn || conn.status !== 'connected') return [];

    const client = this.clients.get(serverName);
    if (!client) return [];

    try {
      return await client.getPrompt(name, args);
    } catch {
      return [];
    }
  }

  /**
   * Return all prompts from all connected servers with `mcp__<serverName>__` namespacing.
   * Prompt names are prefixed to match the tool namespacing convention.
   */
  async getAllPrompts(): Promise<McpPromptInfo[]> {
    const all: McpPromptInfo[] = [];
    for (const [name, conn] of this.connections) {
      if (conn.status !== 'connected') continue;
      const prompts = await this.listPrompts(name);
      for (const p of prompts) {
        all.push({ ...p, name: `mcp__${name}__${p.name}`, serverName: name });
      }
    }
    return all;
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
   *
   * Returns the MCP `resources/read` response which contains a `contents` array
   * whose elements follow the MCP ResourceContents shape.
   */
  async readResource(serverName: string, uri: string): Promise<{
    contents: Array<{ uri: string; mimeType?: string; text?: string; blob?: string }>;
  }> {
    const client = this.clients.get(serverName);
    if (!client) throw new Error(`MCP server '${serverName}' not connected`);
    return client.readResource(uri);
  }

  // ── Resource subscriptions ────────────────────────────────────────────────

  /**
   * Subscribe to updates for a specific resource on a named server.
   *
   * The callback receives either:
   *   - `{ type: 'updated', uri }` when that specific resource changes, or
   *   - `{ type: 'list_changed' }` when the server's resource list changes.
   *
   * Returns an async unsubscribe function. Call it to cancel the subscription
   * and send an `resources/unsubscribe` RPC to the server.
   */
  async subscribeResource(
    serverName: string,
    uri: string,
    callback: (event: ResourceNotificationEvent) => void,
  ): Promise<() => Promise<void>> {
    const conn = this.connections.get(serverName);
    if (!conn || conn.status !== 'connected') {
      throw new Error(`MCP server not found or not connected: ${serverName}`);
    }

    const key = `${serverName}:${uri}`;
    this._subscriptions.set(key, { serverName, uri, callback });

    // Send subscribeResource RPC to the server (stdio/sse have native SDK client;
    // SDK-type in-process servers and HTTP clients have no persistent channel — skip).
    const transportClient = this.clients.get(serverName);
    const sdkClient = transportClient ? this._getUnderlyingClient(transportClient) : null;
    if (sdkClient) {
      try {
        await sdkClient.subscribeResource({ uri });
      } catch {
        this._subscriptions.delete(key);
        throw new Error(`Failed to subscribe to resource '${uri}' on server '${serverName}'`);
      }
    }

    return async () => {
      this._subscriptions.delete(key);
      if (sdkClient) {
        try {
          await sdkClient.unsubscribeResource({ uri });
        } catch {
          // best-effort: server may already have dropped the subscription
        }
      }
    };
  }

  /**
   * Dispatch a resource notification to all matching subscription callbacks.
   * Called internally when the transport receives a notification from the server.
   */
  private _dispatchResourceNotification(
    serverName: string,
    event: ResourceNotificationEvent,
  ): void {
    for (const sub of this._subscriptions.values()) {
      if (sub.serverName !== serverName) continue;

      if (event.type === 'list_changed') {
        // list_changed fires for every subscriber on this server regardless of URI
        try { sub.callback(event); } catch { /* don't let a bad handler crash dispatch */ }
      } else if (event.type === 'updated' && sub.uri === event.uri) {
        try { sub.callback(event); } catch { /* don't let a bad handler crash dispatch */ }
      }
    }
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /**
   * Retrieve the underlying MCP SDK `Client` from a transport wrapper, if available.
   * HTTP clients have no persistent underlying client, so this returns null for them.
   */
  private _getUnderlyingClient(client: AnyMcpClient): import('@modelcontextprotocol/sdk/client/index.js').Client | null {
    if (client instanceof McpStdioClient || client instanceof McpSseClient) {
      return client.getUnderlyingClient();
    }
    if (client instanceof McpWsClient) {
      return client.getUnderlyingClient();
    }
    return null;
  }

  /**
   * Attach MCP notification handlers to a transport client after it connects.
   * Hooks into `notifications/resources/updated` and `notifications/resources/list_changed`.
   * Also attempts to register an `elicitation/create` request handler if the SDK
   * version exports `ElicitationCreateRequestSchema`; falls back silently if not.
   */
  private _attachNotificationHandlers(serverName: string, client: AnyMcpClient): void {
    const sdkClient = this._getUnderlyingClient(client);
    if (!sdkClient) return; // HTTP clients don't have persistent transport; skip

    try {
      sdkClient.setNotificationHandler(
        ResourceUpdatedNotificationSchema,
        (notification) => {
          const uri = notification.params?.uri;
          if (typeof uri === 'string') {
            this._dispatchResourceNotification(serverName, { type: 'updated', uri });
          }
        },
      );
      sdkClient.setNotificationHandler(
        ResourceListChangedNotificationSchema,
        () => {
          this._dispatchResourceNotification(serverName, { type: 'list_changed' });
        },
      );
    } catch {
      // Older SDK version without notification handler support — skip silently
    }

    // Attempt to wire the elicitation/create request handler.
    // This requires the SDK to expose ElicitationCreateRequestSchema; if the
    // installed version does not ship it yet, this whole block is a no-op.
    try {
      if (typeof (sdkClient as any).setRequestHandler === 'function') {
        import('@modelcontextprotocol/sdk/types.js')
          .then((m: any) => m.ElicitationCreateRequestSchema ?? null)
          .catch(() => null)
          .then((schema) => {
            if (!schema) return; // SDK version without elicitation support
            try {
              (sdkClient as any).setRequestHandler(schema, async (request: any) => {
                const params = request?.params ?? {};
                const normalized: ElicitationRequest = {
                  elicitationId: params.elicitationId ?? `elic-${Date.now()}`,
                  serverName,
                  message: params.message ?? '',
                  type: params.requestedSchema ? 'form' : (params.url ? 'url' : 'form'),
                  schema: params.requestedSchema,
                  url: params.url,
                  timeoutMs: params.timeoutMs,
                };
                const response = await this.elicitationManager.handle(normalized);
                return {
                  action: response.action,
                  content: response.data,
                  reason: response.reason,
                };
              });
            } catch {
              // setRequestHandler failed (e.g. handler already registered) — ignore
            }
          });
      }
    } catch {
      // SDK version without elicitation support — silent fallback
    }
  }

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
      const sseConfig = config as McpSSEServerConfig;
      return new McpSseClient(name, sseConfig.url, sseConfig.headers);
    }

    if (type === 'ws') {
      const wsConfig = config as McpWsServerConfig;
      return new McpWsClient(name, wsConfig.url, wsConfig.headers);
    }

    if (type === 'sdk') {
      // In-process MCP server — no client needed; tools registered separately.
      return null;
    }

    throw new Error(`Unsupported MCP transport type: '${type}' for server '${name}'`);
  }
}
