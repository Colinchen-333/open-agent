import type { AgentDefinition } from '@open-agent/core';
import type { McpManager, McpServerConfig, McpToolInfo } from '@open-agent/mcp';
import { McpManager as DefaultMcpManager } from '@open-agent/mcp';
import type { ToolDefinition, ToolRegistry } from '@open-agent/tools';
import {
  createListMcpResourcesTool,
  createReadMcpResourceTool,
  createSkillTool,
  createToolSearchTool,
} from '@open-agent/tools';
import { SkillRegistry, type SkillCatalogEntry, type SkillRegistryOptions } from '@open-agent/skills';

export type CapabilityGroup =
  | 'files'
  | 'execution'
  | 'coordination'
  | 'integration'
  | 'external'
  | 'utility';

export type CapabilityAccess = 'read-only' | 'mutable' | 'meta' | 'external';

export interface ToolCapabilitySource {
  name: string;
  description?: string;
  isReadOnly?: boolean | ((input: unknown) => boolean);
  isConcurrencySafe?: boolean | ((input: unknown) => boolean);
}

export interface ToolCapabilityProfile {
  toolName: string;
  description: string;
  group: CapabilityGroup;
  access: CapabilityAccess;
  readOnly: boolean;
  concurrencySafe: boolean;
  source: 'built-in' | 'dynamic' | 'mcp';
  tags: string[];
}

export interface CapabilityPreset {
  name: CapabilityGroup;
  description: string;
  toolNames: string[];
  toolCount: number;
}

export interface CapabilitySnapshot {
  totalTools: number;
  profiles: ToolCapabilityProfile[];
  presets: CapabilityPreset[];
  summary: {
    accessCounts: Record<CapabilityAccess, number>;
    groupCounts: Record<CapabilityGroup, number>;
    mcpTools: number;
    dynamicTools: number;
  };
}

export interface RuntimeSnapshot {
  tools: string[];
  agents: { name: string; description: string; model?: string }[];
  skills: SkillCatalogEntry[];
  mcpServers: { name: string; status: string }[];
  capabilitySnapshot: CapabilitySnapshot;
}

export interface RuntimeMcpOptions {
  toolNameStyle?: 'raw' | 'namespaced';
  shouldRegisterTool?: (toolName: string, tool: McpToolInfo) => boolean;
  restoreTool?: (toolName: string) => ToolDefinition | undefined;
  formatResult?: (result: unknown) => unknown;
  onToolRegistered?: (tool: ToolDefinition) => void;
}

export interface OpenAgentRuntimeOptions extends SkillRegistryOptions {
  toolRegistry: ToolRegistry;
  availableAgents?: Map<string, AgentDefinition>;
  mcpManager?: McpManager;
  mcp?: RuntimeMcpOptions;
}

export class OpenAgentRuntime {
  readonly skillRegistry: SkillRegistry;
  private readonly options: OpenAgentRuntimeOptions;
  private readonly mcpManager: McpManager;
  private readonly registeredMcpToolNames = new Set<string>();
  private mcpReadyPromise: Promise<void> | undefined;

  constructor(options: OpenAgentRuntimeOptions) {
    this.options = options;
    this.skillRegistry = new SkillRegistry(options);
    this.mcpManager = options.mcpManager ?? new DefaultMcpManager();
  }

  async initialize(): Promise<void> {
    this.skillRegistry.load();
  }

  registerSkillTool(): void {
    if (this.options.toolRegistry.get('Skill')) {
      return;
    }
    this.options.toolRegistry.register(createSkillTool({
      resolveSkill: async (name, args) => this.skillRegistry.resolve(name, args),
      listSkills: () => this.skillRegistry.list(),
    }));
  }

  registerMcpResourceTools(): void {
    if (!this.options.toolRegistry.get('ListMcpResourcesTool')) {
      this.options.toolRegistry.register(createListMcpResourcesTool({
        listResources: async (server?: string) => {
          const all = await this.mcpManager.getAllResources();
          return server ? all.filter((resource) => resource.server === server) : all;
        },
        readResource: async (server: string, uri: string) => this.readMcpResource(server, uri),
      }));
    }

    if (!this.options.toolRegistry.get('ReadMcpResourceTool')) {
      this.options.toolRegistry.register(createReadMcpResourceTool({
        listResources: async (server?: string) => {
          const all = await this.mcpManager.getAllResources();
          return server ? all.filter((resource) => resource.server === server) : all;
        },
        readResource: async (server: string, uri: string) => this.readMcpResource(server, uri),
      }));
    }
  }

  registerToolSearchTool(): void {
    if (this.options.toolRegistry.get('ToolSearch')) {
      return;
    }

    this.options.toolRegistry.register(createToolSearchTool({
      searchTools: async (query: string) => {
        const normalized = query.toLowerCase().trim();
        const results = new Map<string, { name: string; description: string }>();

        for (const tool of this.options.toolRegistry.list()) {
          if (tool.name === 'ToolSearch') continue;
          if (
            normalized.length === 0
            || tool.name.toLowerCase().includes(normalized)
            || tool.description.toLowerCase().includes(normalized)
          ) {
            results.set(tool.name, { name: tool.name, description: tool.description });
          }
        }

        for (const mcpTool of this.mcpManager.getAllTools()) {
          const runtimeName = this.resolveMcpToolName(mcpTool);
          if (!this.shouldRegisterMcpTool(runtimeName, mcpTool)) {
            continue;
          }
          if (
            normalized.length > 0
            && !runtimeName.toLowerCase().includes(normalized)
            && !mcpTool.name.toLowerCase().includes(normalized)
            && !(mcpTool.description ?? '').toLowerCase().includes(normalized)
          ) {
            continue;
          }
          if (!results.has(runtimeName)) {
            results.set(runtimeName, {
              name: runtimeName,
              description: mcpTool.description ?? `MCP tool from ${mcpTool.serverName}`,
            });
          }
        }

        return [...results.values()];
      },
      selectTool: async (name: string) => {
        const existing = this.options.toolRegistry.get(name);
        if (existing) {
          return existing;
        }

        const mcpTool = this.findMcpTool(name);
        if (!mcpTool) {
          return null;
        }

        const runtimeName = this.resolveMcpToolName(mcpTool);
        if (!this.shouldRegisterMcpTool(runtimeName, mcpTool)) {
          return null;
        }

        const tool = this.createMcpToolDefinition(mcpTool, runtimeName);
        this.options.toolRegistry.register(tool);
        this.registeredMcpToolNames.add(runtimeName);
        this.options.mcp?.onToolRegistered?.(tool);
        return tool;
      },
    }));
  }

  listSkills(): SkillCatalogEntry[] {
    return this.skillRegistry.list();
  }

  getMcpManager(): McpManager {
    return this.mcpManager;
  }

  waitForMcpReady(): Promise<void> | undefined {
    return this.mcpReadyPromise;
  }

  async setMcpServers(servers: Record<string, McpServerConfig>): Promise<{
    added: string[];
    removed: string[];
    errors: Record<string, string>;
  }> {
    return this.trackMcpSetup(this.mcpManager.setServers(servers));
  }

  async reconnectMcpServer(serverName: string): Promise<void> {
    await this.trackMcpSetup(this.mcpManager.reconnect(serverName));
  }

  async toggleMcpServer(serverName: string, enabled: boolean): Promise<void> {
    await this.trackMcpSetup(this.mcpManager.toggle(serverName, enabled));
  }

  async disconnectMcpServers(): Promise<void> {
    await this.mcpManager.disconnectAll();
    this.syncMcpToolsIntoRegistry();
  }

  listMcpServerStatus() {
    return this.mcpManager.getStatus();
  }

  buildSnapshot(): RuntimeSnapshot {
    const tools = this.options.toolRegistry.list();
    const capabilitySnapshot = buildCapabilitySnapshot(tools);

    return {
      tools: tools.map((tool) => tool.name),
      agents: [...(this.options.availableAgents ?? new Map()).entries()].map(([name, definition]) => ({
        name,
        description: definition.description,
        ...(definition.model ? { model: String(definition.model) } : {}),
      })),
      skills: this.listSkills(),
      mcpServers: this.mcpManager.getStatus().map((status) => ({
        name: status.name,
        status: status.status,
      })),
      capabilitySnapshot,
    };
  }

  private trackMcpSetup<T>(operation: Promise<T>): Promise<T> {
    const setup = operation.then((result) => {
      this.syncMcpToolsIntoRegistry();
      return result;
    });
    this.mcpReadyPromise = setup.then(() => undefined);
    void this.mcpReadyPromise.catch(() => {});
    return setup;
  }

  private syncMcpToolsIntoRegistry(): void {
    const discoveredNames = new Set<string>();

    for (const mcpTool of this.mcpManager.getAllTools()) {
      const runtimeName = this.resolveMcpToolName(mcpTool);
      if (!this.shouldRegisterMcpTool(runtimeName, mcpTool)) {
        this.restoreTool(runtimeName);
        continue;
      }

      this.options.toolRegistry.register(this.createMcpToolDefinition(mcpTool, runtimeName));
      discoveredNames.add(runtimeName);
    }

    for (const staleName of this.registeredMcpToolNames) {
      if (discoveredNames.has(staleName)) {
        continue;
      }
      this.restoreTool(staleName);
    }

    this.registeredMcpToolNames.clear();
    for (const name of discoveredNames) {
      this.registeredMcpToolNames.add(name);
    }
  }

  private resolveMcpToolName(tool: McpToolInfo): string {
    if (this.options.mcp?.toolNameStyle === 'namespaced') {
      return `mcp__${tool.serverName}__${tool.name}`;
    }
    return tool.name;
  }

  private shouldRegisterMcpTool(toolName: string, tool: McpToolInfo): boolean {
    return this.options.mcp?.shouldRegisterTool?.(toolName, tool) ?? true;
  }

  private restoreTool(toolName: string): void {
    const baseTool = this.options.mcp?.restoreTool?.(toolName);
    if (baseTool) {
      this.options.toolRegistry.register(baseTool);
      return;
    }
    this.options.toolRegistry.unregister(toolName);
  }

  private findMcpTool(name: string): McpToolInfo | undefined {
    return this.mcpManager.getAllTools().find((tool) => {
      const runtimeName = this.resolveMcpToolName(tool);
      return runtimeName === name || tool.name === name;
    });
  }

  private createMcpToolDefinition(tool: McpToolInfo, runtimeName: string): ToolDefinition {
    return {
      name: runtimeName,
      description: tool.description ?? '',
      inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
      execute: async (input: Record<string, unknown>) => {
        const result = await this.mcpManager.callTool(tool.serverName, tool.name, input);
        return this.options.mcp?.formatResult?.(result) ?? result;
      },
    };
  }

  private async readMcpResource(server: string, uri: string): Promise<string> {
    const result = await this.mcpManager.readResource(server, uri);
    return this.stringifyMcpValue(result);
  }

  private stringifyMcpValue(value: unknown): string {
    const formatted = this.options.mcp?.formatResult?.(value) ?? value;
    return typeof formatted === 'string' ? formatted : JSON.stringify(formatted);
  }
}

const FILE_TOOL_NAMES = new Set([
  'Read',
  'Write',
  'Edit',
  'NotebookEdit',
  'Glob',
  'Grep',
]);

const EXECUTION_TOOL_NAMES = new Set([
  'Bash',
  'EnterWorktree',
  'Config',
]);

const COORDINATION_TOOL_NAMES = new Set([
  'Task',
  'TaskCreate',
  'TaskUpdate',
  'TaskGet',
  'TaskList',
  'TaskOutput',
  'TaskStop',
  'TeamCreate',
  'TeamDelete',
  'SendMessage',
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
]);

const INTEGRATION_TOOL_NAMES = new Set([
  'Skill',
  'ToolSearch',
  'ListMcpResourcesTool',
  'ReadMcpResourceTool',
]);

const EXTERNAL_TOOL_NAMES = new Set([
  'WebSearch',
  'WebFetch',
]);

const MUTABLE_TOOL_NAMES = new Set([
  'Write',
  'Edit',
  'NotebookEdit',
  'Bash',
  'EnterWorktree',
  'Config',
  'TaskCreate',
  'TaskUpdate',
  'TaskStop',
  'TeamCreate',
  'TeamDelete',
  'SendMessage',
]);

const CAPABILITY_GROUP_DESCRIPTIONS: Record<CapabilityGroup, string> = {
  files: 'Filesystem inspection and editing tools.',
  execution: 'Local execution and workspace-control tools.',
  coordination: 'Agent orchestration, task, and planning tools.',
  integration: 'Skills, tool discovery, and MCP integration tools.',
  external: 'Network-facing tools.',
  utility: 'General-purpose tools that do not fit another group.',
};

function hasMcpPrefix(name: string): boolean {
  return name.startsWith('mcp__');
}

function determineCapabilityGroup(name: string): CapabilityGroup {
  if (FILE_TOOL_NAMES.has(name)) return 'files';
  if (EXECUTION_TOOL_NAMES.has(name)) return 'execution';
  if (COORDINATION_TOOL_NAMES.has(name)) return 'coordination';
  if (INTEGRATION_TOOL_NAMES.has(name) || hasMcpPrefix(name)) return 'integration';
  if (EXTERNAL_TOOL_NAMES.has(name)) return 'external';
  return 'utility';
}

function determineCapabilityAccess(tool: ToolCapabilitySource, group: CapabilityGroup): CapabilityAccess {
  if (hasMcpPrefix(tool.name) || group === 'external') {
    return 'external';
  }
  if (MUTABLE_TOOL_NAMES.has(tool.name)) {
    return 'mutable';
  }
  if (tool.name === 'Skill' || tool.name === 'ToolSearch' || tool.name === 'Config' || group === 'integration') {
    return 'meta';
  }
  if (group === 'coordination') {
    return 'meta';
  }
  if (typeof tool.isReadOnly === 'boolean') {
    return tool.isReadOnly ? 'read-only' : 'mutable';
  }
  return (
    group === 'files'
    || group === 'utility'
  ) ? 'read-only' : 'mutable';
}

function determineCapabilitySource(tool: ToolCapabilitySource): 'built-in' | 'dynamic' | 'mcp' {
  if (hasMcpPrefix(tool.name) || tool.name === 'ListMcpResourcesTool' || tool.name === 'ReadMcpResourceTool') {
    return 'mcp';
  }
  if (tool.name === 'ToolSearch') {
    return 'dynamic';
  }
  return 'built-in';
}

function resolveReadOnly(tool: ToolCapabilitySource): boolean {
  if (typeof tool.isReadOnly === 'boolean') {
    return tool.isReadOnly;
  }
  return determineCapabilityAccess(tool, determineCapabilityGroup(tool.name)) === 'read-only';
}

function resolveConcurrencySafe(tool: ToolCapabilitySource): boolean {
  if (typeof tool.isConcurrencySafe === 'boolean') {
    return tool.isConcurrencySafe;
  }
  return true;
}

function buildCapabilityProfile(tool: ToolCapabilitySource): ToolCapabilityProfile {
  const group = determineCapabilityGroup(tool.name);
  const readOnly = resolveReadOnly(tool);
  const concurrencySafe = resolveConcurrencySafe(tool);
  const access = determineCapabilityAccess(tool, group);
  const tags = [
    group,
    access,
    readOnly ? 'read-only' : 'mutable',
    concurrencySafe ? 'parallel-safe' : 'serialized',
  ];

  if (hasMcpPrefix(tool.name)) tags.push('mcp');
  if (group === 'external') tags.push('network');
  if (group === 'coordination') tags.push('orchestration');
  if (group === 'execution') tags.push('workspace');

  return {
    toolName: tool.name,
    description: tool.description ?? tool.name,
    group,
    access,
    readOnly,
    concurrencySafe,
    source: determineCapabilitySource(tool),
    tags: [...new Set(tags)],
  };
}

function buildCapabilityPreset(group: CapabilityGroup, profiles: ToolCapabilityProfile[]): CapabilityPreset {
  const toolNames = profiles
    .filter((profile) => profile.group === group)
    .map((profile) => profile.toolName)
    .sort((left, right) => left.localeCompare(right));

  return {
    name: group,
    description: CAPABILITY_GROUP_DESCRIPTIONS[group],
    toolNames,
    toolCount: toolNames.length,
  };
}

export function buildCapabilitySnapshot(tools: ToolCapabilitySource[]): CapabilitySnapshot {
  const profiles = tools
    .map((tool) => buildCapabilityProfile(tool))
    .sort((left, right) =>
      left.group.localeCompare(right.group) || left.toolName.localeCompare(right.toolName));

  const presets = (Object.keys(CAPABILITY_GROUP_DESCRIPTIONS) as CapabilityGroup[])
    .map((group) => buildCapabilityPreset(group, profiles))
    .filter((preset) => preset.toolCount > 0);

  const summary = profiles.reduce<CapabilitySnapshot['summary']>((acc, profile) => {
    acc.accessCounts[profile.access] += 1;
    acc.groupCounts[profile.group] += 1;
    if (profile.source === 'mcp') {
      acc.mcpTools += 1;
    }
    if (profile.source === 'dynamic') {
      acc.dynamicTools += 1;
    }
    return acc;
  }, {
    accessCounts: {
      'read-only': 0,
      mutable: 0,
      meta: 0,
      external: 0,
    },
    groupCounts: {
      files: 0,
      execution: 0,
      coordination: 0,
      integration: 0,
      external: 0,
      utility: 0,
    },
    mcpTools: 0,
    dynamicTools: 0,
  });

  return {
    totalTools: profiles.length,
    profiles,
    presets,
    summary,
  };
}
