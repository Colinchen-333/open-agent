import type { AgentDefinition, McpServerConfig, HookEvent } from '@open-agent/core';

export interface PluginManifest {
  name: string;
  version: string;
  description?: string;
  author?: string;

  // 插件提供的能力
  agents?: Record<string, AgentDefinition>;
  skills?: SkillDefinition[];
  commands?: CommandDefinition[];
  mcpServers?: Record<string, McpServerConfig>;
  hooks?: Record<string, HookConfig[]>;
}

export interface SkillDefinition {
  name: string;
  description: string;
  version?: string;
  prompt: string;
  // 激活条件
  activationKeywords?: string[];
  allowedTools?: string[];
}

export interface CommandDefinition {
  name: string;
  description: string;
  argumentHint?: string;
  prompt: string;
  allowedTools?: string[];
}

export interface HookConfig {
  command: string;
  matcher?: string;
  timeout?: number;
}

export interface LoadedPlugin {
  manifest: PluginManifest;
  path: string;
  enabled: boolean;
}

export interface PluginConfig {
  type: 'local';
  path: string;
}

// Re-export HookEvent so consumers can reference it without importing core directly
export type { HookEvent };
