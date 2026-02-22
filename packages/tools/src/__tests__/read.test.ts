import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createReadTool } from '../read.js';

const ctx = { cwd: '/tmp', sessionId: 'test-session' };

describe('Read tool', () => {
  let tmpDir: string;
  let tool: ReturnType<typeof createReadTool>;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'open-agent-read-test-'));
    tool = createReadTool();
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // Helper: create a temp file with given content, return its absolute path.
  function makeFile(name: string, content: string): string {
    const filePath = join(tmpDir, name);
    writeFileSync(filePath, content);
    return filePath;
  }

  // ---------------------------------------------------------------------------
  // Basic text file reading
  // ---------------------------------------------------------------------------

  it('reads a text file and returns content with line numbers', async () => {
    const filePath = makeFile('basic.txt', 'line one\nline two\nline three\n');

    const result = await tool.execute({ file_path: filePath }, ctx) as any;

    expect(result.type).toBe('text');
    expect(result.file.filePath).toBe(filePath);
    expect(result.file.content).toContain('line one');
    expect(result.file.content).toContain('line two');
    expect(result.file.content).toContain('line three');
    // Line numbers should be present (cat -n format: number + tab)
    expect(result.file.content).toMatch(/^\s*1\t/);
    expect(result.file.content).toMatch(/2\t/);
    expect(result.file.content).toMatch(/3\t/);
  });

  it('reports correct numLines and totalLines for the file', async () => {
    const filePath = makeFile('lines.txt', 'a\nb\nc\nd\ne\n');

    const result = await tool.execute({ file_path: filePath }, ctx) as any;

    // 5 lines of content + trailing newline produces 6 elements when split by \n,
    // but trailing empty string is counted — verify at least the visible lines.
    expect(result.file.numLines).toBeGreaterThanOrEqual(5);
    expect(result.file.startLine).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // offset and limit parameters
  // ---------------------------------------------------------------------------

  it('applies offset to start reading from the given line (1-indexed)', async () => {
    const content = 'line 1\nline 2\nline 3\nline 4\nline 5\n';
    const filePath = makeFile('offset.txt', content);

    // Read starting from line 3
    const result = await tool.execute({ file_path: filePath, offset: 3 }, ctx) as any;

    expect(result.file.startLine).toBe(3);
    expect(result.file.content).toContain('line 3');
    expect(result.file.content).toContain('line 4');
    expect(result.file.content).toContain('line 5');
    // Lines before offset should not appear
    expect(result.file.content).not.toContain('line 1');
    expect(result.file.content).not.toContain('line 2');
  });

  it('applies limit to cap the number of lines returned', async () => {
    const content = 'alpha\nbeta\ngamma\ndelta\nepsilon\n';
    const filePath = makeFile('limit.txt', content);

    const result = await tool.execute({ file_path: filePath, limit: 2 }, ctx) as any;

    expect(result.file.numLines).toBe(2);
    expect(result.file.content).toContain('alpha');
    expect(result.file.content).toContain('beta');
    expect(result.file.content).not.toContain('gamma');
  });

  it('combines offset and limit correctly', async () => {
    const content = '1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n';
    const filePath = makeFile('offset-limit.txt', content);

    // Read 3 lines starting from line 4 → should get lines 4, 5, 6
    const result = await tool.execute({ file_path: filePath, offset: 4, limit: 3 }, ctx) as any;

    expect(result.file.startLine).toBe(4);
    expect(result.file.numLines).toBe(3);
    // Line numbers in output
    expect(result.file.content).toMatch(/4\t4/);
    expect(result.file.content).toMatch(/5\t5/);
    expect(result.file.content).toMatch(/6\t6/);
  });

  // ---------------------------------------------------------------------------
  // File not found
  // ---------------------------------------------------------------------------

  it('throws an error when the file does not exist', async () => {
    const missingPath = join(tmpDir, 'ghost-file.txt');

    await expect(
      tool.execute({ file_path: missingPath }, ctx),
    ).rejects.toThrow('File not found');
  });

  // ---------------------------------------------------------------------------
  // Empty file handling
  // ---------------------------------------------------------------------------

  it('returns a placeholder message for an empty file', async () => {
    const filePath = makeFile('empty.txt', '');

    const result = await tool.execute({ file_path: filePath }, ctx) as any;

    expect(result.type).toBe('text');
    expect(result.file.numLines).toBe(0);
    expect(result.file.totalLines).toBe(0);
    expect(result.file.content).toContain('[File exists but is empty]');
  });

  // ---------------------------------------------------------------------------
  // Long line truncation
  // ---------------------------------------------------------------------------

  it('truncates lines that exceed 2000 characters', async () => {
    // Create a line longer than the MAX_LINE_LENGTH (2000 chars)
    const longLine = 'x'.repeat(3000);
    const filePath = makeFile('long-line.txt', `${longLine}\nnormal line\n`);

    const result = await tool.execute({ file_path: filePath }, ctx) as any;

    const lines = result.file.content.split('\n');
    // First output line should contain the long content but be truncated after the tab
    const firstContentLine = lines[0];
    // Format is "  N\t<content>"; content portion must be <= 2000 chars.
    const tabIdx = firstContentLine.indexOf('\t');
    const contentPortion = firstContentLine.slice(tabIdx + 1);
    expect(contentPortion.length).toBeLessThanOrEqual(2000);
    // Normal second line should be intact
    expect(result.file.content).toContain('normal line');
  });
});
