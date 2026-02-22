import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { McpToolInfo, McpResourceInfo } from './types';

/**
 * SSE MCP client that connects to an SSE-based MCP server.
 *
 * The MCP SSE transport works as follows:
 *   1. Client opens a GET request with `Accept: text/event-stream` to the SSE endpoint.
 *   2. The server responds with the SSE stream and sends an `endpoint` event with
 *      the URL the client should POST JSON-RPC messages to.
 *   3. Client POSTs JSON-RPC requests to that endpoint.
 *   4. Server sends JSON-RPC responses back over the SSE stream.
 */
class SseTransport implements Transport {
  private eventSource: EventSource | null = null;
  private postEndpoint: string | null = null;
  private messageResolvers: Map<string | number, (msg: JSONRPCMessage) => void> = new Map();

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(
    private url: string,
    private headers?: Record<string, string>,
  ) {}

  async start(): Promise<void> {
    // Open the SSE connection
    const response = await fetch(this.url, {
      headers: {
        Accept: 'text/event-stream',
        ...(this.headers || {}),
      },
    });

    if (!response.ok || !response.body) {
      throw new Error(`SSE connection failed: ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    // Read the SSE stream in the background
    (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const events = buffer.split('\n\n');
          buffer = events.pop() ?? '';

          for (const event of events) {
            const lines = event.split('\n');
            let eventType = 'message';
            let data = '';

            for (const line of lines) {
              if (line.startsWith('event: ')) {
                eventType = line.slice(7).trim();
              } else if (line.startsWith('data: ')) {
                data += line.slice(6);
              }
            }

            if (eventType === 'endpoint' && data) {
              // The server tells us where to POST messages
              this.postEndpoint = new URL(data, this.url).toString();
            } else if (eventType === 'message' && data) {
              try {
                const msg = JSON.parse(data) as JSONRPCMessage;
                this.onmessage?.(msg);
              } catch {
                // Skip malformed JSON
              }
            }
          }
        }
      } catch (err) {
        this.onerror?.(err instanceof Error ? err : new Error(String(err)));
      } finally {
        this.onclose?.();
      }
    })();

    // Wait for the endpoint to be received (with timeout)
    const start = Date.now();
    while (!this.postEndpoint && Date.now() - start < 10_000) {
      await new Promise(r => setTimeout(r, 50));
    }
    if (!this.postEndpoint) {
      throw new Error('SSE server did not provide a POST endpoint within 10s');
    }
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (!this.postEndpoint) {
      throw new Error('SSE transport not connected — no POST endpoint');
    }
    const response = await fetch(this.postEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.headers || {}),
      },
      body: JSON.stringify(message),
    });
    if (!response.ok) {
      throw new Error(`SSE POST failed: ${response.status}`);
    }
  }

  async close(): Promise<void> {
    this.eventSource?.close();
    this.onclose?.();
  }
}

export class McpSseClient {
  private client: Client;
  private transport: SseTransport;

  constructor(
    private serverName: string,
    url: string,
    headers?: Record<string, string>,
  ) {
    this.transport = new SseTransport(url, headers);
    this.client = new Client(
      { name: 'open-agent', version: '0.1.0' },
      { capabilities: {} },
    );
  }

  async connect(): Promise<{ name: string; version: string } | undefined> {
    await this.client.connect(this.transport);
    return this.client.getServerVersion();
  }

  async listTools(): Promise<McpToolInfo[]> {
    const result = await this.client.listTools();
    return (result.tools || []).map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as Record<string, any>,
      serverName: this.serverName,
    }));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<any> {
    return this.client.callTool({ name, arguments: args });
  }

  async listResources(): Promise<McpResourceInfo[]> {
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
    return this.client.readResource({ uri });
  }

  async disconnect(): Promise<void> {
    await this.client.close();
  }
}
