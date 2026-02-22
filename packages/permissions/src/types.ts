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
    allowedDomains?: string[];
    allowLocalBinding?: boolean;
    allowUnixSockets?: string[];
  };
}
