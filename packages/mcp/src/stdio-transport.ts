import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { McpToolInfo, McpResourceInfo } from './types';

export class McpStdioClient {
  private client: Client;
  private transport: StdioClientTransport;

  constructor(
    private serverName: string,
    private config: { command: string; args?: string[]; env?: Record<string, string> }
  ) {
    this.transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: { ...process.env, ...(config.env || {}) } as Record<string, string>,
    });

    this.client = new Client(
      { name: 'open-agent', version: '0.1.0' },
      { capabilities: {} }
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
    const result = await this.client.callTool({ name, arguments: args });
    return result;
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
    const result = await this.client.readResource({ uri });
    return result;
  }

  async disconnect(): Promise<void> {
    await this.client.close();
  }
}
