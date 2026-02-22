import type {
  McpServerConfig,
  McpStdioServerConfig,
} from '@open-agent/core';
import { McpStdioClient } from './stdio-transport';
import type { McpServerConnection, McpToolInfo, McpResourceInfo } from './types';

export class McpManager {
  private connections: Map<string, McpServerConnection> = new Map();
  private clients: Map<string, McpStdioClient> = new Map();

  // 添加并连接服务器
  async addServer(name: string, config: McpServerConfig): Promise<McpServerConnection> {
    const connection: McpServerConnection = {
      name,
      config,
      status: 'pending',
      tools: [],
    };
    this.connections.set(name, connection);

    try {
      if (!config.type || config.type === 'stdio') {
        const stdioConfig = config as McpStdioServerConfig;
        const client = new McpStdioClient(name, stdioConfig);
        this.clients.set(name, client);

        const serverInfo = await client.connect();
        connection.serverInfo = serverInfo
          ? { name: serverInfo.name, version: serverInfo.version }
          : undefined;
        connection.tools = await client.listTools();
        connection.status = 'connected';
      } else if (config.type === 'sse' || config.type === 'http') {
        // SSE 和 HTTP 传输 - 简化实现，后续可扩展
        connection.status = 'connected';
        connection.tools = [];
      } else {
        connection.status = 'failed';
        connection.error = `Unsupported transport type: ${(config as any).type}`;
      }
    } catch (error: unknown) {
      connection.status = 'failed';
      connection.error = error instanceof Error ? error.message : String(error);
    }

    this.connections.set(name, connection);
    return connection;
  }

  // 批量设置服务器（仅添加新增的，移除已删除的）
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

    // 移除不在新配置中的服务器
    for (const name of this.connections.keys()) {
      if (!(name in servers)) {
        await this.removeServer(name);
        result.removed.push(name);
      }
    }

    // 添加新服务器
    for (const [name, config] of Object.entries(servers)) {
      if (!this.connections.has(name)) {
        const conn = await this.addServer(name, config);
        result.added.push(name);
        if (conn.error) result.errors[name] = conn.error;
      }
    }

    return result;
  }

  // 移除并断开服务器
  async removeServer(name: string): Promise<void> {
    const client = this.clients.get(name);
    if (client) {
      try {
        await client.disconnect();
      } catch {
        // 忽略断开时的错误
      }
      this.clients.delete(name);
    }
    this.connections.delete(name);
  }

  // 调用工具
  async callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<any> {
    const client = this.clients.get(serverName);
    if (!client) throw new Error(`MCP server '${serverName}' not connected`);
    return client.callTool(toolName, args);
  }

  // 获取所有已连接服务器的工具列表
  getAllTools(): McpToolInfo[] {
    const tools: McpToolInfo[] = [];
    for (const conn of this.connections.values()) {
      if (conn.status === 'connected') {
        tools.push(...conn.tools);
      }
    }
    return tools;
  }

  // 获取所有已连接服务器的资源列表
  async getAllResources(): Promise<McpResourceInfo[]> {
    const resources: McpResourceInfo[] = [];
    for (const [name, client] of this.clients.entries()) {
      const conn = this.connections.get(name);
      if (conn?.status === 'connected') {
        try {
          const serverResources = await client.listResources();
          resources.push(...serverResources);
        } catch {
          // 忽略单个服务器的资源列举错误
        }
      }
    }
    return resources;
  }

  // 读取指定资源内容
  async readResource(serverName: string, uri: string): Promise<any> {
    const client = this.clients.get(serverName);
    if (!client) throw new Error(`MCP server '${serverName}' not connected`);
    return client.readResource(uri);
  }

  // 获取所有服务器的连接状态
  getStatus(): McpServerConnection[] {
    return Array.from(this.connections.values());
  }

  // 重新连接指定服务器
  async reconnect(name: string): Promise<void> {
    const conn = this.connections.get(name);
    if (!conn) throw new Error(`MCP server '${name}' not found`);
    const savedConfig = conn.config;
    await this.removeServer(name);
    await this.addServer(name, savedConfig);
  }

  // 启用或禁用指定服务器
  async toggle(name: string, enabled: boolean): Promise<void> {
    const conn = this.connections.get(name);
    if (!conn) throw new Error(`MCP server '${name}' not found`);

    if (enabled && conn.status === 'disabled') {
      // 重新连接已禁用的服务器
      await this.removeServer(name);
      await this.addServer(name, conn.config);
    } else if (!enabled && conn.status !== 'disabled') {
      // 断开连接并标记为禁用，保留配置
      const client = this.clients.get(name);
      if (client) {
        try {
          await client.disconnect();
        } catch {
          // 忽略断开错误
        }
        this.clients.delete(name);
      }
      conn.status = 'disabled';
      this.connections.set(name, conn);
    }
  }

  // 断开所有服务器连接
  async disconnectAll(): Promise<void> {
    for (const name of [...this.clients.keys()]) {
      await this.removeServer(name);
    }
  }
}
