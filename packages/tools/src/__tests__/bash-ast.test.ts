import { describe, expect, test } from 'bun:test';
import { parseForSecurity, isCommandSafeForAutoExec, extractCommandNames, hasSensitiveRedirects } from '../bash-ast';

describe('parseForSecurity', () => {
  test('simple command', () => {
    const result = parseForSecurity('ls -la');
    expect(result.kind).toBe('simple');
    if (result.kind === 'simple') {
      expect(result.commands[0]!.argv).toEqual(['ls', '-la']);
    }
  });

  test('piped commands', () => {
    const result = parseForSecurity('cat file.txt | grep pattern');
    expect(result.kind).toBe('simple');
    if (result.kind === 'simple') {
      expect(result.commands).toHaveLength(2);
    }
  });

  test('env var assignment', () => {
    const result = parseForSecurity('FOO=bar echo hello');
    expect(result.kind).toBe('simple');
    if (result.kind === 'simple') {
      expect(result.commands[0]!.envVars).toHaveLength(1);
      expect(result.commands[0]!.envVars[0]!.name).toBe('FOO');
    }
  });

  test('rejects control characters', () => {
    const result = parseForSecurity('echo \x00hello');
    expect(result.kind).toBe('too-complex');
  });

  test('rejects arithmetic expansion', () => {
    const result = parseForSecurity('echo $(( 1 + 1 ))');
    expect(result.kind).toBe('too-complex');
    if (result.kind === 'too-complex') expect(result.reason).toContain('arithmetic');
  });

  test('rejects process substitution', () => {
    const result = parseForSecurity('diff <(cmd1) <(cmd2)');
    expect(result.kind).toBe('too-complex');
  });

  test('rejects brace expansion', () => {
    const result = parseForSecurity('echo {a,b,c}');
    expect(result.kind).toBe('too-complex');
  });

  test('allows brace expansion inside quotes', () => {
    const result = parseForSecurity('echo "{a,b,c}"');
    expect(result.kind).toBe('simple');
  });

  test('detects redirects', () => {
    const result = parseForSecurity('echo hello > output.txt');
    expect(result.kind).toBe('simple');
    if (result.kind === 'simple') {
      expect(result.commands[0]!.redirects).toHaveLength(1);
      expect(result.commands[0]!.redirects[0]!.target).toBe('output.txt');
    }
  });

  test('chained commands', () => {
    const result = parseForSecurity('git add . && git commit -m "test"');
    expect(result.kind).toBe('simple');
    if (result.kind === 'simple') {
      expect(result.commands).toHaveLength(2);
    }
  });
});

describe('isCommandSafeForAutoExec', () => {
  const safe = new Set(['ls', 'cat', 'echo', 'git']);

  test('all safe commands', () => {
    const result = parseForSecurity('ls -la');
    expect(isCommandSafeForAutoExec(result, safe)).toBe(true);
  });

  test('unsafe command', () => {
    const result = parseForSecurity('rm -rf /');
    expect(isCommandSafeForAutoExec(result, safe)).toBe(false);
  });

  test('too-complex is not safe', () => {
    const result = parseForSecurity('echo $(( 1 + 1 ))');
    expect(isCommandSafeForAutoExec(result, safe)).toBe(false);
  });
});

describe('extractCommandNames', () => {
  test('extracts from simple', () => {
    const result = parseForSecurity('git status && npm test');
    expect(extractCommandNames(result)).toEqual(['git', 'npm']);
  });
});

describe('hasSensitiveRedirects', () => {
  test('sensitive path detected', () => {
    const result = parseForSecurity('echo secret > /etc/passwd');
    expect(hasSensitiveRedirects(result)).toBe(true);
  });

  test('normal path is ok', () => {
    const result = parseForSecurity('echo hello > output.txt');
    expect(hasSensitiveRedirects(result)).toBe(false);
  });
});
