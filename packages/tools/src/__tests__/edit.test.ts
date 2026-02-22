import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createEditTool } from '../edit.js';

const ctx = { cwd: '/tmp', sessionId: 'test-session' };

describe('Edit tool', () => {
  let tmpDir: string;
  let tool: ReturnType<typeof createEditTool>;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'open-agent-edit-test-'));
    tool = createEditTool();
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // Helper: create a temp file with given content and return its path.
  function makeFile(name: string, content: string): string {
    const filePath = join(tmpDir, name);
    writeFileSync(filePath, content);
    return filePath;
  }

  it('basic string replacement updates file content', async () => {
    const filePath = makeFile('basic.txt', 'Hello world');

    await tool.execute(
      { file_path: filePath, old_string: 'world', new_string: 'Bun' },
      ctx,
    );

    expect(readFileSync(filePath, 'utf-8')).toBe('Hello Bun');
  });

  it('returns metadata including replacement count and old/new strings', async () => {
    const filePath = makeFile('meta.txt', 'foo bar foo');
    // We will use replace_all here, so count should be 2.
    const result = await tool.execute(
      { file_path: filePath, old_string: 'foo', new_string: 'baz', replace_all: true },
      ctx,
    );

    expect(result.replacements).toBe(2);
    expect(result.filePath).toBe(filePath);
    expect(result.patch).toBeDefined();
  });

  it('throws when old_string is not found in the file', async () => {
    const filePath = makeFile('not-found.txt', 'Hello world');

    expect(
      tool.execute(
        { file_path: filePath, old_string: 'does not exist', new_string: 'x' },
        ctx,
      ),
    ).rejects.toThrow('old_string not found');
  });

  it('throws when old_string appears multiple times and replace_all is false', async () => {
    const filePath = makeFile('duplicate.txt', 'cat cat cat');

    expect(
      tool.execute(
        { file_path: filePath, old_string: 'cat', new_string: 'dog' },
        ctx,
      ),
    ).rejects.toThrow(/found \d+ times/);
  });

  it('replace_all: true replaces every occurrence', async () => {
    const filePath = makeFile('replace-all.txt', 'a b a b a');

    await tool.execute(
      { file_path: filePath, old_string: 'a', new_string: 'z', replace_all: true },
      ctx,
    );

    expect(readFileSync(filePath, 'utf-8')).toBe('z b z b z');
  });

  it('replace_all: false only replaces the first (and only) occurrence', async () => {
    const filePath = makeFile('single-replace.txt', 'once is enough');

    await tool.execute(
      { file_path: filePath, old_string: 'once', new_string: 'one time', replace_all: false },
      ctx,
    );

    expect(readFileSync(filePath, 'utf-8')).toBe('one time is enough');
  });

  it('throws when the file does not exist', async () => {
    expect(
      tool.execute(
        { file_path: join(tmpDir, 'ghost-file.txt'), old_string: 'x', new_string: 'y' },
        ctx,
      ),
    ).rejects.toThrow('File not found');
  });

  it('preserves multi-line content when replacing', async () => {
    const original = 'line 1\nline 2\nline 3\n';
    const filePath = makeFile('multiline.txt', original);

    await tool.execute(
      { file_path: filePath, old_string: 'line 2', new_string: 'LINE TWO' },
      ctx,
    );

    expect(readFileSync(filePath, 'utf-8')).toBe('line 1\nLINE TWO\nline 3\n');
  });

  it('can replace with empty string (deletion)', async () => {
    const filePath = makeFile('delete.txt', 'keepXdelete');

    await tool.execute(
      { file_path: filePath, old_string: 'Xdelete', new_string: '' },
      ctx,
    );

    expect(readFileSync(filePath, 'utf-8')).toBe('keep');
  });
});
