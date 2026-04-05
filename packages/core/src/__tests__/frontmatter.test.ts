import { describe, it, expect } from 'bun:test';
import { parseFrontmatter } from '../frontmatter.js';

describe('parseFrontmatter', () => {
  it('returns empty frontmatter and full body when no frontmatter present', () => {
    const input = 'Just some markdown\nwith multiple lines.';
    const result = parseFrontmatter(input);
    expect(result.frontmatter).toEqual({});
    expect(result.body).toBe(input);
  });

  it('parses a simple string key/value', () => {
    const input = '---\nname: my-agent\n---\nBody text here.';
    const result = parseFrontmatter(input);
    expect(result.frontmatter.name).toBe('my-agent');
    expect(result.body).toBe('Body text here.');
  });

  it('parses boolean true', () => {
    const input = '---\nenabled: true\n---\n';
    const result = parseFrontmatter(input);
    expect(result.frontmatter.enabled).toBe(true);
  });

  it('parses boolean false', () => {
    const input = '---\nactive: false\n---\n';
    const result = parseFrontmatter(input);
    expect(result.frontmatter.active).toBe(false);
  });

  it('parses a numeric value', () => {
    const input = '---\nmaxTurns: 10\n---\n';
    const result = parseFrontmatter(input);
    expect(result.frontmatter.maxTurns).toBe(10);
  });

  it('parses an inline array', () => {
    const input = '---\ntools: [Read, Write, Bash]\n---\nContent.';
    const result = parseFrontmatter(input);
    expect(result.frontmatter.tools).toEqual(['Read', 'Write', 'Bash']);
    expect(result.body).toBe('Content.');
  });

  it('parses a block-style array (YAML sequence)', () => {
    const input = '---\ntools:\n  - Read\n  - Write\n  - Bash\n---\nContent.';
    const result = parseFrontmatter(input);
    expect(result.frontmatter.tools).toEqual(['Read', 'Write', 'Bash']);
    expect(result.body).toBe('Content.');
  });

  it('ignores comment lines in frontmatter', () => {
    const input = '---\n# This is a comment\nname: my-agent\n# Another comment\n---\nBody.';
    const result = parseFrontmatter(input);
    expect(result.frontmatter.name).toBe('my-agent');
    expect(Object.keys(result.frontmatter)).toHaveLength(1);
    expect(result.body).toBe('Body.');
  });

  it('treats everything as body when closing --- is missing', () => {
    const input = '---\nname: orphaned\nkey: value\n';
    const result = parseFrontmatter(input);
    expect(result.frontmatter).toEqual({});
    expect(result.body).toBe(input);
  });

  it('strips surrounding quotes from string values', () => {
    const input = `---\ndescription: "A quoted description"\nauthor: 'Colin'\n---\n`;
    const result = parseFrontmatter(input);
    expect(result.frontmatter.description).toBe('A quoted description');
    expect(result.frontmatter.author).toBe('Colin');
  });

  it('returns empty body string when there is no content after frontmatter', () => {
    const input = '---\nname: no-body\n---\n';
    const result = parseFrontmatter(input);
    expect(result.frontmatter.name).toBe('no-body');
    expect(result.body).toBe('');
  });

  it('preserves multi-line body content', () => {
    const input = '---\ntitle: test\n---\nLine one.\nLine two.\nLine three.';
    const result = parseFrontmatter(input);
    expect(result.body).toBe('Line one.\nLine two.\nLine three.');
  });

  it('handles multiple fields with different types', () => {
    const input = [
      '---',
      'name: multi-agent',
      'enabled: true',
      'maxTurns: 5',
      'tools: [Bash, Read]',
      '---',
      'Agent instructions.',
    ].join('\n');
    const result = parseFrontmatter(input);
    expect(result.frontmatter.name).toBe('multi-agent');
    expect(result.frontmatter.enabled).toBe(true);
    expect(result.frontmatter.maxTurns).toBe(5);
    expect(result.frontmatter.tools).toEqual(['Bash', 'Read']);
    expect(result.body).toBe('Agent instructions.');
  });
});
