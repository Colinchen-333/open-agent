/**
 * MCP server configuration scoping and environment variable expansion.
 * Matches Claude Code's multi-scope config system.
 */

/** Configuration scope — determines precedence and trust level. */
export type ConfigScope = 'local' | 'user' | 'project' | 'enterprise' | 'managed' | 'dynamic';

/** MCP server config with scope metadata. */
export interface ScopedMcpServerConfig {
  /** The raw server config */
  config: Record<string, unknown>;
  /** Where this config came from */
  scope: ConfigScope;
  /** Plugin that provided this config (if any) */
  pluginSource?: string;
  /** Whether this config is from managed/enterprise settings */
  isManaged?: boolean;
}

/**
 * Merge MCP server configs with scope-based precedence.
 * Higher-trust scopes (enterprise > user > project > local) win on conflict.
 * Managed settings are highest precedence.
 */
const SCOPE_PRECEDENCE: Record<ConfigScope, number> = {
  local: 0,
  project: 1,
  user: 2,
  dynamic: 3,
  enterprise: 4,
  managed: 5,
};

export function mergeScopedConfigs(
  configs: ScopedMcpServerConfig[],
): Map<string, ScopedMcpServerConfig> {
  const result = new Map<string, ScopedMcpServerConfig>();

  // Sort by precedence (lowest first, so higher overwrites)
  const sorted = [...configs].sort(
    (a, b) => SCOPE_PRECEDENCE[a.scope] - SCOPE_PRECEDENCE[b.scope],
  );

  for (const cfg of sorted) {
    const name = (cfg.config as any).name ?? (cfg.config as any).serverName ?? 'unknown';
    result.set(name, cfg);
  }

  return result;
}

/**
 * Expand environment variables in a string value.
 * Supports ${VAR}, $VAR, and ${VAR:-default} syntax.
 */
export function expandEnvVars(value: string, env?: Record<string, string | undefined>): string {
  const envSource = env ?? process.env;

  return value.replace(
    /\$\{([a-zA-Z_][a-zA-Z0-9_]*)(?::-(.*?))?\}|\$([a-zA-Z_][a-zA-Z0-9_]*)/g,
    (match, bracedName, defaultValue, bareName) => {
      const varName = bracedName ?? bareName;
      const resolved = envSource[varName];
      if (resolved !== undefined && resolved !== '') return resolved;
      if (defaultValue !== undefined) return defaultValue;
      return match; // Leave unresolved
    },
  );
}

/**
 * Recursively expand environment variables in a config object.
 * Only expands string values; leaves numbers, booleans, arrays, etc. intact.
 */
export function expandConfigEnvVars(
  config: Record<string, unknown>,
  env?: Record<string, string | undefined>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(config)) {
    if (typeof value === 'string') {
      result[key] = expandEnvVars(value, env);
    } else if (Array.isArray(value)) {
      result[key] = value.map(item =>
        typeof item === 'string' ? expandEnvVars(item, env) : item,
      );
    } else if (typeof value === 'object' && value !== null) {
      result[key] = expandConfigEnvVars(value as Record<string, unknown>, env);
    } else {
      result[key] = value;
    }
  }

  return result;
}
