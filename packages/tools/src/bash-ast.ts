/**
 * Fail-closed bash AST security walker.
 * Classifies commands as 'simple' (safely analyzable) or 'too-complex'
 * (contains constructs that could hide dangerous operations).
 *
 * Matches Claude Code's parseForSecurityFromAst pattern.
 */

/** A simple command extracted from the AST */
export interface SimpleCommand {
  /** argv[0] is the command name, rest are arguments */
  argv: string[];
  /** Environment variable assignments (VAR=val before the command) */
  envVars: Array<{ name: string; value: string }>;
  /** Output redirections */
  redirects: Array<{ op: string; target: string; fd?: number }>;
  /** Original source text span */
  text: string;
}

/** Parse result: either safe-to-analyze commands or too-complex */
export type ParseForSecurityResult =
  | { kind: 'simple'; commands: SimpleCommand[] }
  | { kind: 'too-complex'; reason: string; nodeType?: string }
  | { kind: 'parse-error'; error: string };

/**
 * Characters that signal the command is too complex for static analysis.
 * Control characters can cause parser differentials (tree-sitter vs bash).
 */
const DANGEROUS_CHARS = /[\x00-\x08\x0e-\x1f\x7f]/; // control chars except \t \n \r

const UNICODE_WHITESPACE = /[\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]/;

/**
 * Pre-check the command for characters that could cause parser differentials.
 */
function preCheck(command: string): string | null {
  if (DANGEROUS_CHARS.test(command)) return 'contains control characters';
  if (UNICODE_WHITESPACE.test(command)) return 'contains unicode whitespace';
  if (command.includes('\r')) return 'contains carriage return';
  if (command.includes('\0')) return 'contains null byte';
  return null;
}

/** Redirect operators (sorted longest-first so we match >> before >) */
const REDIRECT_OPS = ['&>>', '&>', '>>>', '>>', '<<', '<<<', '>&', '<&', '>', '<'] as const;

// ---------------------------------------------------------------------------
// Redirect-aware tokenizer
// ---------------------------------------------------------------------------
// The upstream tokenizeShellCommand in bash-subcommands.ts silently discards
// redirect operators and their targets.  For the security walker we need that
// information, so we provide a local tokenizer that preserves it.
// ---------------------------------------------------------------------------

interface RawToken {
  value: string;
  /** 'word' | 'redirect-op' */
  kind: 'word' | 'redirect-op';
}

/**
 * Tokenize a single pipeline segment (no unquoted |, &&, ||, ;) into
 * RawTokens, preserving redirect operators as separate tokens.
 */
function tokenizeSegment(segment: string): RawToken[] {
  const tokens: RawToken[] = [];
  let current = '';
  let i = 0;
  const len = segment.length;

  function flush(): void {
    if (current.length > 0) {
      tokens.push({ value: current, kind: 'word' });
      current = '';
    }
  }

  while (i < len) {
    const ch = segment[i]!;

    // backslash escape
    if (ch === '\\' && i + 1 < len) {
      current += segment[i + 1]!;
      i += 2;
      continue;
    }

    // single quote
    if (ch === "'") {
      i++;
      while (i < len && segment[i] !== "'") {
        current += segment[i]!;
        i++;
      }
      i++; // skip closing '
      continue;
    }

    // double quote
    if (ch === '"') {
      i++;
      while (i < len && segment[i] !== '"') {
        if (segment[i] === '\\' && i + 1 < len) {
          const next = segment[i + 1]!;
          if (next === '$' || next === '`' || next === '"' || next === '\\') {
            current += next;
            i += 2;
          } else {
            current += '\\';
            current += next;
            i += 2;
          }
        } else {
          current += segment[i]!;
          i++;
        }
      }
      i++; // skip closing "
      continue;
    }

    // $(...) command substitution — keep as single token
    if (ch === '$' && i + 1 < len && segment[i + 1] === '(') {
      current += '$(';
      i += 2;
      let depth = 1;
      while (i < len && depth > 0) {
        if (segment[i] === '(') depth++;
        else if (segment[i] === ')') depth--;
        if (depth > 0) current += segment[i]!;
        i++;
      }
      current += ')';
      continue;
    }

    // backtick command substitution
    if (ch === '`') {
      current += '`';
      i++;
      while (i < len && segment[i] !== '`') {
        current += segment[i]!;
        i++;
      }
      if (i < len) {
        current += '`';
        i++;
      }
      continue;
    }

    // subshell parens — strip
    if (ch === '(' || ch === ')') {
      flush();
      i++;
      continue;
    }

    // whitespace — token boundary
    if (ch === ' ' || ch === '\t' || ch === '\n') {
      flush();
      i++;
      continue;
    }

    // redirect operators (check before treating as regular char)
    if (ch === '>' || ch === '<' || ch === '&') {
      // Try matching fd-prefixed redirects like 2> or 2>>
      // First check if current token is a bare number that should become an fd prefix
      const rest = segment.slice(i);
      let matched = false;

      // Check for &>> or &>
      for (const op of REDIRECT_OPS) {
        if (rest.startsWith(op)) {
          flush();
          tokens.push({ value: op, kind: 'redirect-op' });
          i += op.length;
          matched = true;
          break;
        }
      }
      if (matched) continue;
    }

    // Check if we're building a number that might be an fd prefix for a redirect
    // e.g. "2>" — the '2' is already in current, and we see '>'
    // We handle this by checking when we see > or < whether current is purely digits
    if ((ch === '>' || ch === '<') && /^\d+$/.test(current)) {
      const fd = current;
      const rest = segment.slice(i);
      for (const op of REDIRECT_OPS) {
        if (op[0] === ch && rest.startsWith(op)) {
          // The current numeric token is an fd
          tokens.push({ value: fd + op, kind: 'redirect-op' });
          current = '';
          i += op.length;
          break;
        }
      }
      if (current === '') continue; // matched fd+op
    }

    // regular character
    current += ch;
    i++;
  }

  flush();
  return tokens;
}

/**
 * Split a command string into segments at unquoted |, &&, ||, ;
 * Returns the raw text of each segment.
 */
function splitSegments(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let i = 0;
  const len = command.length;

  while (i < len) {
    const ch = command[i]!;

    // backslash
    if (ch === '\\' && i + 1 < len) {
      current += ch + command[i + 1]!;
      i += 2;
      continue;
    }

    // single quote
    if (ch === "'") {
      current += ch;
      i++;
      while (i < len && command[i] !== "'") {
        current += command[i]!;
        i++;
      }
      if (i < len) { current += "'"; i++; }
      continue;
    }

    // double quote
    if (ch === '"') {
      current += ch;
      i++;
      while (i < len && command[i] !== '"') {
        if (command[i] === '\\' && i + 1 < len) {
          current += '\\' + command[i + 1]!;
          i += 2;
        } else {
          current += command[i]!;
          i++;
        }
      }
      if (i < len) { current += '"'; i++; }
      continue;
    }

    // $(...) — skip as a unit
    if (ch === '$' && i + 1 < len && command[i + 1] === '(') {
      current += '$(';
      i += 2;
      let depth = 1;
      while (i < len && depth > 0) {
        if (command[i] === '(') depth++;
        else if (command[i] === ')') depth--;
        if (depth > 0) current += command[i]!;
        else current += ')';
        i++;
      }
      continue;
    }

    // backtick
    if (ch === '`') {
      current += ch;
      i++;
      while (i < len && command[i] !== '`') {
        current += command[i]!;
        i++;
      }
      if (i < len) { current += '`'; i++; }
      continue;
    }

    // && separator
    if (ch === '&' && i + 1 < len && command[i + 1] === '&') {
      segments.push(current);
      current = '';
      i += 2;
      continue;
    }

    // || separator
    if (ch === '|' && i + 1 < len && command[i + 1] === '|') {
      segments.push(current);
      current = '';
      i += 2;
      continue;
    }

    // | separator
    if (ch === '|') {
      segments.push(current);
      current = '';
      i++;
      continue;
    }

    // ; separator
    if (ch === ';') {
      segments.push(current);
      current = '';
      i++;
      continue;
    }

    // background & (single, not &&)
    if (ch === '&') {
      segments.push(current);
      current = '';
      i++;
      continue;
    }

    current += ch;
    i++;
  }

  if (current.trim().length > 0) {
    segments.push(current);
  }

  return segments;
}

/**
 * Tokenize a command into SimpleCommands with fail-closed semantics.
 * Returns 'too-complex' for any construct we can't safely analyze.
 */
export function parseForSecurity(command: string): ParseForSecurityResult {
  // Pre-checks for parser differential risks
  const preCheckResult = preCheck(command);
  if (preCheckResult) {
    return { kind: 'too-complex', reason: preCheckResult };
  }

  // Check for dangerous patterns that our tokenizer can't safely handle
  if (/\$\(\(/.test(command)) {
    return { kind: 'too-complex', reason: 'arithmetic expansion $(())', nodeType: 'arithmetic_expansion' };
  }
  if (/\{[^}]*,[^}]*\}/.test(command) && !/['"].*\{.*\}.*['"]/.test(command)) {
    return { kind: 'too-complex', reason: 'brace expansion', nodeType: 'brace_expansion' };
  }
  if (/<\(|>\(/.test(command)) {
    return { kind: 'too-complex', reason: 'process substitution', nodeType: 'process_substitution' };
  }

  try {
    const segmentTexts = splitSegments(command);
    const commands: SimpleCommand[] = [];

    for (const segText of segmentTexts) {
      const rawTokens = tokenizeSegment(segText.trim());
      if (rawTokens.length === 0) continue;

      const envVars: Array<{ name: string; value: string }> = [];
      const argv: string[] = [];
      const redirects: Array<{ op: string; target: string; fd?: number }> = [];
      let i = 0;

      // Extract leading env vars (VAR=val before the command)
      while (
        i < rawTokens.length &&
        rawTokens[i]!.kind === 'word' &&
        /^[A-Za-z_]\w*=/.test(rawTokens[i]!.value)
      ) {
        const tok = rawTokens[i]!.value;
        const eqIdx = tok.indexOf('=');
        envVars.push({
          name: tok.slice(0, eqIdx),
          value: tok.slice(eqIdx + 1),
        });
        i++;
      }

      // Extract command args and redirects
      while (i < rawTokens.length) {
        const tok = rawTokens[i]!;

        if (tok.kind === 'redirect-op') {
          // Next word token is the redirect target
          const op = tok.value;
          // Check for fd prefix (e.g., "2>" -> fd=2, op=">")
          const fdMatch = op.match(/^(\d+)(.*)/);
          let fd: number | undefined;
          let cleanOp = op;
          if (fdMatch && fdMatch[2]!.length > 0) {
            fd = parseInt(fdMatch[1]!, 10);
            cleanOp = fdMatch[2]!;
          }

          i++;
          if (i < rawTokens.length && rawTokens[i]!.kind === 'word') {
            redirects.push({
              op: cleanOp,
              target: rawTokens[i]!.value,
              ...(fd !== undefined ? { fd } : {}),
            });
            i++;
          }
          continue;
        }

        argv.push(tok.value);
        i++;
      }

      if (argv.length > 0 || envVars.length > 0) {
        // Reconstruct text from the raw tokens
        const text = rawTokens.map(t => t.value).join(' ');
        commands.push({ argv, envVars, redirects, text });
      }
    }

    return { kind: 'simple', commands };
  } catch (err: any) {
    return { kind: 'parse-error', error: err.message ?? String(err) };
  }
}

/**
 * Check if a command is safe for automatic execution (all commands are in the safe list).
 */
export function isCommandSafeForAutoExec(
  result: ParseForSecurityResult,
  safeCommands: Set<string>,
): boolean {
  if (result.kind !== 'simple') return false;
  return result.commands.every(cmd => {
    const name = cmd.argv[0];
    if (!name) return false;
    return safeCommands.has(name);
  });
}

/**
 * Extract all command names from a security parse result.
 */
export function extractCommandNames(result: ParseForSecurityResult): string[] {
  if (result.kind !== 'simple') return [];
  return result.commands.map(cmd => cmd.argv[0] ?? '').filter(Boolean);
}

/**
 * Check if the parse result contains any redirects to sensitive paths.
 */
export function hasSensitiveRedirects(result: ParseForSecurityResult): boolean {
  if (result.kind !== 'simple') return true; // fail-closed
  const sensitive = ['/etc/', '/dev/', '/proc/', '/sys/', '~/.ssh/', '~/.gnupg/'];
  return result.commands.some(cmd =>
    cmd.redirects.some(r => sensitive.some(s => r.target.startsWith(s))),
  );
}
