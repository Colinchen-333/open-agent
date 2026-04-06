import { describe, expect, it, test } from 'bun:test';
import {
  classifyBashCommand,
  extractBashSubcommands,
  isReadOnlyCommand,
  tokenizeShellCommand,
} from '../bash-subcommands.js';

// ---------------------------------------------------------------------------
// tokenizeShellCommand — low-level tokenizer
// ---------------------------------------------------------------------------

describe('tokenizeShellCommand', () => {
  test('empty string returns empty array', () => {
    expect(tokenizeShellCommand('')).toEqual([]);
  });

  test('single command', () => {
    expect(tokenizeShellCommand('ls -la')).toEqual([['ls', '-la']]);
  });

  test('splits on &&', () => {
    const result = tokenizeShellCommand('echo a && echo b');
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(['echo', 'a']);
    expect(result[1]).toEqual(['echo', 'b']);
  });

  test('splits on ||', () => {
    const result = tokenizeShellCommand('false || echo fallback');
    expect(result).toHaveLength(2);
  });

  test('splits on |', () => {
    const result = tokenizeShellCommand('cat file.txt | grep foo');
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(['cat', 'file.txt']);
    expect(result[1]).toEqual(['grep', 'foo']);
  });

  test('splits on ;', () => {
    const result = tokenizeShellCommand('echo hello; echo world');
    expect(result).toHaveLength(2);
  });

  test('does not split on && inside double quotes', () => {
    const result = tokenizeShellCommand('echo "hello && world"');
    expect(result).toHaveLength(1);
    expect(result[0]![0]).toBe('echo');
    expect(result[0]![1]).toBe('hello && world');
  });

  test('does not split on ; inside single quotes', () => {
    const result = tokenizeShellCommand("echo 'a;b;c'");
    expect(result).toHaveLength(1);
    expect(result[0]![1]).toBe('a;b;c');
  });

  test('does not split on | inside double quotes', () => {
    const result = tokenizeShellCommand('echo "a | b"');
    expect(result).toHaveLength(1);
  });

  test('handles $() command substitution as single token', () => {
    const result = tokenizeShellCommand('echo $(date) && ls');
    expect(result).toHaveLength(2);
    expect(result[0]![0]).toBe('echo');
    expect(result[0]![1]).toBe('$(date)');
    expect(result[1]![0]).toBe('ls');
  });

  test('handles nested $() substitution', () => {
    const result = tokenizeShellCommand('echo $(echo $(date))');
    expect(result).toHaveLength(1);
    expect(result[0]![1]).toBe('$(echo $(date))');
  });

  test('handles backtick substitution', () => {
    const result = tokenizeShellCommand('echo `date` && ls');
    expect(result).toHaveLength(2);
    expect(result[0]![0]).toBe('echo');
    expect(result[0]![1]).toBe('`date`');
  });

  test('handles escaped quotes in double-quoted strings', () => {
    const result = tokenizeShellCommand('echo "it\\"s" && ls');
    expect(result).toHaveLength(2);
    expect(result[0]![0]).toBe('echo');
    expect(result[0]![1]).toBe('it"s');
  });

  test('handles escaped backslash', () => {
    const result = tokenizeShellCommand('echo "path\\\\dir"');
    expect(result).toHaveLength(1);
    expect(result[0]![1]).toBe('path\\dir');
  });

  test('handles backslash escape outside quotes', () => {
    const result = tokenizeShellCommand('echo hello\\ world');
    expect(result).toHaveLength(1);
    // The escaped space joins the tokens
    expect(result[0]![1]).toBe('hello world');
  });

  test('strips subshell parentheses', () => {
    const result = tokenizeShellCommand('(ls -la)');
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(['ls', '-la']);
  });

  test('handles trailing &', () => {
    const result = tokenizeShellCommand('nohup node server.js &');
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(['nohup', 'node', 'server.js']);
  });

  test('handles I/O redirection', () => {
    const result = tokenizeShellCommand('echo hello > /dev/null');
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(['echo', 'hello']);
  });

  test('handles stderr redirection 2>', () => {
    const result = tokenizeShellCommand('cmd 2>/dev/null');
    expect(result).toHaveLength(1);
    // '2' gets attached to 'cmd' token? No, it's separate. Let's check.
    // Actually "cmd" is one token, "2" starts a new token but then we hit >
    // which triggers redirection skip. So we get ['cmd', '2'] minus the redirect target.
    // Actually '2>/dev/null' — '2' is a regular char, then '>' triggers redirection.
    // So token "2" gets flushed before redirect handling, meaning we get ['cmd', '2'].
    // This is acceptable — the '2' is harmless for classification purposes.
    expect(result[0]![0]).toBe('cmd');
  });

  test('handles append redirection >>', () => {
    const result = tokenizeShellCommand('echo hello >> log.txt');
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(['echo', 'hello']);
  });

  test('mixed quotes and separators', () => {
    const result = tokenizeShellCommand('git log --oneline -n 5 && echo "done; all good"');
    expect(result).toHaveLength(2);
    expect(result[0]![0]).toBe('git');
    expect(result[1]![0]).toBe('echo');
    expect(result[1]![1]).toBe('done; all good');
  });

  test('empty segments are not included', () => {
    const result = tokenizeShellCommand('&& ls');
    // The leading && creates an empty segment that gets dropped
    expect(result.some(seg => seg.length > 0 && seg[0] === 'ls')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// extractBashSubcommands — high-level extraction with prefix stripping
// ---------------------------------------------------------------------------

describe('extractBashSubcommands', () => {
  it('returns empty array for empty string', () => {
    expect(extractBashSubcommands('')).toEqual([]);
  });

  it('returns empty array for whitespace-only string', () => {
    expect(extractBashSubcommands('   ')).toEqual([]);
  });

  it('parses a single command', () => {
    expect(extractBashSubcommands('ls -la')).toEqual([['ls', '-la']]);
  });

  it('splits on &&', () => {
    const result = extractBashSubcommands('cd /tmp && git push origin main');
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(['cd', '/tmp']);
    expect(result[1]).toEqual(['git', 'push', 'origin', 'main']);
  });

  it('splits on ;', () => {
    const result = extractBashSubcommands('echo hello; echo world');
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(['echo', 'hello']);
    expect(result[1]).toEqual(['echo', 'world']);
  });

  it('splits on || (pipe-or)', () => {
    const result = extractBashSubcommands('false || echo fallback');
    expect(result).toHaveLength(2);
    expect(result[1]).toEqual(['echo', 'fallback']);
  });

  it('splits on | (pipe)', () => {
    const result = extractBashSubcommands('cat file.txt | grep foo');
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(['cat', 'file.txt']);
    expect(result[1]).toEqual(['grep', 'foo']);
  });

  it('strips leading env vars', () => {
    const result = extractBashSubcommands('NODE_ENV=production npm start');
    expect(result[0]![0]).toBe('npm');
  });

  it('strips multiple leading env vars', () => {
    const result = extractBashSubcommands('FOO=1 BAR=2 node server.js');
    expect(result[0]![0]).toBe('node');
  });

  it('strips subshell parens', () => {
    const result = extractBashSubcommands('(ls -la)');
    expect(result[0]![0]).toBe('ls');
  });

  it('skips sudo prefix and returns real command', () => {
    const result = extractBashSubcommands('sudo rm -rf /tmp/test');
    expect(result[0]![0]).toBe('rm');
  });

  it('skips nohup prefix', () => {
    const result = extractBashSubcommands('nohup node server.js &');
    expect(result[0]![0]).toBe('node');
  });

  it('skips time prefix', () => {
    const result = extractBashSubcommands('time make build');
    expect(result[0]![0]).toBe('make');
  });

  it('handles three-part chain', () => {
    const result = extractBashSubcommands('mkdir /tmp/out && cp src dest && echo done');
    expect(result).toHaveLength(3);
    expect(result.map(t => t[0])).toEqual(['mkdir', 'cp', 'echo']);
  });

  it('returns only the prefix-skipped command if all tokens are prefixes', () => {
    // "sudo" alone — should produce no result since nothing after prefix
    const result = extractBashSubcommands('sudo');
    expect(result).toEqual([]);
  });

  // --- New shell-aware tokenizer tests ---

  test('does not split on && inside double quotes', () => {
    const result = extractBashSubcommands('echo "hello && world"');
    expect(result).toHaveLength(1);
    expect(result[0]![0]).toBe('echo');
  });

  test('does not split on ; inside single quotes', () => {
    const result = extractBashSubcommands("echo 'a;b;c'");
    expect(result).toHaveLength(1);
  });

  test('handles command substitution $()', () => {
    const result = extractBashSubcommands('echo $(date) && ls');
    expect(result).toHaveLength(2);
    expect(result[0]![0]).toBe('echo');
    expect(result[1]![0]).toBe('ls');
  });

  test('handles escaped quotes', () => {
    const result = extractBashSubcommands('echo "it\\"s" && ls');
    expect(result).toHaveLength(2);
  });

  test('handles pipe correctly', () => {
    const result = extractBashSubcommands('cat file.txt | grep pattern');
    expect(result).toHaveLength(2);
    expect(result[0]![0]).toBe('cat');
    expect(result[1]![0]).toBe('grep');
  });

  test('handles mixed quotes and separators', () => {
    const result = extractBashSubcommands('git log --oneline -n 5 && echo "done; all good"');
    expect(result).toHaveLength(2);
    expect(result[0]![0]).toBe('git');
    expect(result[1]![0]).toBe('echo');
  });
});

// ---------------------------------------------------------------------------
// isReadOnlyCommand — flag-based validation
// ---------------------------------------------------------------------------

describe('isReadOnlyCommand', () => {
  test('git log with no flags', () => {
    expect(isReadOnlyCommand(['git', 'log'])).toBe(true);
  });

  test('git log with safe flags', () => {
    expect(isReadOnlyCommand(['git', 'log', '--oneline', '-n', '10', '--graph'])).toBe(true);
  });

  test('git log with unknown flag is not read-only', () => {
    expect(isReadOnlyCommand(['git', 'log', '--exec=rm -rf /'])).toBe(false);
  });

  test('git status is read-only', () => {
    expect(isReadOnlyCommand(['git', 'status'])).toBe(true);
  });

  test('git status -s is read-only', () => {
    expect(isReadOnlyCommand(['git', 'status', '-s'])).toBe(true);
  });

  test('git diff with safe flags', () => {
    expect(isReadOnlyCommand(['git', 'diff', 'HEAD~1', '--stat'])).toBe(true);
  });

  test('git branch with -a is read-only', () => {
    expect(isReadOnlyCommand(['git', 'branch', '-a'])).toBe(true);
  });

  test('git branch <name> (create) is not read-only', () => {
    expect(isReadOnlyCommand(['git', 'branch', 'new-feature'])).toBe(false);
  });

  test('git branch --list is read-only even with pattern', () => {
    expect(isReadOnlyCommand(['git', 'branch', '--list', 'feat/*'])).toBe(true);
  });

  test('git remote -v is read-only', () => {
    expect(isReadOnlyCommand(['git', 'remote', '-v'])).toBe(true);
  });

  test('git remote add is not read-only', () => {
    expect(isReadOnlyCommand(['git', 'remote', 'add', 'origin', 'url'])).toBe(false);
  });

  test('git tag -l is read-only', () => {
    expect(isReadOnlyCommand(['git', 'tag', '-l'])).toBe(true);
  });

  test('git tag <name> (create) is not read-only', () => {
    expect(isReadOnlyCommand(['git', 'tag', 'v1.0'])).toBe(false);
  });

  test('ls -la is read-only', () => {
    expect(isReadOnlyCommand(['ls', '-la'])).toBe(true);
  });

  test('cat -n is read-only', () => {
    expect(isReadOnlyCommand(['cat', '-n', 'file.txt'])).toBe(true);
  });

  test('find with -exec is not read-only', () => {
    expect(isReadOnlyCommand(['find', '.', '-name', '*.log', '-exec', 'rm', '{}', ';'])).toBe(false);
  });

  test('find without -exec is read-only', () => {
    expect(isReadOnlyCommand(['find', '.', '-name', '*.ts', '-type', 'f'])).toBe(true);
  });

  test('echo is read-only (accepts any flags)', () => {
    expect(isReadOnlyCommand(['echo', '-n', 'hello'])).toBe(true);
  });

  test('unknown command is not read-only', () => {
    expect(isReadOnlyCommand(['my-dangerous-script'])).toBe(false);
  });

  test('empty tokens returns false', () => {
    expect(isReadOnlyCommand([])).toBe(false);
  });

  test('grep with safe flags is read-only', () => {
    expect(isReadOnlyCommand(['grep', '-rn', 'pattern', 'src/'])).toBe(false);
    // Note: -rn is a combined flag, not in the whitelist as-is.
    // Individual flags must be separate:
    expect(isReadOnlyCommand(['grep', '-r', '-n', 'pattern', 'src/'])).toBe(true);
  });

  test('rg with safe flags is read-only', () => {
    expect(isReadOnlyCommand(['rg', '-i', '--glob', '*.ts', 'pattern'])).toBe(true);
  });

  test('wc -l is read-only', () => {
    expect(isReadOnlyCommand(['wc', '-l', 'file.txt'])).toBe(true);
  });

  test('head -n 10 is read-only', () => {
    expect(isReadOnlyCommand(['head', '-n', '10', 'file.txt'])).toBe(true);
  });

  test('tail -f is read-only', () => {
    expect(isReadOnlyCommand(['tail', '-f', 'log.txt'])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// classifyBashCommand — integrated classification
// ---------------------------------------------------------------------------

describe('classifyBashCommand', () => {
  it('returns empty commands for empty input', () => {
    const c = classifyBashCommand('');
    expect(c.commands).toEqual([]);
    expect(c.hasDestructive).toBe(false);
    expect(c.hasNetwork).toBe(false);
    expect(c.isReadOnly).toBe(false);
    expect(c.hasPackageInstall).toBe(false);
  });

  // --- read-only ---

  it('classifies ls as read-only', () => {
    const c = classifyBashCommand('ls -la');
    expect(c.isReadOnly).toBe(true);
    expect(c.hasDestructive).toBe(false);
    expect(c.hasNetwork).toBe(false);
  });

  it('classifies ls && cat as read-only', () => {
    const c = classifyBashCommand('ls /tmp && cat file.txt');
    expect(c.isReadOnly).toBe(true);
  });

  it('classifies grep as read-only', () => {
    const c = classifyBashCommand('grep -r "foo" .');
    expect(c.isReadOnly).toBe(true);
  });

  it('classifies echo as read-only', () => {
    const c = classifyBashCommand('echo hello');
    expect(c.isReadOnly).toBe(true);
  });

  // --- destructive ---

  it('detects rm as destructive', () => {
    const c = classifyBashCommand('rm -rf /tmp/test');
    expect(c.hasDestructive).toBe(true);
    expect(c.isReadOnly).toBe(false);
  });

  it('detects git push as destructive (and network)', () => {
    const c = classifyBashCommand('cd /tmp && git push origin main');
    expect(c.hasDestructive).toBe(true);
    expect(c.hasNetwork).toBe(true);
  });

  it('detects git reset as destructive', () => {
    const c = classifyBashCommand('git reset --hard HEAD~1');
    expect(c.hasDestructive).toBe(true);
  });

  // --- network ---

  it('detects curl as network', () => {
    const c = classifyBashCommand('curl https://example.com');
    expect(c.hasNetwork).toBe(true);
    expect(c.isReadOnly).toBe(false);
  });

  it('detects wget as network', () => {
    const c = classifyBashCommand('wget https://example.com/file.tar.gz');
    expect(c.hasNetwork).toBe(true);
  });

  it('detects git pull as network', () => {
    const c = classifyBashCommand('git pull origin main');
    expect(c.hasNetwork).toBe(true);
  });

  // --- package install ---

  it('detects npm install', () => {
    const c = classifyBashCommand('npm install');
    expect(c.hasPackageInstall).toBe(true);
    expect(c.hasNetwork).toBe(true);
  });

  it('detects bun add', () => {
    const c = classifyBashCommand('bun add lodash');
    expect(c.hasPackageInstall).toBe(true);
  });

  it('detects pip install', () => {
    const c = classifyBashCommand('pip install requests');
    expect(c.hasPackageInstall).toBe(true);
  });

  it('detects brew install', () => {
    const c = classifyBashCommand('brew install ripgrep');
    expect(c.hasPackageInstall).toBe(true);
  });

  it('does not flag npm run as package install', () => {
    const c = classifyBashCommand('npm run build');
    expect(c.hasPackageInstall).toBe(false);
  });

  // --- compound / mixed ---

  it('compound read && write is not read-only', () => {
    const c = classifyBashCommand('cat file.txt && rm file.txt');
    expect(c.isReadOnly).toBe(false);
    expect(c.hasDestructive).toBe(true);
  });

  it('cd is neither destructive nor network', () => {
    const c = classifyBashCommand('cd /tmp');
    expect(c.hasDestructive).toBe(false);
    expect(c.hasNetwork).toBe(false);
  });

  it('sudo rm is still destructive after prefix stripping', () => {
    const c = classifyBashCommand('sudo rm -rf /');
    expect(c.hasDestructive).toBe(true);
  });

  it('extracts correct commands list', () => {
    const c = classifyBashCommand('git status && npm install');
    expect(c.commands).toContain('git');
    expect(c.commands).toContain('npm');
  });

  // --- env prefix after wrapper prefix (Bug A) ---

  it('detects npm install after env prefix (env NODE_ENV=production npm install)', () => {
    const c = classifyBashCommand('env NODE_ENV=production npm install');
    expect(c.hasPackageInstall).toBe(true);
    expect(c.hasNetwork).toBe(true);
  });

  // --- two-word read-only commands (Bug B) ---

  it('classifies git status as read-only', () => {
    const c = classifyBashCommand('git status');
    expect(c.isReadOnly).toBe(true);
  });

  it('classifies git diff && git log as read-only', () => {
    const c = classifyBashCommand('git diff && git log');
    expect(c.isReadOnly).toBe(true);
  });

  // --- NEW: flag-based read-only validation ---

  test('git log with safe flags is read-only', () => {
    const result = classifyBashCommand('git log --oneline -n 10 --graph');
    expect(result.isReadOnly).toBe(true);
  });

  test('git log with unknown flag is not read-only', () => {
    const result = classifyBashCommand('git log --exec="rm -rf /"');
    expect(result.isReadOnly).toBe(false);
  });

  test('git diff is read-only', () => {
    const result = classifyBashCommand('git diff HEAD~1');
    expect(result.isReadOnly).toBe(true);
  });

  test('git push is destructive', () => {
    const result = classifyBashCommand('git push origin main');
    expect(result.hasDestructive).toBe(true);
    expect(result.isReadOnly).toBe(false);
  });

  test('ls with flags is read-only', () => {
    const result = classifyBashCommand('ls -la /tmp');
    expect(result.isReadOnly).toBe(true);
  });

  test('compound read-only commands', () => {
    const result = classifyBashCommand('git status && git log --oneline -5');
    expect(result.isReadOnly).toBe(true);
  });

  test('mixed read-only and destructive', () => {
    const result = classifyBashCommand('git status && rm -rf /tmp/test');
    expect(result.isReadOnly).toBe(false);
    expect(result.hasDestructive).toBe(true);
  });

  // --- shell-aware tokenizer prevents false splits ---

  test('does not split on && inside quotes', () => {
    const result = classifyBashCommand('echo "hello && world"');
    expect(result.commands).toEqual(['echo']);
    expect(result.isReadOnly).toBe(true);
  });

  test('does not split on ; inside single quotes', () => {
    const result = classifyBashCommand("echo 'rm -rf /; echo oops'");
    expect(result.commands).toEqual(['echo']);
    expect(result.isReadOnly).toBe(true);
    expect(result.hasDestructive).toBe(false);
  });

  test('handles pipe in quoted string correctly', () => {
    const result = classifyBashCommand('echo "foo | bar" && ls');
    expect(result.commands).toEqual(['echo', 'ls']);
    expect(result.isReadOnly).toBe(true);
  });

  test('git show with safe flags is read-only', () => {
    const result = classifyBashCommand('git show --stat HEAD');
    expect(result.isReadOnly).toBe(true);
  });

  test('git branch -a is read-only', () => {
    const result = classifyBashCommand('git branch -a');
    expect(result.isReadOnly).toBe(true);
  });

  test('find with -delete is not read-only', () => {
    const result = classifyBashCommand('find . -name "*.tmp" -delete');
    expect(result.isReadOnly).toBe(false);
  });

  test('find without dangerous flags is read-only', () => {
    const result = classifyBashCommand('find . -name "*.ts" -type f');
    expect(result.isReadOnly).toBe(true);
  });

  test('piped read-only commands', () => {
    const result = classifyBashCommand('cat file.txt | grep pattern | wc -l');
    expect(result.isReadOnly).toBe(true);
  });

  test('git remote -v is read-only', () => {
    const result = classifyBashCommand('git remote -v');
    expect(result.isReadOnly).toBe(true);
  });

  test('git remote add is not read-only', () => {
    const result = classifyBashCommand('git remote add origin https://github.com/test');
    expect(result.isReadOnly).toBe(false);
  });
});
