import type { PermissionMode } from '@open-agent/core';

export interface PermissionRule {
  toolName: string;
  ruleContent?: string; // e.g. glob pattern, command prefix/regex pattern
}

export interface PermissionConfig {
  mode: PermissionMode;
  allowRules: PermissionRule[];
  denyRules: PermissionRule[];
  askRules: PermissionRule[];
  allowedPaths?: string[];
  deniedPaths?: string[];
}

export interface PermissionRequest {
  toolName: string;
  input: Record<string, unknown>;
  toolUseId: string;
  agentId?: string;
  metadata?: PermissionRequestMetadata;
}

export interface PermissionRequestCapabilityMetadata {
  category?: string;
  risk?: 'low' | 'medium' | 'high';
  needsWorkspaceWrite?: boolean;
}

export interface PermissionRequestMetadata {
  readOnly?: boolean;
  destructive?: boolean;
  openWorld?: boolean;
  source?: 'builtin' | 'dynamic' | 'mcp';
  serverName?: string;
  capability?: PermissionRequestCapabilityMetadata;
}

export interface PermissionDecision {
  behavior: 'allow' | 'deny' | 'ask';
  reason?: string;
  updatedInput?: Record<string, unknown>;
}

export interface SandboxConfig {
  enabled: boolean;
  autoAllowBashIfSandboxed?: boolean;
  filesystem?: {
    allowWrite?: string[];
    denyWrite?: string[];
    denyRead?: string[];
  };
  network?: {
    disabled?: boolean;
    allowedDomains?: string[];
    allowLocalBinding?: boolean;
    allowUnixSockets?: string[];
  };
}

export interface BashSandboxExecutionPolicy {
  enforce: boolean;
  allowWritePaths: string[];
  denyWritePaths: string[];
  networkDisabled: boolean;
  bypassRequested: boolean;
  bypassAllowed: boolean;
  reason?: string;
}
