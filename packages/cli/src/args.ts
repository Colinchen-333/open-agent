export interface CliArgs {
  model?: string;
  resume?: string;
  continue?: boolean;
  permissionMode?: string;
  outputFormat?: 'text' | 'stream-json';
  maxTurns?: number;
  prompt?: string;
  print?: boolean;
  help?: boolean;
  version?: boolean;
  verbose?: boolean;
  provider?: string;
  apiKey?: string;
  baseURL?: string;
}

/**
 * Parse process.argv.slice(2) into a CliArgs object.
 *
 * Supports:
 *   --key value      (space-separated)
 *   --key=value      (equals-sign)
 *   --flag           (boolean flag)
 *   -x               (short aliases)
 *   positional args  (treated as prompt text, joined with spaces)
 */
export function parseArgs(argv: string[]): CliArgs {
  const result: CliArgs = {};
  const positional: string[] = [];
  let i = 0;

  /** Consume the next token as the value for the current flag. */
  function nextValue(): string | undefined {
    if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) {
      return argv[++i];
    }
    return undefined;
  }

  while (i < argv.length) {
    const raw = argv[i];

    // --key=value form
    if (raw.startsWith('--') && raw.includes('=')) {
      const eq = raw.indexOf('=');
      const key = raw.slice(2, eq);
      const value = raw.slice(eq + 1);
      applyLongFlag(result, key, value);
      i++;
      continue;
    }

    // --key [value] form
    if (raw.startsWith('--')) {
      const key = raw.slice(2);
      // Peek whether this flag takes a value argument or is boolean-only.
      if (isBooleanFlag(key)) {
        applyLongFlag(result, key, 'true');
        i++;
      } else {
        const value = nextValue();
        applyLongFlag(result, key, value ?? 'true');
        i++;
      }
      continue;
    }

    // -x [value] short flags
    if (raw.startsWith('-') && raw.length === 2) {
      const key = raw.slice(1);
      if (isBooleanShort(key)) {
        applyShortFlag(result, key, 'true');
        i++;
      } else {
        const value = nextValue();
        applyShortFlag(result, key, value ?? 'true');
        i++;
      }
      continue;
    }

    // Positional argument (plain text, not starting with -)
    positional.push(raw);
    i++;
  }

  // Join all positional tokens as the prompt (if not already set via --prompt)
  if (positional.length > 0 && result.prompt === undefined) {
    result.prompt = positional.join(' ');
  }

  return result;
}

/** Flags that are purely boolean and never consume the next token. */
function isBooleanFlag(key: string): boolean {
  return ['continue', 'print', 'help', 'version', 'verbose', 'debug'].includes(key);
}

function isBooleanShort(key: string): boolean {
  return ['c', 'h', 'v'].includes(key);
}

function applyLongFlag(result: CliArgs, key: string, value: string | undefined): void {
  switch (key) {
    case 'model':
      result.model = value;
      break;
    case 'resume':
      result.resume = value;
      break;
    case 'continue':
      result.continue = value !== 'false';
      break;
    case 'permission-mode':
      result.permissionMode = value;
      break;
    case 'output-format':
      if (value === 'text' || value === 'stream-json') {
        result.outputFormat = value;
      }
      break;
    case 'max-turns': {
      const n = parseInt(value ?? '', 10);
      if (!isNaN(n)) result.maxTurns = n;
      break;
    }
    case 'prompt':
      result.prompt = value;
      break;
    case 'print':
      result.print = value !== 'false';
      break;
    case 'help':
      result.help = true;
      break;
    case 'version':
      result.version = true;
      break;
    case 'verbose':
    case 'debug':
      result.verbose = value !== 'false';
      break;
    case 'provider':
      result.provider = value;
      break;
    case 'api-key':
      result.apiKey = value;
      break;
    case 'base-url':
      result.baseURL = value;
      break;
    // Unknown flags are silently ignored
  }
}

function applyShortFlag(result: CliArgs, key: string, value: string | undefined): void {
  switch (key) {
    case 'm':
      result.model = value;
      break;
    case 'r':
      result.resume = value;
      break;
    case 'c':
      result.continue = value !== 'false';
      break;
    case 'p':
      result.prompt = value;
      break;
    case 'h':
      result.help = true;
      break;
    case 'v':
      result.version = true;
      break;
    // Unknown short flags are silently ignored
  }
}
