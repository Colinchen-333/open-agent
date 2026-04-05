import { describe, it, expect, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  loadOutputStyles,
  mergeOutputStyles,
  findOutputStyle,
  BUILTIN_OUTPUT_STYLES,
  type OutputStyle,
} from '../output-styles.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'oa-outstyle-'));
}

function writeStyleMd(base: string, filename: string, content: string): void {
  const dir = join(base, '.claude', 'output-styles');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), content, 'utf-8');
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const roots: string[] = [];
function tmp(): string {
  const d = makeTmpDir();
  roots.push(d);
  return d;
}

afterEach(() => {
  for (const dir of roots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// loadOutputStyles
// ---------------------------------------------------------------------------

describe('loadOutputStyles', () => {
  it('returns empty array when no output-styles directories exist', async () => {
    const home = tmp();
    const cwd = tmp();
    const result = await loadOutputStyles(cwd, home);
    expect(result).toEqual([]);
  });

  it('loads a style from cwd layer', async () => {
    const home = tmp();
    const cwd = tmp();
    writeStyleMd(
      cwd,
      'compact.md',
      [
        '---',
        'name: compact',
        'description: Very compact replies',
        'keep-coding-instructions: true',
        '---',
        'Reply in the most compact way possible.',
      ].join('\n'),
    );

    const result = await loadOutputStyles(cwd, home);
    expect(result).toHaveLength(1);
    const style = result[0];
    expect(style.name).toBe('compact');
    expect(style.description).toBe('Very compact replies');
    expect(style.instructions).toBe('Reply in the most compact way possible.');
    expect(style.keepCodingInstructions).toBe(true);
    expect(style.sourcePath).toContain('compact.md');
  });

  it('uses filename stem when name is absent from frontmatter', async () => {
    const home = tmp();
    const cwd = tmp();
    writeStyleMd(
      cwd,
      'my-style.md',
      '---\ndescription: No name in frontmatter\n---\nSome instructions.',
    );

    const result = await loadOutputStyles(cwd, home);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('my-style');
  });

  it('loads two styles from cwd layer', async () => {
    const home = tmp();
    const cwd = tmp();
    writeStyleMd(cwd, 'alpha.md', '---\ndescription: Alpha style\n---\nAlpha instructions.');
    writeStyleMd(cwd, 'beta.md', '---\ndescription: Beta style\n---\nBeta instructions.');

    const result = await loadOutputStyles(cwd, home);
    expect(result).toHaveLength(2);
    const names = result.map((s) => s.name);
    expect(names).toContain('alpha');
    expect(names).toContain('beta');
  });

  it('project (cwd) layer overrides user (home) layer for the same name', async () => {
    const home = tmp();
    const cwd = tmp();
    writeStyleMd(home, 'shared.md', '---\ndescription: User version\n---\nUser instructions.');
    writeStyleMd(cwd, 'shared.md', '---\ndescription: Project version\n---\nProject instructions.');

    const result = await loadOutputStyles(cwd, home);
    expect(result).toHaveLength(1);
    expect(result[0].description).toBe('Project version');
    expect(result[0].instructions).toBe('Project instructions.');
  });

  it('trims whitespace from the instructions body', async () => {
    const home = tmp();
    const cwd = tmp();
    writeStyleMd(cwd, 'trim.md', '---\ndescription: Trim test\n---\n\n  Trimmed body.  \n\n');

    const result = await loadOutputStyles(cwd, home);
    expect(result[0].instructions).toBe('Trimmed body.');
  });

  describe('keep-coding-instructions parsing', () => {
    it('defaults to true when field is absent', async () => {
      const home = tmp();
      const cwd = tmp();
      writeStyleMd(cwd, 'no-flag.md', '---\ndescription: No flag\n---\nSome instructions.');

      const result = await loadOutputStyles(cwd, home);
      expect(result[0].keepCodingInstructions).toBe(true);
    });

    it('reads keep-coding-instructions: false', async () => {
      const home = tmp();
      const cwd = tmp();
      writeStyleMd(
        cwd,
        'no-code.md',
        '---\ndescription: No code\nkeep-coding-instructions: false\n---\nCustom only.',
      );

      const result = await loadOutputStyles(cwd, home);
      expect(result[0].keepCodingInstructions).toBe(false);
    });

    it('reads keep-coding-instructions: true', async () => {
      const home = tmp();
      const cwd = tmp();
      writeStyleMd(
        cwd,
        'with-code.md',
        '---\ndescription: With code\nkeep-coding-instructions: true\n---\nInstructions.',
      );

      const result = await loadOutputStyles(cwd, home);
      expect(result[0].keepCodingInstructions).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// parseBooleanish (tested indirectly via loadOutputStyles keep-coding-instructions)
// ---------------------------------------------------------------------------

describe('parseBooleanish (via keep-coding-instructions field)', () => {
  it('treats string "false" as false', async () => {
    const home = tmp();
    const cwd = tmp();
    writeStyleMd(cwd, 's1.md', '---\nkeep-coding-instructions: "false"\n---\nBody.');
    const result = await loadOutputStyles(cwd, home);
    expect(result[0].keepCodingInstructions).toBe(false);
  });

  it('treats string "no" as false', async () => {
    const home = tmp();
    const cwd = tmp();
    writeStyleMd(cwd, 's2.md', '---\nkeep-coding-instructions: "no"\n---\nBody.');
    const result = await loadOutputStyles(cwd, home);
    expect(result[0].keepCodingInstructions).toBe(false);
  });

  it('treats string "0" as false', async () => {
    const home = tmp();
    const cwd = tmp();
    writeStyleMd(cwd, 's3.md', '---\nkeep-coding-instructions: "0"\n---\nBody.');
    const result = await loadOutputStyles(cwd, home);
    expect(result[0].keepCodingInstructions).toBe(false);
  });

  it('treats string "yes" as true', async () => {
    const home = tmp();
    const cwd = tmp();
    writeStyleMd(cwd, 's4.md', '---\nkeep-coding-instructions: "yes"\n---\nBody.');
    const result = await loadOutputStyles(cwd, home);
    expect(result[0].keepCodingInstructions).toBe(true);
  });

  it('treats string "true" as true', async () => {
    const home = tmp();
    const cwd = tmp();
    writeStyleMd(cwd, 's5.md', '---\nkeep-coding-instructions: "true"\n---\nBody.');
    const result = await loadOutputStyles(cwd, home);
    expect(result[0].keepCodingInstructions).toBe(true);
  });

  it('treats boolean false as false', async () => {
    const home = tmp();
    const cwd = tmp();
    // YAML boolean
    writeStyleMd(cwd, 's6.md', '---\nkeep-coding-instructions: false\n---\nBody.');
    const result = await loadOutputStyles(cwd, home);
    expect(result[0].keepCodingInstructions).toBe(false);
  });

  it('treats numeric 0 as false', async () => {
    const home = tmp();
    const cwd = tmp();
    writeStyleMd(cwd, 's7.md', '---\nkeep-coding-instructions: 0\n---\nBody.');
    const result = await loadOutputStyles(cwd, home);
    expect(result[0].keepCodingInstructions).toBe(false);
  });

  it('treats numeric 1 as true', async () => {
    const home = tmp();
    const cwd = tmp();
    writeStyleMd(cwd, 's8.md', '---\nkeep-coding-instructions: 1\n---\nBody.');
    const result = await loadOutputStyles(cwd, home);
    expect(result[0].keepCodingInstructions).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// mergeOutputStyles
// ---------------------------------------------------------------------------

describe('mergeOutputStyles', () => {
  it('returns built-ins when loaded is empty', () => {
    const result = mergeOutputStyles([]);
    expect(result.map((s) => s.name)).toContain('default');
    expect(result.map((s) => s.name)).toContain('verbose');
    expect(result.map((s) => s.name)).toContain('terse');
  });

  it('user-loaded style wins over built-in with the same name', () => {
    const loaded: OutputStyle[] = [
      {
        name: 'terse',
        description: 'My custom terse',
        instructions: 'Custom terse instructions.',
        keepCodingInstructions: false,
        sourcePath: '/custom/terse.md',
      },
    ];
    const result = mergeOutputStyles(loaded);
    const terse = result.find((s) => s.name === 'terse')!;
    expect(terse.description).toBe('My custom terse');
    expect(terse.instructions).toBe('Custom terse instructions.');
    expect(terse.keepCodingInstructions).toBe(false);
    expect(terse.sourcePath).toBe('/custom/terse.md');
  });

  it('a completely new loaded style is added to the list', () => {
    const loaded: OutputStyle[] = [
      {
        name: 'poetic',
        description: 'Responds in poetry',
        instructions: 'Always reply in rhyming couplets.',
        keepCodingInstructions: true,
        sourcePath: '/home/user/.claude/output-styles/poetic.md',
      },
    ];
    const result = mergeOutputStyles(loaded);
    const names = result.map((s) => s.name);
    expect(names).toContain('poetic');
    expect(names).toContain('default');
    expect(names).toContain('verbose');
  });

  it('result is sorted alphabetically by name', () => {
    const loaded: OutputStyle[] = [
      {
        name: 'zebra',
        description: 'Z style',
        instructions: '',
        keepCodingInstructions: true,
        sourcePath: '<test>',
      },
    ];
    const result = mergeOutputStyles(loaded);
    const names = result.map((s) => s.name);
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    expect(names).toEqual(sorted);
  });

  it('accepts a custom builtin list', () => {
    const customBuiltins: OutputStyle[] = [
      {
        name: 'custom-builtin',
        description: 'Custom built-in',
        instructions: '',
        keepCodingInstructions: true,
        sourcePath: '<builtin>',
      },
    ];
    const result = mergeOutputStyles([], customBuiltins);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('custom-builtin');
  });
});

// ---------------------------------------------------------------------------
// findOutputStyle
// ---------------------------------------------------------------------------

describe('findOutputStyle', () => {
  const allStyles = mergeOutputStyles([]);

  it('finds a style by exact name', () => {
    const result = findOutputStyle('verbose', allStyles);
    expect(result.name).toBe('verbose');
  });

  it('finds the "default" style by name', () => {
    const result = findOutputStyle('default', allStyles);
    expect(result.name).toBe('default');
  });

  it('falls back to "default" when name is not found', () => {
    const result = findOutputStyle('nonexistent-style', allStyles);
    expect(result.name).toBe('default');
  });

  it('falls back to first style when "default" is also absent', () => {
    const noDefault: OutputStyle[] = [
      {
        name: 'alpha',
        description: 'Alpha',
        instructions: '',
        keepCodingInstructions: true,
        sourcePath: '<test>',
      },
      {
        name: 'beta',
        description: 'Beta',
        instructions: '',
        keepCodingInstructions: true,
        sourcePath: '<test>',
      },
    ];
    const result = findOutputStyle('nonexistent', noDefault);
    expect(result.name).toBe('alpha');
  });

  it('returns BUILTIN_OUTPUT_STYLES[0] when styles array is empty', () => {
    const result = findOutputStyle('anything', []);
    expect(result.name).toBe(BUILTIN_OUTPUT_STYLES[0]!.name);
  });
});

// ---------------------------------------------------------------------------
// BUILTIN_OUTPUT_STYLES
// ---------------------------------------------------------------------------

describe('BUILTIN_OUTPUT_STYLES', () => {
  it('contains exactly default, verbose, and terse', () => {
    const names = BUILTIN_OUTPUT_STYLES.map((s) => s.name);
    expect(names).toContain('default');
    expect(names).toContain('verbose');
    expect(names).toContain('terse');
  });

  it('default style has empty instructions', () => {
    const def = BUILTIN_OUTPUT_STYLES.find((s) => s.name === 'default')!;
    expect(def.instructions).toBe('');
  });

  it('verbose style has non-empty instructions', () => {
    const verbose = BUILTIN_OUTPUT_STYLES.find((s) => s.name === 'verbose')!;
    expect(verbose.instructions.length).toBeGreaterThan(0);
  });

  it('terse style has non-empty instructions', () => {
    const terse = BUILTIN_OUTPUT_STYLES.find((s) => s.name === 'terse')!;
    expect(terse.instructions.length).toBeGreaterThan(0);
  });

  it('all built-in styles have keepCodingInstructions: true', () => {
    for (const s of BUILTIN_OUTPUT_STYLES) {
      expect(s.keepCodingInstructions).toBe(true);
    }
  });

  it('all built-in styles have sourcePath "<builtin>"', () => {
    for (const s of BUILTIN_OUTPUT_STYLES) {
      expect(s.sourcePath).toBe('<builtin>');
    }
  });
});
