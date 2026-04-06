import { describe, expect, it } from 'bun:test';
import { classifyBashCommand, extractBashSubcommands } from '../bash-subcommands.js';

// ---------------------------------------------------------------------------
// extractBashSubcommands
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
});

// ---------------------------------------------------------------------------
// classifyBashCommand
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
});
