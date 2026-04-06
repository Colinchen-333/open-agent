// ---------------------------------------------------------------------------
// Shell-aware tokenizer and bash command classifier
// ---------------------------------------------------------------------------

/**
 * How a flag consumes its argument value (if any).
 */
export type FlagArgType = 'none' | 'number' | 'string';

/**
 * Per-command configuration for validating whether a command invocation
 * is genuinely read-only based on its flags.
 */
export interface ReadOnlyCommandConfig {
  safeFlags: Record<string, FlagArgType>;
  /** Return true if the invocation is dangerous despite matching the command name. */
  additionalDangerCheck?: (args: string[]) => boolean;
}

// ---------------------------------------------------------------------------
// Step 1 — Shell-aware tokenizer
// ---------------------------------------------------------------------------

/**
 * Tokenise a shell command string into an array of *pipeline segments*,
 * splitting on unquoted `&&`, `||`, `|`, and `;`.
 *
 * Within each segment the individual words are tokenised respecting:
 *  - single-quoted strings (everything literal)
 *  - double-quoted strings (`$`, backtick still expand but kept as one token)
 *  - `$(...)` and backtick command substitution (kept as single tokens)
 *  - backslash escapes (`\"`, `\\`, etc.)
 *  - parentheses (stripped at segment boundaries for subshells)
 *
 * Returns `string[][]` — one `string[]` of tokens per segment.
 */
export function tokenizeShellCommand(command: string): string[][] {
  const segments: string[][] = [];
  let currentTokens: string[] = [];
  let currentToken = '';
  let i = 0;
  const len = command.length;

  /** Flush currentToken into currentTokens if non-empty */
  function flushToken(): void {
    if (currentToken.length > 0) {
      currentTokens.push(currentToken);
      currentToken = '';
    }
  }

  /** Flush currentTokens into segments if non-empty */
  function flushSegment(): void {
    flushToken();
    if (currentTokens.length > 0) {
      segments.push(currentTokens);
      currentTokens = [];
    }
  }

  while (i < len) {
    const ch = command[i]!;

    // ---- backslash escape (outside quotes) ----
    if (ch === '\\' && i + 1 < len) {
      currentToken += command[i + 1]!;
      i += 2;
      continue;
    }

    // ---- single quote: consume until closing ' ----
    if (ch === "'") {
      i++; // skip opening '
      while (i < len && command[i] !== "'") {
        currentToken += command[i]!;
        i++;
      }
      i++; // skip closing '
      continue;
    }

    // ---- double quote: consume until unescaped closing " ----
    if (ch === '"') {
      i++; // skip opening "
      while (i < len && command[i] !== '"') {
        if (command[i] === '\\' && i + 1 < len) {
          const next = command[i + 1]!;
          // Inside double quotes, backslash only escapes: $ ` " \ newline
          if (next === '$' || next === '`' || next === '"' || next === '\\') {
            currentToken += next;
            i += 2;
          } else {
            // Literal backslash + next char
            currentToken += '\\';
            currentToken += next;
            i += 2;
          }
        } else {
          currentToken += command[i]!;
          i++;
        }
      }
      i++; // skip closing "
      continue;
    }

    // ---- $(...) command substitution: keep as single token ----
    if (ch === '$' && i + 1 < len && command[i + 1] === '(') {
      currentToken += '$(';
      i += 2;
      let depth = 1;
      while (i < len && depth > 0) {
        if (command[i] === '(') depth++;
        else if (command[i] === ')') depth--;
        if (depth > 0) currentToken += command[i]!;
        i++;
      }
      currentToken += ')';
      continue;
    }

    // ---- backtick command substitution ----
    if (ch === '`') {
      currentToken += '`';
      i++; // skip opening `
      while (i < len && command[i] !== '`') {
        currentToken += command[i]!;
        i++;
      }
      if (i < len) {
        currentToken += '`';
        i++; // skip closing `
      }
      continue;
    }

    // ---- command separators: && || ; | ----
    // Check `&&` and `||` before single `&` and `|`
    if (ch === '&' && i + 1 < len && command[i + 1] === '&') {
      flushSegment();
      i += 2;
      continue;
    }
    if (ch === '|' && i + 1 < len && command[i + 1] === '|') {
      flushSegment();
      i += 2;
      continue;
    }
    if (ch === '|') {
      flushSegment();
      i++;
      continue;
    }
    if (ch === ';') {
      flushSegment();
      i++;
      continue;
    }

    // ---- background `&` (single, not `&&`) ----
    if (ch === '&') {
      // Treat trailing `&` like a separator but don't start a new segment.
      // Just skip it — it doesn't affect command identity.
      flushToken();
      i++;
      continue;
    }

    // ---- subshell parentheses: strip at boundaries ----
    if (ch === '(' || ch === ')') {
      flushToken();
      i++;
      continue;
    }

    // ---- whitespace: token boundary ----
    if (ch === ' ' || ch === '\t' || ch === '\n') {
      flushToken();
      i++;
      continue;
    }

    // ---- I/O redirections: skip redirection operators + their targets ----
    if (ch === '>' || ch === '<') {
      flushToken();
      // skip the redirection operator (>>, >&, <<, etc.)
      i++;
      if (i < len && (command[i] === '>' || command[i] === '&' || command[i] === '<')) {
        i++;
      }
      // skip whitespace
      while (i < len && (command[i] === ' ' || command[i] === '\t')) i++;
      // skip the target filename/fd
      if (i < len && command[i] === '"') {
        i++; // skip "
        while (i < len && command[i] !== '"') i++;
        if (i < len) i++; // skip closing "
      } else if (i < len && command[i] === "'") {
        i++; // skip '
        while (i < len && command[i] !== "'") i++;
        if (i < len) i++; // skip closing '
      } else {
        while (i < len && command[i] !== ' ' && command[i] !== '\t' &&
               command[i] !== '\n' && command[i] !== '&' && command[i] !== '|' &&
               command[i] !== ';' && command[i] !== ')') {
          i++;
        }
      }
      continue;
    }

    // ---- regular character ----
    currentToken += ch;
    i++;
  }

  flushSegment();
  return segments;
}

// ---------------------------------------------------------------------------
// Step 2 — Rewritten extractBashSubcommands using the tokenizer
// ---------------------------------------------------------------------------

const WRAPPER_PREFIXES = new Set(['sudo', 'env', 'time', 'nice', 'nohup', 'xargs']);

/**
 * Extract the primary subcommands from a bash command string.
 * Handles pipes, &&, ||, ;, subshells, and command substitution.
 * Returns an array of [command, ...args] tuples for the top-level commands.
 */
export function extractBashSubcommands(command: string): string[][] {
  const segments = tokenizeShellCommand(command);
  const result: string[][] = [];

  for (const rawTokens of segments) {
    let tokens = [...rawTokens];

    // 1. Strip leading env vars (FOO=bar cmd -> cmd)
    while (tokens.length > 0 && /^\w+=/.test(tokens[0]!)) {
      tokens = tokens.slice(1);
    }

    // 2. Skip common wrapper prefixes that aren't real commands
    while (tokens.length > 0 && WRAPPER_PREFIXES.has(tokens[0]!)) {
      tokens = tokens.slice(1);
    }

    // 3. Strip env vars AGAIN after prefix removal (handles `env FOO=bar cmd`)
    while (tokens.length > 0 && /^\w+=/.test(tokens[0]!)) {
      tokens = tokens.slice(1);
    }

    if (tokens.length === 0) continue;
    result.push(tokens);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Step 3 — Read-only command configs with safe flag whitelists
// ---------------------------------------------------------------------------

/**
 * Comprehensive per-command configs for read-only validation.
 * Keys use the format "command" or "command subcommand" for two-word commands.
 * The safeFlags map lists every flag that is safe for read-only invocations.
 */
export const READ_ONLY_COMMAND_CONFIGS: Record<string, ReadOnlyCommandConfig> = {
  // --- git subcommands ---
  'git log': {
    safeFlags: {
      '--oneline': 'none',
      '--graph': 'none',
      '--all': 'none',
      '--decorate': 'none',
      '--stat': 'none',
      '--shortstat': 'none',
      '--name-only': 'none',
      '--name-status': 'none',
      '--pretty': 'string',
      '--format': 'string',
      '--abbrev-commit': 'none',
      '--no-merges': 'none',
      '--merges': 'none',
      '--first-parent': 'none',
      '--reverse': 'none',
      '--date': 'string',
      '--since': 'string',
      '--until': 'string',
      '--after': 'string',
      '--before': 'string',
      '--author': 'string',
      '--committer': 'string',
      '--grep': 'string',
      '-n': 'number',
      '-p': 'none',
      '--patch': 'none',
      '--follow': 'none',
      '--diff-filter': 'string',
      '--no-walk': 'none',
      '--source': 'none',
      '--remotes': 'none',
      '--branches': 'none',
      '--tags': 'none',
      '--simplify-by-decoration': 'none',
      '--left-right': 'none',
      '--cherry-pick': 'none',
      '--ancestry-path': 'none',
      '--boundary': 'none',
      '--topo-order': 'none',
      '--date-order': 'none',
      '--author-date-order': 'none',
      '--relative-date': 'none',
      '--color': 'string',
      '--no-color': 'none',
      '--abbrev': 'number',
      '-1': 'none',
      '-2': 'none',
      '-3': 'none',
      '-4': 'none',
      '-5': 'none',
      '-10': 'none',
      '-20': 'none',
      '-50': 'none',
      '-100': 'none',
    },
  },
  'git status': {
    safeFlags: {
      '-s': 'none',
      '--short': 'none',
      '-b': 'none',
      '--branch': 'none',
      '--porcelain': 'none',
      '-u': 'string',
      '--untracked-files': 'string',
      '--ignored': 'none',
      '--long': 'none',
      '-v': 'none',
      '--verbose': 'none',
      '--no-ahead-behind': 'none',
      '--column': 'string',
      '--no-column': 'none',
      '--show-stash': 'none',
    },
  },
  'git diff': {
    safeFlags: {
      '--stat': 'none',
      '--shortstat': 'none',
      '--name-only': 'none',
      '--name-status': 'none',
      '--cached': 'none',
      '--staged': 'none',
      '--no-index': 'none',
      '--color': 'string',
      '--no-color': 'none',
      '--word-diff': 'string',
      '-U': 'number',
      '--unified': 'number',
      '-w': 'none',
      '--ignore-all-space': 'none',
      '-b': 'none',
      '--ignore-space-change': 'none',
      '--ignore-blank-lines': 'none',
      '--diff-filter': 'string',
      '--relative': 'string',
      '--src-prefix': 'string',
      '--dst-prefix': 'string',
      '--no-ext-diff': 'none',
      '--patience': 'none',
      '--histogram': 'none',
      '--minimal': 'none',
      '--compact-summary': 'none',
      '--numstat': 'none',
      '--dirstat': 'string',
      '--summary': 'none',
      '--check': 'none',
      '--raw': 'none',
      '--patch-with-stat': 'none',
      '-p': 'none',
      '--patch': 'none',
      '-z': 'none',
    },
  },
  'git show': {
    safeFlags: {
      '--stat': 'none',
      '--shortstat': 'none',
      '--name-only': 'none',
      '--name-status': 'none',
      '--pretty': 'string',
      '--format': 'string',
      '--oneline': 'none',
      '--abbrev-commit': 'none',
      '-s': 'none',
      '--no-patch': 'none',
      '-p': 'none',
      '--patch': 'none',
      '--color': 'string',
      '--no-color': 'none',
      '-q': 'none',
      '--quiet': 'none',
      '--raw': 'none',
      '--diff-filter': 'string',
      '--word-diff': 'string',
    },
  },
  'git branch': {
    safeFlags: {
      '-l': 'none',
      '--list': 'none',
      '-r': 'none',
      '--remotes': 'none',
      '-a': 'none',
      '--all': 'none',
      '-v': 'none',
      '--verbose': 'none',
      '-vv': 'none',
      '--merged': 'string',
      '--no-merged': 'string',
      '--contains': 'string',
      '--no-contains': 'string',
      '--sort': 'string',
      '--format': 'string',
      '--color': 'string',
      '--no-color': 'none',
      '--abbrev': 'number',
      '--column': 'string',
      '--no-column': 'none',
      '--show-current': 'none',
    },
    // git branch <name> creates a branch — only allow listing patterns
    additionalDangerCheck: (args: string[]) => {
      // If there's a non-flag argument that doesn't look like a glob/pattern
      // AND no --list / -l / -r / -a / --all / --remotes / --show-current / -v / -vv
      const listFlags = new Set(['-l', '--list', '-r', '--remotes', '-a', '--all', '--show-current', '-v', '-vv', '--verbose']);
      const hasListFlag = args.some(a => listFlags.has(a));
      // With no flags at all and a positional arg, it creates a branch
      const nonFlagArgs = args.filter(a => !a.startsWith('-'));
      if (!hasListFlag && nonFlagArgs.length > 0) return true;
      return false;
    },
  },
  'git remote': {
    safeFlags: {
      '-v': 'none',
      '--verbose': 'none',
    },
    // `git remote add/remove/rename/set-url` are mutating
    additionalDangerCheck: (args: string[]) => {
      const mutatingSubcmds = new Set(['add', 'remove', 'rm', 'rename', 'set-url', 'set-head', 'prune', 'update']);
      const firstNonFlag = args.find(a => !a.startsWith('-'));
      return firstNonFlag ? mutatingSubcmds.has(firstNonFlag) : false;
    },
  },
  'git tag': {
    safeFlags: {
      '-l': 'none',
      '--list': 'none',
      '-n': 'number',
      '--sort': 'string',
      '--format': 'string',
      '--contains': 'string',
      '--no-contains': 'string',
      '--merged': 'string',
      '--no-merged': 'string',
      '--color': 'string',
      '--no-color': 'none',
      '--column': 'string',
      '--no-column': 'none',
      '-v': 'none',
      '--verify': 'none',
    },
    // `git tag <name>` creates a tag — only allow listing
    additionalDangerCheck: (args: string[]) => {
      const listFlags = new Set(['-l', '--list', '-v', '--verify']);
      const hasListFlag = args.some(a => listFlags.has(a));
      const nonFlagArgs = args.filter(a => !a.startsWith('-'));
      // Without a list flag and with a positional arg, it creates a tag
      if (!hasListFlag && nonFlagArgs.length > 0) return true;
      return false;
    },
  },

  // --- Unix read-only utilities ---
  ls: {
    safeFlags: {
      '-l': 'none',
      '-a': 'none',
      '-la': 'none',
      '-al': 'none',
      '-lah': 'none',
      '-lh': 'none',
      '-R': 'none',
      '-r': 'none',
      '-t': 'none',
      '-S': 'none',
      '-1': 'none',
      '-d': 'none',
      '-F': 'none',
      '-h': 'none',
      '-i': 'none',
      '-n': 'none',
      '-s': 'none',
      '-G': 'none',
      '-p': 'none',
      '--color': 'string',
      '--all': 'none',
      '--almost-all': 'none',
      '--human-readable': 'none',
      '--recursive': 'none',
      '--reverse': 'none',
      '--sort': 'string',
      '--time': 'string',
      '--classify': 'none',
      '--group-directories-first': 'none',
      '--no-group': 'none',
    },
  },
  cat: {
    safeFlags: {
      '-n': 'none',
      '--number': 'none',
      '-b': 'none',
      '--number-nonblank': 'none',
      '-s': 'none',
      '--squeeze-blank': 'none',
      '-v': 'none',
      '-e': 'none',
      '-t': 'none',
      '-A': 'none',
      '-E': 'none',
      '-T': 'none',
      '--show-all': 'none',
      '--show-ends': 'none',
      '--show-tabs': 'none',
      '--show-nonprinting': 'none',
    },
  },
  head: {
    safeFlags: {
      '-n': 'number',
      '--lines': 'number',
      '-c': 'number',
      '--bytes': 'number',
      '-q': 'none',
      '--quiet': 'none',
      '--silent': 'none',
      '-v': 'none',
      '--verbose': 'none',
    },
  },
  tail: {
    safeFlags: {
      '-n': 'number',
      '--lines': 'number',
      '-c': 'number',
      '--bytes': 'number',
      '-f': 'none',
      '--follow': 'none',
      '-F': 'none',
      '-q': 'none',
      '--quiet': 'none',
      '--silent': 'none',
      '-v': 'none',
      '--verbose': 'none',
      '--pid': 'number',
      '-s': 'number',
      '--sleep-interval': 'number',
    },
  },
  wc: {
    safeFlags: {
      '-l': 'none',
      '--lines': 'none',
      '-w': 'none',
      '--words': 'none',
      '-c': 'none',
      '--bytes': 'none',
      '-m': 'none',
      '--chars': 'none',
      '-L': 'none',
      '--max-line-length': 'none',
    },
  },
  find: {
    safeFlags: {
      '-name': 'string',
      '-iname': 'string',
      '-path': 'string',
      '-ipath': 'string',
      '-type': 'string',
      '-maxdepth': 'number',
      '-mindepth': 'number',
      '-size': 'string',
      '-mtime': 'string',
      '-atime': 'string',
      '-ctime': 'string',
      '-newer': 'string',
      '-perm': 'string',
      '-user': 'string',
      '-group': 'string',
      '-print': 'none',
      '-print0': 'none',
      '-ls': 'none',
      '-not': 'none',
      '!': 'none',
      '-o': 'none',
      '-a': 'none',
      '-and': 'none',
      '-or': 'none',
      '-empty': 'none',
      '-readable': 'none',
      '-writable': 'none',
      '-executable': 'none',
      '-follow': 'none',
      '-L': 'none',
      '-H': 'none',
      '-P': 'none',
      '-depth': 'none',
      '-prune': 'none',
      '-regex': 'string',
      '-iregex': 'string',
      '-regextype': 'string',
    },
    // -exec, -execdir, -delete are dangerous
    additionalDangerCheck: (args: string[]) => {
      return args.some(a => a === '-exec' || a === '-execdir' || a === '-delete' || a === '-ok');
    },
  },
  grep: {
    safeFlags: {
      '-i': 'none',
      '--ignore-case': 'none',
      '-v': 'none',
      '--invert-match': 'none',
      '-c': 'none',
      '--count': 'none',
      '-l': 'none',
      '--files-with-matches': 'none',
      '-L': 'none',
      '--files-without-match': 'none',
      '-n': 'none',
      '--line-number': 'none',
      '-H': 'none',
      '--with-filename': 'none',
      '-h': 'none',
      '--no-filename': 'none',
      '-r': 'none',
      '-R': 'none',
      '--recursive': 'none',
      '-w': 'none',
      '--word-regexp': 'none',
      '-x': 'none',
      '--line-regexp': 'none',
      '-e': 'string',
      '--regexp': 'string',
      '-f': 'string',
      '--file': 'string',
      '-m': 'number',
      '--max-count': 'number',
      '-A': 'number',
      '--after-context': 'number',
      '-B': 'number',
      '--before-context': 'number',
      '-C': 'number',
      '--context': 'number',
      '-E': 'none',
      '--extended-regexp': 'none',
      '-F': 'none',
      '--fixed-strings': 'none',
      '-P': 'none',
      '--perl-regexp': 'none',
      '-o': 'none',
      '--only-matching': 'none',
      '-q': 'none',
      '--quiet': 'none',
      '--silent': 'none',
      '--include': 'string',
      '--exclude': 'string',
      '--exclude-dir': 'string',
      '--color': 'string',
      '--colour': 'string',
      '-s': 'none',
      '--no-messages': 'none',
      '-Z': 'none',
      '--null': 'none',
      '-a': 'none',
      '--text': 'none',
      '-b': 'none',
      '--byte-offset': 'none',
    },
  },
  rg: {
    safeFlags: {
      '-i': 'none',
      '--ignore-case': 'none',
      '-S': 'none',
      '--smart-case': 'none',
      '-v': 'none',
      '--invert-match': 'none',
      '-c': 'none',
      '--count': 'none',
      '--count-matches': 'none',
      '-l': 'none',
      '--files-with-matches': 'none',
      '-n': 'none',
      '--line-number': 'none',
      '-N': 'none',
      '--no-line-number': 'none',
      '-H': 'none',
      '--with-filename': 'none',
      '-h': 'none',
      '--no-filename': 'none',
      '-r': 'none',
      '-e': 'string',
      '--regexp': 'string',
      '-f': 'string',
      '--file': 'string',
      '-m': 'number',
      '--max-count': 'number',
      '-A': 'number',
      '--after-context': 'number',
      '-B': 'number',
      '--before-context': 'number',
      '-C': 'number',
      '--context': 'number',
      '-w': 'none',
      '--word-regexp': 'none',
      '-x': 'none',
      '--line-regexp': 'none',
      '-F': 'none',
      '--fixed-strings': 'none',
      '-U': 'none',
      '--multiline': 'none',
      '--multiline-dotall': 'none',
      '-o': 'none',
      '--only-matching': 'none',
      '-q': 'none',
      '--quiet': 'none',
      '-t': 'string',
      '--type': 'string',
      '-T': 'string',
      '--type-not': 'string',
      '-g': 'string',
      '--glob': 'string',
      '--iglob': 'string',
      '--hidden': 'none',
      '--no-hidden': 'none',
      '--no-ignore': 'none',
      '--max-depth': 'number',
      '--maxdepth': 'number',
      '--max-filesize': 'string',
      '--sort': 'string',
      '--sortr': 'string',
      '--color': 'string',
      '--colours': 'string',
      '--colors': 'string',
      '-p': 'none',
      '--pretty': 'none',
      '-j': 'number',
      '--threads': 'number',
      '--json': 'none',
      '--vimgrep': 'none',
      '--pcre2': 'none',
      '--trim': 'none',
      '--no-unicode': 'none',
      '--stats': 'none',
      '-z': 'none',
      '--search-zip': 'none',
      '--heading': 'none',
      '--no-heading': 'none',
      '-L': 'none',
      '--follow': 'none',
      '--files': 'none',
      '--type-list': 'none',
      '-0': 'none',
      '--null': 'none',
    },
  },

  // --- Simple read-only commands (accept any flags — low risk) ---
  echo: { safeFlags: {} },
  printf: { safeFlags: {} },
  pwd: { safeFlags: {} },
  date: { safeFlags: {} },
  uname: { safeFlags: {} },
  hostname: { safeFlags: {} },
  whoami: { safeFlags: {} },
  id: { safeFlags: {} },
  env: { safeFlags: {} },
  printenv: { safeFlags: {} },
  which: { safeFlags: {} },
  whereis: { safeFlags: {} },
  type: { safeFlags: {} },
  less: { safeFlags: {} },
  more: { safeFlags: {} },
  file: { safeFlags: {} },
  stat: { safeFlags: {} },
  tree: { safeFlags: {} },
  du: { safeFlags: {} },
  df: { safeFlags: {} },
  set: { safeFlags: {} },
  ag: { safeFlags: {} },
  ack: { safeFlags: {} },
  // Note: 'ripgrep' is usually invoked as 'rg'; keeping for compat
  ripgrep: { safeFlags: {} },
};

// Commands with empty safeFlags accept any flags (inherently safe commands).
// Commands with populated safeFlags reject unknown flags.

// ---------------------------------------------------------------------------
// Step 4 — Flag-based read-only validation
// ---------------------------------------------------------------------------

/**
 * Determine whether a token array represents a genuinely read-only invocation.
 * Looks up the command (single-word or two-word) in READ_ONLY_COMMAND_CONFIGS
 * and validates all flags against the safe-flag whitelist.
 */
export function isReadOnlyCommand(tokens: string[]): boolean {
  if (tokens.length === 0) return false;

  const cmdName = tokens[0]!;
  const twoWord = tokens.length >= 2 ? `${tokens[0]} ${tokens[1]}` : '';

  // Try two-word match first (e.g., "git log"), then single-word
  let config: ReadOnlyCommandConfig | undefined;
  let argsStart: number;

  if (twoWord && READ_ONLY_COMMAND_CONFIGS[twoWord]) {
    config = READ_ONLY_COMMAND_CONFIGS[twoWord];
    argsStart = 2;
  } else if (READ_ONLY_COMMAND_CONFIGS[cmdName]) {
    config = READ_ONLY_COMMAND_CONFIGS[cmdName];
    argsStart = 1;
  } else {
    return false;
  }

  const args = tokens.slice(argsStart);

  // Empty safeFlags means "accept any flags" — the command is inherently safe
  const hasFlagWhitelist = Object.keys(config.safeFlags).length > 0;

  if (hasFlagWhitelist) {
    // Validate each flag against the whitelist
    for (let j = 0; j < args.length; j++) {
      const arg = args[j]!;
      if (!arg.startsWith('-')) continue; // positional argument, skip

      // Handle --flag=value syntax
      const eqIdx = arg.indexOf('=');
      const flagName = eqIdx >= 0 ? arg.slice(0, eqIdx) : arg;

      const flagType = config.safeFlags[flagName];
      if (flagType === undefined) {
        // Unknown flag — not safe
        return false;
      }

      // If the flag takes an argument and it's not in --flag=value form,
      // skip the next token (the argument value)
      if (flagType !== 'none' && eqIdx < 0) {
        j++; // skip the next token (flag's argument)
      }
    }
  }

  // Run additional danger check if present
  if (config.additionalDangerCheck && config.additionalDangerCheck(args)) {
    return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Step 5 — Updated classifyBashCommand using tokenizer + flag validation
// ---------------------------------------------------------------------------

/**
 * Classify a bash command's primary operations for permission heuristics.
 */
export interface BashCommandClassification {
  /** Primary commands found (e.g., ['git', 'rm', 'curl']). */
  commands: string[];
  /** True if any command is a known destructive operation. */
  hasDestructive: boolean;
  /** True if any command accesses the network. */
  hasNetwork: boolean;
  /** True if all commands are read-only. */
  isReadOnly: boolean;
  /** True if the command involves package installation. */
  hasPackageInstall: boolean;
}

const DESTRUCTIVE_COMMANDS = new Set([
  'rm',
  'rmdir',
  'mv',
  'dd',
  'mkfs',
  'fdisk',
  'git push',
  'git reset',
  'git rebase',
  'git merge',
  'docker rm',
  'docker rmi',
  'docker system prune',
  'kubectl delete',
  'terraform destroy',
  'drop',
  'truncate',
  'delete',
]);

const NETWORK_COMMANDS = new Set([
  'curl',
  'wget',
  'ssh',
  'scp',
  'rsync',
  'ftp',
  'sftp',
  'git clone',
  'git fetch',
  'git pull',
  'git push',
  'npm install',
  'npm publish',
  'yarn',
  'pnpm',
  'bun install',
  'bun add',
  'pip install',
  'pip3 install',
  'docker pull',
  'docker push',
]);

const PACKAGE_INSTALL_COMMANDS = new Set([
  'npm install',
  'npm i',
  'npm add',
  'npm ci',
  'yarn',
  'yarn add',
  'yarn install',
  'pnpm install',
  'pnpm add',
  'bun install',
  'bun add',
  'pip install',
  'pip3 install',
  'brew install',
  'apt install',
  'apt-get install',
]);

export function classifyBashCommand(command: string): BashCommandClassification {
  const subcmds = extractBashSubcommands(command);
  const commands = subcmds.map(tokens => tokens[0] ?? '').filter(Boolean);

  // Build two-word commands for compound matching (e.g., "git push")
  const twoWordCommands = subcmds
    .filter(tokens => tokens.length >= 2)
    .map(tokens => `${tokens[0]} ${tokens[1]}`);

  const allCommandForms = [...commands, ...twoWordCommands];

  return {
    commands,
    hasDestructive: allCommandForms.some(c => DESTRUCTIVE_COMMANDS.has(c)),
    hasNetwork: allCommandForms.some(c => NETWORK_COMMANDS.has(c)),
    isReadOnly:
      commands.length > 0 &&
      subcmds.every(tokens => isReadOnlyCommand(tokens)),
    hasPackageInstall: allCommandForms.some(c => PACKAGE_INSTALL_COMMANDS.has(c)),
  };
}
