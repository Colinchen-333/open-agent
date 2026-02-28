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
  systemPrompt?: string;
  appendSystemPrompt?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  dangerouslySkipPermissions?: boolean;
  json?: boolean;
  cwd?: string;
  noMarkdown?: boolean;
  inputFormat?: 'text' | 'stream-json';
  addDirs?: string[];
  permissionPromptTool?: string;
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
  return ['continue', 'print', 'help', 'version', 'verbose', 'debug', 'dangerouslySkipPermissions', 'json', 'no-markdown', 'noMarkdown'].includes(key);
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
    case 'system-prompt':
      result.systemPrompt = value;
      break;
    case 'allowedTools':
    case 'allowed-tools':
      result.allowedTools = value?.split(',').map(s => s.trim()).filter(Boolean);
      break;
    case 'disallowedTools':
    case 'disallowed-tools':
      result.disallowedTools = value?.split(',').map(s => s.trim()).filter(Boolean);
      break;
    case 'dangerouslySkipPermissions':
      result.dangerouslySkipPermissions = value !== 'false';
      break;
    case 'json':
      result.json = value !== 'false';
      break;
    case 'cwd':
      result.cwd = value;
      break;
    case 'append-system-prompt':
    case 'appendSystemPrompt':
      result.appendSystemPrompt = value;
      break;
    case 'no-markdown':
    case 'noMarkdown':
      result.noMarkdown = value !== 'false';
      break;
    case 'input-format':
    case 'inputFormat':
      if (value === 'text' || value === 'stream-json') {
        result.inputFormat = value;
      }
      break;
    case 'add-dir':
    case 'addDir':
      if (!result.addDirs) result.addDirs = [];
      if (value && value !== 'true') result.addDirs.push(value);
      break;
    case 'permission-prompt-tool':
    case 'permissionPromptTool':
      result.permissionPromptTool = value;
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
      // -p is the short alias for --prompt.
      if (value && value !== 'true') result.prompt = value;
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
