/**
 * Configuration schema validation with error reporting.
 * Replaces ad-hoc JSON merge with structured validation.
 */

export interface ConfigValidationError {
  path: string;
  message: string;
  value?: unknown;
}

export interface ConfigValidationResult {
  valid: boolean;
  errors: ConfigValidationError[];
  /** Cleaned config with invalid fields stripped */
  cleaned: Record<string, unknown>;
}

/** Known config field types for validation */
interface FieldSpec {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  required?: boolean;
  enum?: unknown[];
}

const SETTINGS_SCHEMA: Record<string, FieldSpec> = {
  model: { type: 'string' },
  provider: { type: 'string', enum: ['anthropic', 'openai', 'ollama'] },
  apiKey: { type: 'string' },
  baseUrl: { type: 'string' },
  maxTurns: { type: 'number' },
  permissionMode: { type: 'string', enum: ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'dontAsk'] },
  systemPrompt: { type: 'string' },
  outputFormat: { type: 'string', enum: ['text', 'stream-json'] },
  verbose: { type: 'boolean' },
  debug: { type: 'boolean' },
  mcpServers: { type: 'object' },
  tools: { type: 'object' },
  hooks: { type: 'object' },
  permissions: { type: 'object' },
  agents: { type: 'object' },
};

function validateField(path: string, value: unknown, spec: FieldSpec): ConfigValidationError | null {
  if (value === undefined || value === null) {
    if (spec.required) return { path, message: 'required field is missing' };
    return null;
  }

  const actualType = Array.isArray(value) ? 'array' : typeof value;
  if (actualType !== spec.type) {
    return { path, message: `expected ${spec.type}, got ${actualType}`, value };
  }

  if (spec.enum && !spec.enum.includes(value)) {
    return { path, message: `must be one of: ${spec.enum.join(', ')}`, value };
  }

  return null;
}

/**
 * Validate a configuration object against the known schema.
 * Returns errors for invalid fields and a cleaned config with invalid fields stripped.
 */
export function validateConfig(config: Record<string, unknown>): ConfigValidationResult {
  const errors: ConfigValidationError[] = [];
  const cleaned: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(config)) {
    const spec = SETTINGS_SCHEMA[key];
    if (!spec) {
      // Unknown field — warn but include (forward compatibility)
      cleaned[key] = value;
      continue;
    }

    const error = validateField(key, value, spec);
    if (error) {
      errors.push(error);
      // Strip invalid field from cleaned output
    } else {
      cleaned[key] = value;
    }
  }

  // Check required fields
  for (const [key, spec] of Object.entries(SETTINGS_SCHEMA)) {
    if (spec.required && !(key in config)) {
      errors.push({ path: key, message: 'required field is missing' });
    }
  }

  return { valid: errors.length === 0, errors, cleaned };
}

/**
 * Merge two config objects with validation.
 * Base is the current config, override is the new values.
 * Invalid override values are skipped (base value preserved).
 */
export function mergeConfigWithValidation(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): { merged: Record<string, unknown>; errors: ConfigValidationError[] } {
  const { cleaned, errors } = validateConfig(override);
  const merged = { ...base, ...cleaned };
  return { merged, errors };
}
