/**
 * CLI argument validation -- detect and warn about unknown flags.
 * Matches Claude Code's strict argument handling.
 */

export interface ArgValidationResult {
  valid: boolean;
  unknownFlags: string[];
  warnings: string[];
}

/**
 * Validate parsed CLI args against a set of known flag names.
 * Returns unknown flags that weren't recognized.
 */
export function validateArgs(
  rawArgs: string[],
  knownFlags: Set<string>,
): ArgValidationResult {
  const unknownFlags: string[] = [];
  const warnings: string[] = [];

  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i]!;

    // Skip non-flag arguments (positional)
    if (!arg.startsWith('-')) continue;

    // Handle --flag=value
    const flagName = arg.includes('=') ? arg.split('=')[0]! : arg;

    // Normalize: --no-xxx -> --xxx for boolean negation
    const normalized = flagName.replace(/^--no-/, '--');

    if (!knownFlags.has(flagName) && !knownFlags.has(normalized)) {
      unknownFlags.push(flagName);
      warnings.push(`Unknown flag: ${flagName}`);
    }
  }

  return {
    valid: unknownFlags.length === 0,
    unknownFlags,
    warnings,
  };
}

/** Known CLI flags for the open-agent CLI. */
export const KNOWN_CLI_FLAGS = new Set([
  '-p', '--prompt',
  '-m', '--model',
  '--provider',
  '--api-key',
  '--base-url',
  '--system-prompt',
  '--max-turns',
  '--permission-mode',
  '--output-format',
  '--input-format',
  '--verbose', '-v',
  '--debug',
  '--version',
  '--help', '-h',
  '--no-profile',
  '--cwd',
  '--resume',
  '--session-id',
  '--agent',
  '--team',
  '--name',
  '--color',
  '--no-color',
  '--json',
  '--quiet', '-q',
  '--dangerously-skip-permissions',
]);
