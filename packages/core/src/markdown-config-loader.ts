import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { parseFrontmatter } from './frontmatter.js';

export interface MarkdownConfigEntry {
  /** File basename without the `.md` extension. */
  name: string;
  /** Absolute path to the source file. */
  filePath: string;
  /** Which config layer the entry came from. */
  source: 'user' | 'project';
  frontmatter: Record<string, string | boolean | number | string[]>;
  body: string;
}

export interface LoadMarkdownConfigOptions {
  subdir: 'agents' | 'commands' | 'skills' | 'output-styles' | 'workflows';
  /** Project root directory (used to locate `<cwd>/.claude/<subdir>/`). */
  cwd: string;
  /** User home directory. Defaults to `os.homedir()`. */
  home?: string;
}

/**
 * Load markdown files from two layers with project-over-user precedence:
 *   1. `<home>/.claude/<subdir>/*.md`  (user layer)
 *   2. `<cwd>/.claude/<subdir>/*.md`   (project layer)
 *
 * If the same basename exists in both layers, the project layer entry wins
 * and the user layer entry is filtered out. The returned list is sorted
 * alphabetically by name.
 *
 * Files that fail to parse are skipped silently (best-effort loading).
 */
export async function loadMarkdownConfig(
  options: LoadMarkdownConfigOptions,
): Promise<MarkdownConfigEntry[]> {
  const { subdir, cwd, home = homedir() } = options;

  const userDir = join(home, '.claude', subdir);
  const projectDir = join(cwd, '.claude', subdir);

  const userEntries = loadFromDir(userDir, 'user');
  const projectEntries = loadFromDir(projectDir, 'project');

  // Build a set of names present in the project layer so we can filter duplicates
  const projectNames = new Set(projectEntries.map(e => e.name));

  // Merge: project entries take precedence over user entries with the same name
  const merged = [
    ...userEntries.filter(e => !projectNames.has(e.name)),
    ...projectEntries,
  ];

  // Sort alphabetically by name for deterministic output
  merged.sort((a, b) => a.name.localeCompare(b.name));

  return merged;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function loadFromDir(dir: string, source: 'user' | 'project'): MarkdownConfigEntry[] {
  if (!existsSync(dir)) return [];

  let files: string[];
  try {
    files = readdirSync(dir).filter(f => f.endsWith('.md'));
  } catch {
    return [];
  }

  const entries: MarkdownConfigEntry[] = [];

  for (const file of files) {
    const filePath = join(dir, file);
    const name = file.slice(0, -3); // strip ".md"

    try {
      const raw = readFileSync(filePath, 'utf-8');
      const { frontmatter, body } = parseFrontmatter(raw);
      entries.push({ name, filePath, source, frontmatter, body });
    } catch {
      // Best-effort: skip files that can't be read or parsed
    }
  }

  return entries;
}
