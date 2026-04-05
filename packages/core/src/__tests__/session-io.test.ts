import { describe, expect, test } from 'bun:test';
import { projectHash, resolveSessionPath } from '../session-io';

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
