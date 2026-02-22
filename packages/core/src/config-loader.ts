import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';

/**
 * ConfigLoader discovers and merges AGENT.md instruction files and
 * settings.json configuration files, mirroring the Claude Code CLAUDE.md
 * lookup strategy.
 *
 * Resolution order (lower index = lower priority, later entries win):
 *   1. User-level  : ~/.open-agent/AGENT.md
 *   2. Project-level: walk upward from cwd, collecting AGENT.md and
 *                     .open-agent/AGENT.md at each directory level.
 *
 * Settings follow the same three-tier merge (user → project → local).
 */
export class ConfigLoader {
  /**
   * Collect all AGENT.md instruction files relevant to the given working
   * directory. Returns them in discovery order (user first, then outermost
   * project dir first, innermost last).
   */
  loadAgentMd(cwd: string): string[] {
    const instructions: string[] = [];

    // User-level instruction file
    const userPath = join(homedir(), '.open-agent', 'AGENT.md');
    if (existsSync(userPath)) {
      instructions.push(readFileSync(userPath, 'utf-8'));
    }

    // Walk from cwd upward, collecting project-level instruction files.
    // We gather all candidates first then reverse so outermost comes before innermost.
    const projectInstructions: string[] = [];
    let dir = resolve(cwd);
    const visited = new Set<string>();

    while (dir && !visited.has(dir)) {
      visited.add(dir);

      const projectPath = join(dir, 'AGENT.md');
      if (existsSync(projectPath)) {
        projectInstructions.push(readFileSync(projectPath, 'utf-8'));
      }

      // Also honour .open-agent/AGENT.md convention
      const dotPath = join(dir, '.open-agent', 'AGENT.md');
      if (existsSync(dotPath)) {
        projectInstructions.push(readFileSync(dotPath, 'utf-8'));
      }

      const parent = resolve(dir, '..');
      if (parent === dir) break; // reached filesystem root
      dir = parent;
    }

    // Reverse so that outermost (root) instructions appear before innermost (cwd)
    instructions.push(...projectInstructions.reverse());

    return instructions;
  }

  /**
   * Load and merge settings from (in priority order):
   *   1. ~/.open-agent/settings.json          (user-level)
   *   2. <cwd>/.open-agent/settings.json      (project-level)
   *   3. <cwd>/.open-agent/settings.local.json (local override, not committed)
   *
   * Later sources shallow-merge over earlier ones.
   */
  loadSettings(cwd: string): Record<string, unknown> {
    const settings: Record<string, unknown> = {};

    const sources = [
      join(homedir(), '.open-agent', 'settings.json'),
      join(cwd, '.open-agent', 'settings.json'),
      join(cwd, '.open-agent', 'settings.local.json'),
    ];

    for (const src of sources) {
      if (existsSync(src)) {
        try {
          const parsed = JSON.parse(readFileSync(src, 'utf-8')) as Record<string, unknown>;
          Object.assign(settings, parsed);
        } catch {
          // Malformed JSON — silently skip to avoid crashing startup
        }
      }
    }

    return settings;
  }
}
