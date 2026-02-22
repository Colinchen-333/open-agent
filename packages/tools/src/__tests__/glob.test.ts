import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createGlobTool } from '../glob.js';

describe('Glob tool', () => {
  let tmpDir: string;
  let tool: ReturnType<typeof createGlobTool>;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'open-agent-glob-test-'));
    tool = createGlobTool();

    // Create a known file structure under tmpDir:
    //
    //   src/
    //     index.ts
    //     utils.ts
    //     helper.js
    //   src/nested/
    //     deep.ts
    //   docs/
    //     readme.md
    //   root.txt
    //   .hidden
    //
    const src = join(tmpDir, 'src');
    const nested = join(src, 'nested');
    const docs = join(tmpDir, 'docs');

    mkdirSync(src, { recursive: true });
    mkdirSync(nested, { recursive: true });
    mkdirSync(docs, { recursive: true });

    writeFileSync(join(src, 'index.ts'), 'export {};');
    writeFileSync(join(src, 'utils.ts'), 'export {};');
    writeFileSync(join(src, 'helper.js'), '// js');
    writeFileSync(join(nested, 'deep.ts'), 'export {};');
    writeFileSync(join(docs, 'readme.md'), '# Readme');
    writeFileSync(join(tmpDir, 'root.txt'), 'root');
    writeFileSync(join(tmpDir, '.hidden'), 'hidden file');
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const makeCtx = (dir: string) => ({ cwd: dir, sessionId: 'test' });

  it('matches *.txt in the root directory', async () => {
    const result = await tool.execute({ pattern: '*.txt', path: tmpDir }, makeCtx(tmpDir));

    expect(result.numFiles).toBe(1);
    expect(result.filenames[0]).toContain('root.txt');
  });

  it('matches **/*.ts recursively', async () => {
    const result = await tool.execute({ pattern: '**/*.ts', path: tmpDir }, makeCtx(tmpDir));

    expect(result.numFiles).toBe(3);
    const names = result.filenames.map((f: string) => f.split('/').pop());
    expect(names).toContain('index.ts');
    expect(names).toContain('utils.ts');
    expect(names).toContain('deep.ts');
  });

  it('matches *.ts in a specific subdirectory', async () => {
    const srcDir = join(tmpDir, 'src');
    const result = await tool.execute({ pattern: '*.ts', path: srcDir }, makeCtx(tmpDir));

    // Only the two top-level .ts files in src/, not the nested one.
    expect(result.numFiles).toBe(2);
    const names = result.filenames.map((f: string) => f.split('/').pop());
    expect(names).toContain('index.ts');
    expect(names).toContain('utils.ts');
    expect(names).not.toContain('deep.ts');
  });

  it('matches nested directory structure with deep glob', async () => {
    const result = await tool.execute(
      { pattern: 'src/nested/*.ts', path: tmpDir },
      makeCtx(tmpDir),
    );

    expect(result.numFiles).toBe(1);
    expect(result.filenames[0]).toContain('deep.ts');
  });

  it('returns zero files when pattern matches nothing', async () => {
    const result = await tool.execute(
      { pattern: '**/*.py', path: tmpDir },
      makeCtx(tmpDir),
    );

    expect(result.numFiles).toBe(0);
    expect(result.filenames).toHaveLength(0);
    expect(result.truncated).toBe(false);
  });

  it('filenames are absolute paths', async () => {
    const result = await tool.execute({ pattern: '**/*.md', path: tmpDir }, makeCtx(tmpDir));

    expect(result.numFiles).toBeGreaterThan(0);
    for (const f of result.filenames) {
      expect(f.startsWith('/')).toBe(true);
    }
  });

  it('defaults to ctx.cwd when path is not provided', async () => {
    const result = await tool.execute({ pattern: '*.txt' }, makeCtx(tmpDir));

    expect(result.numFiles).toBeGreaterThan(0);
    expect(result.filenames.some((f: string) => f.endsWith('root.txt'))).toBe(true);
  });

  it('matches hidden files (dot: true)', async () => {
    const result = await tool.execute({ pattern: '.hidden', path: tmpDir }, makeCtx(tmpDir));

    expect(result.numFiles).toBe(1);
    expect(result.filenames[0]).toContain('.hidden');
  });

  it('matches multiple extensions with brace expansion', async () => {
    const result = await tool.execute(
      { pattern: 'src/*.{ts,js}', path: tmpDir },
      makeCtx(tmpDir),
    );

    // index.ts, utils.ts, helper.js
    expect(result.numFiles).toBe(3);
    const exts = result.filenames.map((f: string) => f.split('.').pop());
    expect(exts).toContain('ts');
    expect(exts).toContain('js');
  });

  it('result includes durationMs and truncated flag', async () => {
    const result = await tool.execute({ pattern: '**/*', path: tmpDir }, makeCtx(tmpDir));

    expect(result.durationMs).toBeTypeOf('number');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.truncated).toBeTypeOf('boolean');
  });
});
