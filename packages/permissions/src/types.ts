import type { PermissionMode, ToolAnnotations } from '@open-agent/core';

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
  /** MCP-aligned tool annotations propagated from ToolDefinition.annotations.
   *  Informational only — does not alter existing deny/allow outcomes.
   *  Downstream stages (e.g. L23 classifier) may consume this field. */
  annotations?: ToolAnnotations;
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
  preflightEnforcedFeatures: Array<'network' | 'writePaths' | 'readPaths'>;
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
  /**
   * Collapsed enforcement mode for this execution record, derived from
   * `provenance.executionEngine`. Queryable without unwrapping provenance:
   *  - 'sandbox-exec': OS-level enforcement was active (macOS sandbox-exec).
   *  - 'policy': Advisory policy only — no OS-level enforcement was applied.
   */
  executionEngine: 'sandbox-exec' | 'policy';
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
  preflightEnforcedFeatures: Array<'network' | 'writePaths' | 'readPaths'>;
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
