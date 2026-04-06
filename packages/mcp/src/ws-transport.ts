import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { McpToolInfo, McpResourceInfo, McpPromptInfo, McpPromptMessage } from './types';
import { normalizeMcpToolInfo } from './tool-info';

/**
 * Low-level WebSocket transport implementing the MCP SDK `Transport` interface.
 * Sends and receives JSON-RPC messages over a single WebSocket connection.
 */
class WsTransport implements Transport {
  private ws: WebSocket | null = null;

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(
    private url: string,
    private _headers?: Record<string, string>,
  ) {}

  async start(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(this.url);

      this.ws.onopen = () => resolve();

      this.ws.onerror = (_event) => {
        const err = new Error(`WebSocket error: ${this.url}`);
        this.onerror?.(err);
        reject(err);
      };

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(String(event.data)) as JSONRPCMessage;
          this.onmessage?.(msg);
        } catch {
          this.onerror?.(
            new Error(`Invalid JSON from WebSocket: ${String(event.data).slice(0, 100)}`),
          );
        }
      };

      this.ws.onclose = () => {
        this.onclose?.();
      };
    });
  }

  async close(): Promise<void> {
    this.ws?.close();
    this.ws = null;
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected');
    }
    this.ws.send(JSON.stringify(message));
  }
}

/**
 * WebSocket MCP client that connects to a WebSocket-based MCP server.
 *
 * Mirrors the API surface of McpSseClient / McpHttpClient so it can be
 * used interchangeably inside McpManager.
 */
export class McpWsClient {
  private client: Client | null = null;
  private transport: WsTransport | null = null;

  constructor(
    private serverName: string,
    private url: string,
    private headers?: Record<string, string>,
  ) {}

  async connect(): Promise<{ name: string; version: string } | undefined> {
    this.transport = new WsTransport(this.url, this.headers);
    this.client = new Client(
      { name: 'open-agent', version: '0.1.0' },
      { capabilities: {} },
    );

    try {
      await this.client.connect(this.transport);
      return this.client.getServerVersion();
    } catch (err) {
      this.client = null;
      this.transport = null;
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
    }
    this.transport = null;
  }

  async listTools(): Promise<McpToolInfo[]> {
    if (!this.client) return [];
    try {
      const result = await this.client.listTools();
      return (result.tools || []).map(t =>
        normalizeMcpToolInfo(this.serverName, {
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema as Record<string, any>,
          annotations: t.annotations as any,
        }),
      );
    } catch {
      return [];
    }
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<any> {
    if (!this.client) throw new Error('Not connected');
    return this.client.callTool({ name, arguments: args });
  }

  async listResources(): Promise<McpResourceInfo[]> {
    if (!this.client) return [];
    try {
      const result = await this.client.listResources();
      return (result.resources || []).map(r => ({
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
    if (!this.client) throw new Error('Not connected');
    return this.client.readResource({ uri });
  }

  async listPrompts(): Promise<McpPromptInfo[]> {
    if (!this.client) return [];
    try {
      const result = await this.client.listPrompts();
      return (result.prompts || []).map(p => ({
        name: p.name,
        description: p.description,
        arguments: p.arguments,
        serverName: this.serverName,
      }));
    } catch {
      return [];
    }
  }

  async getPrompt(name: string, args?: Record<string, string>): Promise<McpPromptMessage[]> {
    if (!this.client) return [];
    try {
      const result = await this.client.getPrompt({ name, arguments: args });
      return (result.messages ?? []).map(m => ({
        role: m.role as 'user' | 'assistant',
        content: {
          type: 'text' as const,
          text:
            typeof m.content === 'object' && 'text' in m.content
              ? (m.content as any).text
              : String(m.content),
        },
      }));
    } catch {
      return [];
    }
  }

  /** Expose the underlying MCP SDK Client for notification handler wiring. */
  getUnderlyingClient(): Client | null {
    return this.client;
  }
}
