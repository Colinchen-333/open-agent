import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createGrepTool } from '../grep.js';

describe('Grep tool', () => {
  let tmpDir: string;
  let tool: ReturnType<typeof createGrepTool>;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'open-agent-grep-test-'));
    tool = createGrepTool();

    // Create a small set of files with known content.
    const src = join(tmpDir, 'src');
    mkdirSync(src, { recursive: true });

    writeFileSync(
      join(tmpDir, 'alpha.ts'),
      'const hello = "world";\nconsole.log(hello);\n',
    );
    writeFileSync(
      join(tmpDir, 'beta.ts'),
      'function greet(name: string) {\n  return `Hello ${name}`;\n}\n',
    );
    writeFileSync(
      join(tmpDir, 'gamma.js'),
      'const x = 42;\nconst hello = "js";\n',
    );
    writeFileSync(
      join(src, 'deep.ts'),
      'export const ANSWER = 42;\n',
    );
    writeFileSync(
      join(tmpDir, 'notes.md'),
      '# Notes\nThis file mentions hello three times.\nhello again.\n',
    );
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const makeCtx = () => ({ cwd: tmpDir, sessionId: 'test' });

  // ---------------------------------------------------------------------------
  // files_with_matches mode (default)
  // ---------------------------------------------------------------------------

  describe('files_with_matches mode (default)', () => {
    it('returns paths of files that contain the pattern', async () => {
      const result = await tool.execute(
        { pattern: 'hello', path: tmpDir },
        makeCtx(),
      );

      expect(result.mode).toBe('files_with_matches');
      // alpha.ts, beta.ts (Hello), gamma.js, notes.md all contain "hello" (case-sensitive: alpha.ts, gamma.js, notes.md)
      expect(result.numFiles).toBeGreaterThanOrEqual(1);
      const filenames = result.filenames.map((f: string) => f.split('/').pop());
      expect(filenames).toContain('alpha.ts');
    });

    it('returns empty when pattern is not found anywhere', async () => {
      const result = await tool.execute(
        { pattern: 'zzz_not_found_xyz', path: tmpDir },
        makeCtx(),
      );

      expect(result.numFiles).toBe(0);
      expect(result.filenames).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // content mode
  // ---------------------------------------------------------------------------

  describe('content mode', () => {
    it('returns matching lines with line numbers (default -n: true)', async () => {
      const result = await tool.execute(
        { pattern: 'hello', path: tmpDir, output_mode: 'content' },
        makeCtx(),
      );

      expect(result.mode).toBe('content');
      expect(result.content).toBeDefined();
      // Content should include file:line:content format entries
      expect(result.content).toContain('hello');
      // Line numbers enabled by default — should see colon-separated entries
      expect(result.content).toMatch(/\d+:/);
    });

    it('case-insensitive flag (-i) matches regardless of case', async () => {
      const result = await tool.execute(
        { pattern: 'HELLO', path: tmpDir, output_mode: 'content', '-i': true },
        makeCtx(),
      );

      expect(result.content).toBeDefined();
      // Should match "hello", "Hello", "HELLO" — beta.ts has "Hello" with capital H
      expect(result.numFiles).toBeGreaterThanOrEqual(1);
    });
  });

  // ---------------------------------------------------------------------------
  // count mode
  // ---------------------------------------------------------------------------

  describe('count mode', () => {
    it('returns per-file match counts', async () => {
      const result = await tool.execute(
        { pattern: 'hello', path: tmpDir, output_mode: 'count' },
        makeCtx(),
      );

      expect(result.mode).toBe('count');
      // filenames extracted from "path:count" lines
      expect(result.numFiles).toBeGreaterThanOrEqual(1);
    });
  });

  // ---------------------------------------------------------------------------
  // File type filtering
  // ---------------------------------------------------------------------------

  describe('file type filtering', () => {
    it('type: "ts" restricts search to TypeScript files', async () => {
      const result = await tool.execute(
        { pattern: 'hello', path: tmpDir, type: 'ts', output_mode: 'files_with_matches' },
        makeCtx(),
      );

      // Only .ts files should appear — gamma.js and notes.md should be excluded.
      for (const f of result.filenames) {
        expect(f).toMatch(/\.ts$/);
      }
    });

    it('glob filter restricts files by glob pattern', async () => {
      const result = await tool.execute(
        { pattern: 'hello', path: tmpDir, glob: '*.js', output_mode: 'files_with_matches' },
        makeCtx(),
      );

      // Only .js files
      for (const f of result.filenames) {
        expect(f).toMatch(/\.js$/);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // head_limit / offset pagination
  // ---------------------------------------------------------------------------

  describe('head_limit and offset', () => {
    it('head_limit caps the number of output lines', async () => {
      const unlimited = await tool.execute(
        { pattern: 'hello', path: tmpDir, output_mode: 'files_with_matches' },
        makeCtx(),
      );

      if (unlimited.numFiles < 2) {
        // Not enough matches to test limiting — skip.
        return;
      }

      const limited = await tool.execute(
        { pattern: 'hello', path: tmpDir, output_mode: 'files_with_matches', head_limit: 1 },
        makeCtx(),
      );

      expect(limited.filenames.length).toBeLessThanOrEqual(1);
    });

    it('offset skips the first N results', async () => {
      const all = await tool.execute(
        { pattern: 'hello', path: tmpDir, output_mode: 'files_with_matches' },
        makeCtx(),
      );

      if (all.numFiles < 2) {
        // Not enough matches — skip.
        return;
      }

      const offset1 = await tool.execute(
        { pattern: 'hello', path: tmpDir, output_mode: 'files_with_matches', offset: 1 },
        makeCtx(),
      );

      expect(offset1.filenames.length).toBe(all.filenames.length - 1);
    });
  });

  // ---------------------------------------------------------------------------
  // Regex patterns
  // ---------------------------------------------------------------------------

  describe('regex patterns', () => {
    it('matches a number pattern across files', async () => {
      const result = await tool.execute(
        { pattern: '\\d+', path: tmpDir, output_mode: 'files_with_matches' },
        makeCtx(),
      );

      // gamma.js (42) and deep.ts (42) contain numbers
      expect(result.numFiles).toBeGreaterThanOrEqual(1);
    });

    it('anchored pattern matches only at line start', async () => {
      const result = await tool.execute(
        { pattern: '^const', path: tmpDir, output_mode: 'files_with_matches', type: 'ts' },
        makeCtx(),
      );

      // alpha.ts starts a line with "const"
      expect(result.numFiles).toBeGreaterThanOrEqual(1);
    });
  });
});
