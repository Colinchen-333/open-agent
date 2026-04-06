/**
 * Feature flag registry with three-level resolution:
 * 1. Runtime override (test-only, via setFeatureDefault)
 * 2. Environment variable: OPEN_AGENT_FEATURE_<NAME>=1|0|true|false|yes|no
 * 3. Compile-time default (FEATURE_FLAG_DEFAULTS)
 */

export type FeatureFlagName =
  | 'REACTIVE_COMPACT'
  | 'TRANSCRIPT_CLASSIFIER'
  | 'FORK_SUBAGENT'
  | 'THINKING_ADAPTIVE'
  | 'FILE_HISTORY'
  | 'WORKFLOW_SCRIPTS'
  | 'EXIT_PLAN_MODE_V2'
  | 'DARWIN_SANDBOX'
  | 'REPL_TOOL'
  | 'ENABLE_LSP_TOOL';

export const FEATURE_FLAG_DEFAULTS: Record<FeatureFlagName, boolean> = {
  REACTIVE_COMPACT: true,       // Round 1 L11 is stable
  TRANSCRIPT_CLASSIFIER: false, // Round 2 L23 is experimental
  FORK_SUBAGENT: true,          // Round 1 L6 is stable
  THINKING_ADAPTIVE: false,     // Round 2 L19
  FILE_HISTORY: false,          // Round 2 L20
  WORKFLOW_SCRIPTS: false,      // future
  EXIT_PLAN_MODE_V2: false,     // Round 2 L22
  DARWIN_SANDBOX: process.platform === 'darwin',  // ON by default on macOS, OFF elsewhere (R4.2/R5.3)
  REPL_TOOL: false,             // Experimental: inline JS/TS evaluation (R13.2)
  ENABLE_LSP_TOOL: false,       // LSP code-intelligence stub; needs real LSP server wired in
};

const overrides: Partial<Record<FeatureFlagName, boolean>> = {};

export function feature(name: FeatureFlagName): boolean {
  // 1. Runtime override via setFeatureDefault (test-only)
  if (name in overrides) return overrides[name]!;

  // 2. Environment variable: OPEN_AGENT_FEATURE_<NAME>=1|0|true|false
  const envKey = `OPEN_AGENT_FEATURE_${name}`;
  const envVal = process.env[envKey];
  if (envVal !== undefined) {
    const normalized = envVal.trim().toLowerCase();
    if (normalized === '1' || normalized === 'true' || normalized === 'yes') return true;
    if (normalized === '0' || normalized === 'false' || normalized === 'no') return false;
  }

  // 3. Compile-time default
  return FEATURE_FLAG_DEFAULTS[name];
}

/** Test-only: override a flag at runtime. Clears via clearFeatureOverrides(). */
export function setFeatureDefault(name: FeatureFlagName, value: boolean): void {
  overrides[name] = value;
}

/** Test-only: clear all runtime overrides (for afterEach). */
export function clearFeatureOverrides(): void {
  for (const key of Object.keys(overrides)) {
    delete overrides[key as FeatureFlagName];
  }
}
