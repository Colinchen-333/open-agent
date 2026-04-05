import type { BashSandboxExecutionFinding } from './types.js';

export type { BashSandboxExecutionFinding };

export interface SandboxViolationRule {
  category: 'filesystem' | 'network' | 'process' | 'other';
  pathPattern?: string;
  reason: string;
  silent?: boolean;
}

export interface SandboxMetaPolicy {
  enabledPlatforms?: Array<'darwin' | 'linux' | 'windows'>;
  allowManagedReadPathsOnly?: boolean;
  ignoreViolations?: SandboxViolationRule[];
}

/** Check if the sandbox should be enforced on the current platform given the meta policy. */
export function isSandboxEnabledOnPlatform(
  policy: SandboxMetaPolicy,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (!policy.enabledPlatforms) return true;
  const mapped = normalizePlatform(platform);
  return mapped ? policy.enabledPlatforms.includes(mapped) : false;
}

function normalizePlatform(p: NodeJS.Platform): 'darwin' | 'linux' | 'windows' | null {
  if (p === 'darwin') return 'darwin';
  if (p === 'linux') return 'linux';
  if (p === 'win32') return 'windows';
  return null;
}

/**
 * Check if a violation finding matches any ignoreViolations rule.
 * Returns the matched rule if found, null otherwise.
 */
export function matchIgnoreRule(
  finding: BashSandboxExecutionFinding,
  policy: SandboxMetaPolicy,
): SandboxViolationRule | null {
  if (!policy.ignoreViolations || policy.ignoreViolations.length === 0) return null;
  const category = mapFindingCategory(finding);
  for (const rule of policy.ignoreViolations) {
    if (rule.category !== category) continue;
    if (rule.pathPattern) {
      const target = (finding as any).target ?? '';
      if (typeof target === 'string' && !matchesPattern(target, rule.pathPattern)) continue;
    }
    return rule;
  }
  return null;
}

function mapFindingCategory(finding: BashSandboxExecutionFinding): 'filesystem' | 'network' | 'process' | 'other' {
  const scope = (finding as any).scope ?? '';
  if (scope === 'filesystem') return 'filesystem';
  if (scope === 'network') return 'network';
  if (scope === 'process') return 'process';
  return 'other';
}

/** Simple glob matcher: `*` = any chars except slash, `**` = any chars including slash. */
function matchesPattern(target: string, pattern: string): boolean {
  // Escape regex special chars except * and /
  const regexStr = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '__DOUBLE_STAR__')
    .replace(/\*/g, '[^/]*')
    .replace(/__DOUBLE_STAR__/g, '.*');
  return new RegExp(`^${regexStr}$`).test(target);
}

/**
 * Filter findings through the ignoreViolations rules. Returns the list of
 * findings that are NOT ignored. Matched-ignored findings with `silent: false`
 * are still logged via `onIgnoredViolation` (if provided).
 */
export function filterIgnoredFindings(
  findings: BashSandboxExecutionFinding[],
  policy: SandboxMetaPolicy,
  onIgnoredViolation?: (finding: BashSandboxExecutionFinding, rule: SandboxViolationRule) => void,
): BashSandboxExecutionFinding[] {
  if (!policy.ignoreViolations || policy.ignoreViolations.length === 0) return findings;
  const kept: BashSandboxExecutionFinding[] = [];
  for (const finding of findings) {
    const rule = matchIgnoreRule(finding, policy);
    if (!rule) {
      kept.push(finding);
    } else if (!rule.silent && onIgnoredViolation) {
      onIgnoredViolation(finding, rule);
    }
  }
  return kept;
}

/**
 * Validate that read paths added by a non-managed (user) settings source are not
 * adding paths beyond what the managed policy allows. Used when merging user
 * settings with enterprise-managed policy.
 */
export function enforceManagedReadPathsOnly(
  userReadPaths: string[],
  managedReadPaths: string[],
  policy: SandboxMetaPolicy,
): { allowed: string[]; rejected: string[] } {
  if (!policy.allowManagedReadPathsOnly) {
    return { allowed: [...userReadPaths], rejected: [] };
  }
  const managedSet = new Set(managedReadPaths);
  const allowed: string[] = [];
  const rejected: string[] = [];
  for (const p of userReadPaths) {
    if (managedSet.has(p)) {
      allowed.push(p);
    } else {
      rejected.push(p);
    }
  }
  return { allowed, rejected };
}
