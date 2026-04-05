import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { projectHash, resolveSessionPath, SessionJsonlWriter } from '../session-io';

describe('session-io path resolution', () => {
  test('projectHash is deterministic sha256 of cwd', () => {
    const h1 = projectHash('/Users/alice/proj');
    const h2 = projectHash('/Users/alice/proj');
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[a-f0-9]{64}$/);
  });

  test('different cwds produce different hashes', () => {
    expect(projectHash('/a')).not.toBe(projectHash('/b'));
  });

  test('resolveSessionPath yields projects/<hash>/sessions/<id>.jsonl', () => {
    const p = resolveSessionPath('/tmp/root', '/Users/alice/proj', 'sess-123');
    expect(p).toMatch(/\/tmp\/root\/projects\/[a-f0-9]{64}\/sessions\/sess-123\.jsonl$/);
  });
});

describe('SessionJsonlWriter', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(`${tmpdir()}/oa-session-`);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('append creates file and writes one line per record', async () => {
    const path = `${dir}/sess.jsonl`;
    const w = new SessionJsonlWriter(path);
    await w.append({ type: 'user', text: 'hi' });
    await w.append({ type: 'assistant', text: 'hello' });
    await w.close();
    const content = readFileSync(path, 'utf8');
    const lines = content.trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual({ type: 'user', text: 'hi' });
    expect(JSON.parse(lines[1]!)).toEqual({ type: 'assistant', text: 'hello' });
  });

  test('append creates parent directories on demand', async () => {
    const path = `${dir}/nested/deep/sess.jsonl`;
    const w = new SessionJsonlWriter(path);
    await w.append({ type: 'user', text: 'x' });
    await w.close();
    expect(existsSync(path)).toBe(true);
  });
});
