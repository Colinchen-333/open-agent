import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { McpToolInfo, McpResourceInfo, McpPromptInfo, McpPromptMessage } from './types';
import { normalizeMcpToolInfo } from './tool-info';

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
    return (result.tools || []).map(t => normalizeMcpToolInfo(this.serverName, {
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as Record<string, any>,
      annotations: t.annotations as any,
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

  async listPrompts(): Promise<McpPromptInfo[]> {
    try {
      const result = await this.client.listPrompts();
      return (result.prompts || []).map(p => ({
        name: p.name,
        description: p.description,
        arguments: p.arguments,
        serverName: this.serverName,
      }));
    } catch {
      return []; // Server may not support prompts
    }
  }

  async getPrompt(name: string, args?: Record<string, string>): Promise<McpPromptMessage[]> {
    try {
      const result = await this.client.getPrompt({ name, arguments: args });
      return (result.messages ?? []).map(m => ({
        role: m.role as 'user' | 'assistant',
        content: {
          type: 'text' as const,
          text: typeof m.content === 'object' && 'text' in m.content ? (m.content as any).text : String(m.content),
        },
      }));
    } catch {
      return [];
    }
  }

  async disconnect(): Promise<void> {
    await this.client.close();
  }

  /** Expose the underlying MCP SDK Client for notification handler wiring. */
  getUnderlyingClient(): Client {
    return this.client;
  }
}
