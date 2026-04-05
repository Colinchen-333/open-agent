import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMemoryPrompt } from '../config-loader';

describe('CLAUDE.md precedence', () => {
  let root: string;
  let home: string;
  beforeEach(() => {
    root = mkdtempSync(`${tmpdir()}/oa-mem-`);
    home = mkdtempSync(`${tmpdir()}/oa-home-`);
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  test('prefers $PWD/.claude/CLAUDE.md over $PWD/CLAUDE.md', async () => {
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(join(root, '.claude', 'CLAUDE.md'), 'A');
    writeFileSync(join(root, 'CLAUDE.md'), 'B');
    const result = await loadMemoryPrompt(root, home);
    expect(result).toContain('A');
    expect(result).not.toContain('B');
  });

  test('falls back to $PWD/CLAUDE.md when .claude/ missing', async () => {
    writeFileSync(join(root, 'CLAUDE.md'), 'B');
    const result = await loadMemoryPrompt(root, home);
    expect(result).toContain('B');
  });

  test('falls back to ~/.claude/CLAUDE.md when no project memory', async () => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', 'CLAUDE.md'), 'G');
    const result = await loadMemoryPrompt(root, home);
    expect(result).toContain('G');
  });

  test('returns empty string when no memory file exists', async () => {
    expect(await loadMemoryPrompt(root, home)).toBe('');
  });
});
