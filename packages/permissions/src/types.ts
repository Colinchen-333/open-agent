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

export interface BashSandboxExecutionFinding {
  stage: 'policy' | 'preflight' | 'runtime';
  scope: 'sandbox' | 'filesystem' | 'network' | 'execution';
  code: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
  target?: string;
}

export interface BashSandboxExecutionProvenance {
  sessionId: string;
  toolUseId?: string;
  cwd: string;
  command: string;
  runInBackground: boolean;
  executionEngine: 'none' | 'darwin-sandbox-exec';
  boundaryKind: 'none' | 'policy_only' | 'mixed' | 'hard';
  enforcedFeatures: {
    network: boolean;
    writePaths: boolean;
    readPaths: boolean;
  };
  hardEnforcedFeatures: Array<'network' | 'writePaths' | 'readPaths'>;
  policyOnlyFeatures: Array<'network' | 'writePaths' | 'readPaths'>;
  bypassRequested: boolean;
  bypassAllowed: boolean;
  wrappedWithSandboxExec: boolean;
}

export interface BashSandboxExecutionRecord {
  timestamp: string;
  outcome: 'success' | 'blocked' | 'failed' | 'timed_out' | 'aborted' | 'started';
  provenance: BashSandboxExecutionProvenance;
  findings: BashSandboxExecutionFinding[];
  exitCode?: number | null;
  finalCwd?: string | null;
  outputLength?: number;
  backgroundTaskId?: string;
}

export interface BashSandboxExecutionPolicy {
  enforce: boolean;
  executionEngine: 'none' | 'darwin-sandbox-exec';
  boundaryKind: 'none' | 'policy_only' | 'mixed' | 'hard';
  enforcedFeatures: {
    network: boolean;
    writePaths: boolean;
    readPaths: boolean;
  };
  hardEnforcedFeatures: Array<'network' | 'writePaths' | 'readPaths'>;
  policyOnlyFeatures: Array<'network' | 'writePaths' | 'readPaths'>;
  allowWritePaths: string[];
  denyReadPaths: string[];
  denyWritePaths: string[];
  networkDisabled: boolean;
  bypassRequested: boolean;
  bypassAllowed: boolean;
  reason?: string;
  findings?: BashSandboxExecutionFinding[];
}
