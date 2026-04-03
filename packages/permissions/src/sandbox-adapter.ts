import { existsSync } from 'fs';
import { isAbsolute, resolve } from 'path';
import type { BashSandboxExecutionPolicy, SandboxConfig } from './types.js';

export const BASH_SANDBOX_POLICY_FIELD = '__openAgentBashSandboxPolicy';
export const BASH_SANDBOX_BYPASS_APPROVED_FIELD = '__openAgentSandboxBypassApproved';

export interface BuildBashSandboxPolicyInput {
  sandbox?: SandboxConfig;
  cwd: string;
  dangerouslyDisableSandbox?: boolean;
  permissionBehavior?: 'allow' | 'deny' | 'ask';
  bypassApproved?: boolean;
}

export function buildBashSandboxPolicy(input: BuildBashSandboxPolicyInput): BashSandboxExecutionPolicy {
  const sandbox = input.sandbox;
  const bypassRequested = input.dangerouslyDisableSandbox === true;
  const executionEngine = resolveBashSandboxExecutionEngine();

  if (!sandbox?.enabled) {
    return {
      enforce: false,
      executionEngine: 'none',
      enforcedFeatures: {
        network: false,
        writePaths: false,
        readPaths: false,
      },
      allowWritePaths: [],
      denyReadPaths: [],
      denyWritePaths: [],
      networkDisabled: false,
      bypassRequested,
      bypassAllowed: bypassRequested,
    };
  }

  const allowWritePaths = normalizePaths(sandbox.filesystem?.allowWrite, input.cwd);
  const denyReadPaths = normalizePaths(sandbox.filesystem?.denyRead, input.cwd);
  const denyWritePaths = normalizePaths(sandbox.filesystem?.denyWrite, input.cwd);
  const networkDisabled = isNetworkDisabled(sandbox.network);
  const enforcedFeatures = {
    network: executionEngine === 'darwin-sandbox-exec' && networkDisabled,
    writePaths: executionEngine === 'darwin-sandbox-exec' && (allowWritePaths.length > 0 || denyWritePaths.length > 0),
    // `sandbox-exec` does not provide a reliable partial read allow/deny model while also
    // keeping general command execution usable, so we only expose read restrictions as
    // policy metadata for now instead of pretending they are execution-enforced.
    readPaths: false,
  };

  const bypassAllowed = bypassRequested && (
    input.bypassApproved === true || input.permissionBehavior === 'allow'
  );

  return {
    enforce: true,
    executionEngine,
    enforcedFeatures,
    allowWritePaths,
    denyReadPaths,
    denyWritePaths,
    networkDisabled,
    bypassRequested,
    bypassAllowed,
    ...(
      bypassRequested && !bypassAllowed
        ? { reason: 'sandbox bypass requested but not approved' }
        : {}
    ),
  };
}

export function isBashSandboxExecutionPolicy(value: unknown): value is BashSandboxExecutionPolicy {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<BashSandboxExecutionPolicy>;
  return (
    typeof candidate.enforce === 'boolean' &&
    (candidate.executionEngine === 'none' || candidate.executionEngine === 'darwin-sandbox-exec') &&
    !!candidate.enforcedFeatures &&
    typeof candidate.enforcedFeatures.network === 'boolean' &&
    typeof candidate.enforcedFeatures.writePaths === 'boolean' &&
    typeof candidate.enforcedFeatures.readPaths === 'boolean' &&
    Array.isArray(candidate.allowWritePaths) &&
    Array.isArray(candidate.denyReadPaths) &&
    Array.isArray(candidate.denyWritePaths) &&
    typeof candidate.networkDisabled === 'boolean' &&
    typeof candidate.bypassRequested === 'boolean' &&
    typeof candidate.bypassAllowed === 'boolean'
  );
}

function normalizePaths(paths: string[] | undefined, cwd: string): string[] {
  if (!paths || paths.length === 0) return [];
  const unique = new Set<string>();
  for (const path of paths) {
    if (typeof path !== 'string' || path.trim().length === 0) continue;
    unique.add(normalizePath(path, cwd));
  }
  return [...unique];
}

function normalizePath(path: string, cwd: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}

function isNetworkDisabled(network: SandboxConfig['network'] | undefined): boolean {
  if (!network) return false;
  if (network.disabled === true) return true;
  if (Array.isArray(network.allowedDomains) && network.allowedDomains.length === 0) {
    return true;
  }
  return false;
}

function resolveBashSandboxExecutionEngine(): BashSandboxExecutionPolicy['executionEngine'] {
  if (process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec')) {
    return 'darwin-sandbox-exec';
  }
  return 'none';
}
