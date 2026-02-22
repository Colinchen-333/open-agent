import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createWriteTool } from '../write.js';

const ctx = { cwd: '/tmp', sessionId: 'test-write' };

describe('Write tool', () => {
  let tmpDir: string;
  let tool: ReturnType<typeof createWriteTool>;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'open-agent-write-test-'));
    tool = createWriteTool();
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // Creating a new file
  // ---------------------------------------------------------------------------

  it('creates a new file with the given content', async () => {
    const filePath = join(tmpDir, 'new-file.txt');

    const result = await tool.execute({ file_path: filePath, content: 'Hello, world!' }, ctx) as any;

    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, 'utf-8')).toBe('Hello, world!');
    expect(result.type).toBe('create');
    expect(result.filePath).toBe(filePath);
    expect(result.originalFile).toBeNull();
  });

  it('returns the written content in the result', async () => {
    const filePath = join(tmpDir, 'content-check.txt');
    const content = 'Some specific content here';

    const result = await tool.execute({ file_path: filePath, content }, ctx) as any;

    expect(result.content).toBe(content);
  });

  // ---------------------------------------------------------------------------
  // Overwriting an existing file
  // ---------------------------------------------------------------------------

  it('overwrites an existing file with new content', async () => {
    const filePath = join(tmpDir, 'overwrite.txt');

    // Create the file first
    await tool.execute({ file_path: filePath, content: 'Original content' }, ctx);

    // Now overwrite it
    const result = await tool.execute(
      { file_path: filePath, content: 'Updated content' },
      ctx,
    ) as any;

    expect(readFileSync(filePath, 'utf-8')).toBe('Updated content');
    expect(result.type).toBe('update');
    expect(result.originalFile).toBe('Original content');
  });

  it('preserves original file content in originalFile field on overwrite', async () => {
    const filePath = join(tmpDir, 'original-preserved.txt');
    const originalContent = 'First version of the file\nWith two lines';

    await tool.execute({ file_path: filePath, content: originalContent }, ctx);
    const result = await tool.execute(
      { file_path: filePath, content: 'Second version' },
      ctx,
    ) as any;

    expect(result.originalFile).toBe(originalContent);
  });

  // ---------------------------------------------------------------------------
  // Creating file in nested directory (auto-mkdir)
  // ---------------------------------------------------------------------------

  it('creates intermediate directories automatically', async () => {
    const filePath = join(tmpDir, 'nested', 'deeply', 'nested', 'file.txt');

    const result = await tool.execute({ file_path: filePath, content: 'Nested file' }, ctx) as any;

    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, 'utf-8')).toBe('Nested file');
    expect(result.type).toBe('create');
  });

  it('creates two sibling files in the same auto-created directory', async () => {
    const dir = join(tmpDir, 'auto-dir');
    const fileA = join(dir, 'a.txt');
    const fileB = join(dir, 'b.txt');

    await tool.execute({ file_path: fileA, content: 'A' }, ctx);
    await tool.execute({ file_path: fileB, content: 'B' }, ctx);

    expect(readFileSync(fileA, 'utf-8')).toBe('A');
    expect(readFileSync(fileB, 'utf-8')).toBe('B');
  });

  // ---------------------------------------------------------------------------
  // Writing empty content
  // ---------------------------------------------------------------------------

  it('creates a file with empty content', async () => {
    const filePath = join(tmpDir, 'empty-file.txt');

    const result = await tool.execute({ file_path: filePath, content: '' }, ctx) as any;

    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, 'utf-8')).toBe('');
    expect(result.type).toBe('create');
    expect(result.content).toBe('');
  });

  it('overwrites a file with empty content', async () => {
    const filePath = join(tmpDir, 'to-empty.txt');

    await tool.execute({ file_path: filePath, content: 'Some content' }, ctx);
    const result = await tool.execute({ file_path: filePath, content: '' }, ctx) as any;

    expect(readFileSync(filePath, 'utf-8')).toBe('');
    expect(result.type).toBe('update');
    expect(result.originalFile).toBe('Some content');
  });

  // ---------------------------------------------------------------------------
  // Multi-line and binary-safe content
  // ---------------------------------------------------------------------------

  it('writes multi-line content correctly', async () => {
    const content = 'line 1\nline 2\nline 3\n';
    const filePath = join(tmpDir, 'multiline.txt');

    await tool.execute({ file_path: filePath, content }, ctx);

    expect(readFileSync(filePath, 'utf-8')).toBe(content);
  });

  it('result always includes a structuredPatch array', async () => {
    const filePath = join(tmpDir, 'patch-check.txt');

    const result = await tool.execute({ file_path: filePath, content: 'data' }, ctx) as any;

    expect(Array.isArray(result.structuredPatch)).toBe(true);
  });
});
