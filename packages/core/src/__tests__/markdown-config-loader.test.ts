import { describe, it, expect, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadMarkdownConfig } from '../markdown-config-loader.js';

// Helpers to create temp dir trees

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'oa-mdload-'));
}

function writeAgentMd(base: string, name: string, content: string): void {
  const dir = join(base, '.claude', 'agents');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), content, 'utf-8');
}

describe('loadMarkdownConfig', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const dir of roots.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function tmp(): string {
    const d = makeTmpDir();
    roots.push(d);
    return d;
  }

  it('returns an empty array when both dirs are empty / missing', async () => {
    const home = tmp();
    const cwd = tmp();
    const result = await loadMarkdownConfig({ subdir: 'agents', cwd, home });
    expect(result).toEqual([]);
  });

  it('loads files from user dir with source="user"', async () => {
    const home = tmp();
    const cwd = tmp();
    writeAgentMd(home, 'my-agent', '---\ndescription: User agent\n---\nUser body.');

    const result = await loadMarkdownConfig({ subdir: 'agents', cwd, home });
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('my-agent');
    expect(result[0].source).toBe('user');
    expect(result[0].frontmatter.description).toBe('User agent');
    expect(result[0].body).toBe('User body.');
  });

  it('loads files from project dir with source="project"', async () => {
    const home = tmp();
    const cwd = tmp();
    writeAgentMd(cwd, 'proj-agent', '---\ndescription: Project agent\n---\nProject body.');

    const result = await loadMarkdownConfig({ subdir: 'agents', cwd, home });
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('proj-agent');
    expect(result[0].source).toBe('project');
    expect(result[0].frontmatter.description).toBe('Project agent');
  });

  it('project layer wins when the same name exists in both', async () => {
    const home = tmp();
    const cwd = tmp();
    writeAgentMd(home, 'shared-agent', '---\ndescription: User version\n---\nUser body.');
    writeAgentMd(cwd, 'shared-agent', '---\ndescription: Project version\n---\nProject body.');

    const result = await loadMarkdownConfig({ subdir: 'agents', cwd, home });
    expect(result).toHaveLength(1);
    expect(result[0].source).toBe('project');
    expect(result[0].frontmatter.description).toBe('Project version');
    expect(result[0].body).toBe('Project body.');
  });

  it('returns entries from both layers when names are different', async () => {
    const home = tmp();
    const cwd = tmp();
    writeAgentMd(home, 'user-only', '---\ndescription: User only\n---\n');
    writeAgentMd(cwd, 'proj-only', '---\ndescription: Proj only\n---\n');

    const result = await loadMarkdownConfig({ subdir: 'agents', cwd, home });
    expect(result).toHaveLength(2);
    const names = result.map(e => e.name);
    expect(names).toContain('user-only');
    expect(names).toContain('proj-only');
  });

  it('result is sorted alphabetically by name', async () => {
    const home = tmp();
    const cwd = tmp();
    writeAgentMd(cwd, 'zebra', '---\ndescription: Z\n---\n');
    writeAgentMd(cwd, 'alpha', '---\ndescription: A\n---\n');
    writeAgentMd(home, 'monkey', '---\ndescription: M\n---\n');

    const result = await loadMarkdownConfig({ subdir: 'agents', cwd, home });
    const names = result.map(e => e.name);
    expect(names).toEqual(['alpha', 'monkey', 'zebra']);
  });

  it('frontmatter parsing works end-to-end', async () => {
    const home = tmp();
    const cwd = tmp();
    writeAgentMd(cwd, 'typed-agent', [
      '---',
      'name: typed-agent',
      'enabled: true',
      'maxTurns: 7',
      'tools: [Read, Bash]',
      '---',
      'You are a typed agent.',
    ].join('\n'));

    const result = await loadMarkdownConfig({ subdir: 'agents', cwd, home });
    expect(result).toHaveLength(1);
    const { frontmatter, body } = result[0];
    expect(frontmatter.name).toBe('typed-agent');
    expect(frontmatter.enabled).toBe(true);
    expect(frontmatter.maxTurns).toBe(7);
    expect(frontmatter.tools).toEqual(['Read', 'Bash']);
    expect(body).toBe('You are a typed agent.');
  });

  it('files without frontmatter load with empty frontmatter object', async () => {
    const home = tmp();
    const cwd = tmp();
    writeAgentMd(cwd, 'no-fm', 'Just plain markdown body.\nNo frontmatter at all.');

    const result = await loadMarkdownConfig({ subdir: 'agents', cwd, home });
    expect(result).toHaveLength(1);
    expect(result[0].frontmatter).toEqual({});
    expect(result[0].body).toBe('Just plain markdown body.\nNo frontmatter at all.');
  });

  it('includes the absolute filePath in each entry', async () => {
    const home = tmp();
    const cwd = tmp();
    writeAgentMd(cwd, 'path-check', '---\ndescription: test\n---\nbody.');

    const result = await loadMarkdownConfig({ subdir: 'agents', cwd, home });
    expect(result[0].filePath).toContain('path-check.md');
    // Must be an absolute path
    expect(result[0].filePath.startsWith('/')).toBe(true);
  });
});
