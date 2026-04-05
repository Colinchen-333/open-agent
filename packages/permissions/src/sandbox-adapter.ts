import { existsSync } from 'fs';
import { isAbsolute, resolve } from 'path';
import type { BashSandboxExecutionFinding, BashSandboxExecutionPolicy, SandboxConfig } from './types.js';

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
      boundaryKind: 'none',
      enforcedFeatures: {
        network: false,
        writePaths: false,
        readPaths: false,
      },
      preflightEnforcedFeatures: [],
      hardEnforcedFeatures: [],
      policyOnlyFeatures: [],
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
  const hardEnforcedFeatures = (Object.entries(enforcedFeatures) as Array<[
    'network' | 'writePaths' | 'readPaths',
    boolean,
  ]>)
    .filter(([, enforced]) => enforced)
    .map(([feature]) => feature);
  const preflightEnforcedFeatures = ([
    networkDisabled ? 'network' : null,
    allowWritePaths.length > 0 || denyWritePaths.length > 0 ? 'writePaths' : null,
    denyReadPaths.length > 0 ? 'readPaths' : null,
  ] as const)
    .filter((feature): feature is 'network' | 'writePaths' | 'readPaths' => feature !== null);
  const policyOnlyFeatures = ([
    networkDisabled ? 'network' : null,
    allowWritePaths.length > 0 || denyWritePaths.length > 0 ? 'writePaths' : null,
    denyReadPaths.length > 0 ? 'readPaths' : null,
  ] as const)
    .filter((feature): feature is 'network' | 'writePaths' | 'readPaths' => feature !== null)
    .filter((feature) => !hardEnforcedFeatures.includes(feature));
  const boundaryKind = hardEnforcedFeatures.length === 0
    ? 'policy_only'
    : policyOnlyFeatures.length === 0
      ? 'hard'
      : 'mixed';

  const bypassAllowed = bypassRequested && (
    input.bypassApproved === true || input.permissionBehavior === 'allow'
  );
  const findings: BashSandboxExecutionFinding[] = [];
  if (executionEngine === 'none') {
    findings.push({
      stage: 'policy',
      scope: 'sandbox',
      code: 'sandbox_execution_engine_unavailable',
      severity: 'warning',
      message: 'native sandbox execution is unavailable; sandbox enforcement is policy-only',
    });
  }
  if (networkDisabled && !enforcedFeatures.network) {
    findings.push({
      stage: 'policy',
      scope: 'network',
      code: 'network_policy_only',
      severity: 'warning',
      message: 'network restrictions are configured but not hard-enforced by the current execution engine',
    });
  }
  if (denyReadPaths.length > 0 && !enforcedFeatures.readPaths) {
    findings.push({
      stage: 'policy',
      scope: 'filesystem',
      code: 'read_paths_policy_only',
      severity: 'warning',
      message: 'denyRead filesystem rules are tracked as policy metadata only',
      target: denyReadPaths.join(':'),
    });
  }
  if (bypassRequested && !bypassAllowed) {
    findings.push({
      stage: 'policy',
      scope: 'sandbox',
      code: 'sandbox_bypass_blocked',
      severity: 'error',
      message: 'sandbox bypass requested but not approved',
    });
  }

  return {
    enforce: true,
    executionEngine,
    boundaryKind,
    enforcedFeatures,
    preflightEnforcedFeatures,
    hardEnforcedFeatures,
    policyOnlyFeatures,
    allowWritePaths,
    denyReadPaths,
    denyWritePaths,
    networkDisabled,
    bypassRequested,
    bypassAllowed,
    ...(findings.length > 0 ? { findings } : {}),
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
    (
      candidate.boundaryKind === 'none'
      || candidate.boundaryKind === 'policy_only'
      || candidate.boundaryKind === 'mixed'
      || candidate.boundaryKind === 'hard'
    ) &&
    !!candidate.enforcedFeatures &&
    typeof candidate.enforcedFeatures.network === 'boolean' &&
    typeof candidate.enforcedFeatures.writePaths === 'boolean' &&
    typeof candidate.enforcedFeatures.readPaths === 'boolean' &&
    Array.isArray(candidate.hardEnforcedFeatures) &&
    Array.isArray(candidate.preflightEnforcedFeatures) &&
    Array.isArray(candidate.policyOnlyFeatures) &&
    Array.isArray(candidate.allowWritePaths) &&
    Array.isArray(candidate.denyReadPaths) &&
    Array.isArray(candidate.denyWritePaths) &&
    typeof candidate.networkDisabled === 'boolean' &&
    typeof candidate.bypassRequested === 'boolean' &&
    typeof candidate.bypassAllowed === 'boolean' &&
    (candidate.findings === undefined || Array.isArray(candidate.findings))
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
