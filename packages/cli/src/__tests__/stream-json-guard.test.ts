import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import {
  installStreamJsonStdoutGuard,
  _resetStreamJsonStdoutGuardForTesting,
  STDOUT_GUARD_MARKER,
} from '../stream-json-guard';
import { ndjsonSafeStringify } from '../ndjson';

describe('ndjsonSafeStringify', () => {
  test('basic object serialization', () => {
    expect(ndjsonSafeStringify({ a: 1 })).toBe('{"a":1}');
  });

  test('escapes U+2028 line separator', () => {
    const result = ndjsonSafeStringify({ text: 'hello\u2028world' });
    expect(result).not.toContain('\u2028');
    expect(result).toContain('\\u2028');
    expect(JSON.parse(result).text).toBe('hello\u2028world');
  });

  test('escapes U+2029 paragraph separator', () => {
    const result = ndjsonSafeStringify({ text: 'a\u2029b' });
    expect(result).not.toContain('\u2029');
    expect(result).toContain('\\u2029');
  });
});

describe('streamJsonStdoutGuard', () => {
  let capturedStdout: string[];
  let capturedStderr: string[];
  let originalStdoutWrite: typeof process.stdout.write;
  let originalStderrWrite: typeof process.stderr.write;

  beforeEach(() => {
    capturedStdout = [];
    capturedStderr = [];
    originalStdoutWrite = process.stdout.write;
    originalStderrWrite = process.stderr.write;

    // Capture what the guard forwards
    process.stdout.write = ((chunk: any) => {
      capturedStdout.push(String(chunk));
      return true;
    }) as any;

    // Install guard on top of our capture
    installStreamJsonStdoutGuard();

    // Capture stderr for diverted lines
    process.stderr.write = ((chunk: any) => {
      capturedStderr.push(String(chunk));
      return true;
    }) as any;
  });

  afterEach(() => {
    _resetStreamJsonStdoutGuardForTesting();
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  });

  test('forwards valid JSON lines to stdout', () => {
    process.stdout.write('{"type":"message"}\n');
    expect(capturedStdout).toContain('{"type":"message"}\n');
  });

  test('diverts non-JSON lines to stderr with marker', () => {
    process.stdout.write('hello world\n');
    expect(capturedStderr.some((s) => s.includes(STDOUT_GUARD_MARKER))).toBe(true);
    expect(capturedStdout.some((s) => s.includes('hello world'))).toBe(false);
  });

  test('buffers partial writes until newline', () => {
    process.stdout.write('{"part');
    expect(capturedStdout).toHaveLength(0);
    process.stdout.write('ial":true}\n');
    expect(capturedStdout.join('')).toContain('{"partial":true}\n');
  });

  test('empty lines pass through (valid NDJSON)', () => {
    process.stdout.write('\n');
    expect(capturedStdout).toContain('\n');
  });

  test('installing twice is idempotent', () => {
    installStreamJsonStdoutGuard(); // second install
    process.stdout.write('{"ok":1}\n');
    // Should get exactly one copy, not double-wrapped
    const jsonLines = capturedStdout.filter((s) => s.includes('"ok"'));
    expect(jsonLines).toHaveLength(1);
  });
});
