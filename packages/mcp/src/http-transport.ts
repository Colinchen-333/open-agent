import type { McpToolInfo, McpResourceInfo } from './types';

/**
 * Minimal HTTP MCP client.
 *
 * Implements the basic MCP JSON-RPC over HTTP POST pattern used by
 * remote MCP servers. The server must expose:
 *   POST <url>  with body { jsonrpc: "2.0", method, params, id }
 *
 * For SSE servers the same client is used — the initial tool/resource
 * discovery calls are identical JSON-RPC over HTTP POST; only streaming
 * notifications differ (and are not needed for tool call proxying).
 */
export class McpHttpClient {
  private nextId = 1;

  constructor(
    private readonly serverName: string,
    private readonly url: string,
    private readonly headers: Record<string, string> = {}
  ) {}

  private async rpc(method: string, params?: Record<string, unknown>): Promise<any> {
    const id = this.nextId++;
    const response = await fetch(this.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        ...this.headers,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} }),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText} from MCP server '${this.serverName}'`);
    }

    const json: any = await response.json();
    if (json.error) {
      throw new Error(`MCP error from '${this.serverName}': ${json.error.message ?? JSON.stringify(json.error)}`);
    }
    return json.result;
  }

  async connect(): Promise<{ name: string; version: string } | undefined> {
    try {
      const result = await this.rpc('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'open-agent', version: '0.1.0' },
      });
      // Send initialized notification (fire-and-forget)
      void fetch(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.headers },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      }).catch(() => {});
      const info = result?.serverInfo;
      return info ? { name: info.name ?? this.serverName, version: info.version ?? '0.0.0' } : undefined;
    } catch {
      return undefined;
    }
  }

  async listTools(): Promise<McpToolInfo[]> {
    const result = await this.rpc('tools/list');
    return (result?.tools ?? []).map((t: any) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
      serverName: this.serverName,
    }));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<any> {
    return this.rpc('tools/call', { name, arguments: args });
  }

  async listResources(): Promise<McpResourceInfo[]> {
    try {
      const result = await this.rpc('resources/list');
      return (result?.resources ?? []).map((r: any) => ({
        uri: r.uri,
        name: r.name,
        mimeType: r.mimeType,
        description: r.description,
        server: this.serverName,
      }));
    } catch {
      return [];
    }
  }

  async readResource(uri: string): Promise<any> {
    return this.rpc('resources/read', { uri });
  }

  // HTTP clients don't hold a persistent connection — nothing to close.
  disconnect(): void {}
}
