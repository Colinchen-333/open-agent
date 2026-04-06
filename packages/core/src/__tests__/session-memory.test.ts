import { describe, expect, test } from 'bun:test';
import { SessionMemory } from '../session-memory';

describe('SessionMemory', () => {
  test('set and get', () => {
    const mem = new SessionMemory();
    mem.set('user_name', 'Alice', { source: 'user', category: 'fact' });
    const entry = mem.get('user_name');
    expect(entry?.value).toBe('Alice');
    expect(entry?.source).toBe('user');
  });

  test('update preserves createdAt', () => {
    const mem = new SessionMemory();
    mem.set('x', 'old');
    const created = mem.get('x')!.createdAt;
    mem.set('x', 'new');
    expect(mem.get('x')!.createdAt).toBe(created);
    expect(mem.get('x')!.value).toBe('new');
  });

  test('delete removes entry', () => {
    const mem = new SessionMemory();
    mem.set('k', 'v');
    expect(mem.delete('k')).toBe(true);
    expect(mem.get('k')).toBeNull();
  });

  test('getAll with category filter', () => {
    const mem = new SessionMemory();
    mem.set('a', '1', { category: 'fact' });
    mem.set('b', '2', { category: 'preference' });
    mem.set('c', '3', { category: 'fact' });
    expect(mem.getAll('fact')).toHaveLength(2);
    expect(mem.getAll('preference')).toHaveLength(1);
  });

  test('search by keyword', () => {
    const mem = new SessionMemory();
    mem.set('language', 'TypeScript');
    mem.set('framework', 'React');
    expect(mem.search('type')).toHaveLength(1);
    expect(mem.search('react')).toHaveLength(1);
  });

  test('toPromptContext', () => {
    const mem = new SessionMemory();
    mem.set('role', 'developer');
    const ctx = mem.toPromptContext();
    expect(ctx).toContain('role: developer');
    expect(ctx).toContain('Session context');
  });

  test('empty memory returns empty prompt context', () => {
    const mem = new SessionMemory();
    expect(mem.toPromptContext()).toBe('');
  });

  test('serialize and deserialize roundtrip', () => {
    const mem = new SessionMemory();
    mem.set('k1', 'v1');
    mem.set('k2', 'v2');
    const json = mem.serialize();
    const restored = SessionMemory.deserialize(json);
    expect(restored.size).toBe(2);
    expect(restored.get('k1')?.value).toBe('v1');
  });

  test('evicts oldest when over maxEntries', () => {
    const mem = new SessionMemory({ maxEntries: 2 });
    mem.set('a', '1');
    mem.set('b', '2');
    mem.set('c', '3'); // should evict 'a'
    expect(mem.size).toBe(2);
    expect(mem.get('a')).toBeNull();
    expect(mem.get('c')?.value).toBe('3');
  });

  test('clear removes all', () => {
    const mem = new SessionMemory();
    mem.set('a', '1');
    mem.set('b', '2');
    mem.clear();
    expect(mem.size).toBe(0);
  });
});
