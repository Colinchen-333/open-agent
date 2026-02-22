import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';
import type { McpServerConfig } from './types.js';

// ---------------------------------------------------------------------------
// Settings type
// ---------------------------------------------------------------------------

/** Inline shape for a single permission rule — mirrors permissions package. */
export interface PermissionRuleConfig {
  toolName: string;
  ruleContent?: string;
}

/** Inline shape for a hook entry — mirrors hooks package. */
export interface HookConfig {
  command: string;
  timeout?: number;
  env?: Record<string, string>;
}

/**
 * Merged settings object produced by ConfigLoader.loadSettings().
 * Layers (lowest-to-highest priority):
 *   1. ~/.open-agent/settings.json        (user-level)
 *   2. <cwd>/.open-agent/settings.json    (project-level)
 *   3. <cwd>/.open-agent/settings.local.json (local override, git-ignored)
 *   4. Session-level: runtime overrides from CLI flags (applied by callers)
 */
export interface Settings {
  // Core behaviour
  defaultModel?: string;
  permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk';
  thinking?: 'enabled' | 'disabled' | 'adaptive';
  effort?: 'low' | 'medium' | 'high' | 'max';
  maxTurns?: number;
  customInstructions?: string;

  // MCP servers — deep-merged across layers
  mcpServers?: Record<string, McpServerConfig>;

  // Permission rules — deep-merged across layers
  permissions?: {
    allow?: PermissionRuleConfig[];
    deny?: PermissionRuleConfig[];
    ask?: PermissionRuleConfig[];
    allowedPaths?: string[];
    deniedPaths?: string[];
  };

  // Hooks — deep-merged across layers
  hooks?: Record<string, HookConfig[]>;

  // UI / developer experience
  theme?: string;
  verbose?: boolean;
  debug?: boolean;

  // Team coordination
  activeTeam?: string;

  // Allow any additional unknown keys for forward compatibility
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// ConfigLoader
// ---------------------------------------------------------------------------

/**
 * ConfigLoader discovers and merges AGENT.md instruction files and
 * settings.json configuration files, mirroring the Claude Code CLAUDE.md
 * lookup strategy.
 *
 * Settings merge order (lowest-to-highest priority):
 *   1. ~/.open-agent/settings.json          (user-level)
 *   2. <cwd>/.open-agent/settings.json      (project-level)
 *   3. <cwd>/.open-agent/settings.local.json (local override, not committed)
 *
 * AGENT.md resolution order (lower index = lower priority):
 *   1. ~/.open-agent/AGENT.md               (user-level global)
 *   2. Walk upward from cwd, collecting AGENT.md and .open-agent/AGENT.md
 *      at each level (outermost → innermost).
 */
export class ConfigLoader {
  /**
   * Collect all AGENT.md instruction files relevant to the given working
   * directory. Returns them in discovery order (user first, then outermost
   * project dir first, innermost last).
   *
   * Loaded from:
   *   1. `~/.open-agent/AGENT.md`            (global user instructions)
   *   2. `<cwd>/AGENT.md`                    (project root)
   *   3. `<cwd>/.open-agent/AGENT.md`        (project config dir)
   *
   * In addition, every ancestor directory of `cwd` is also searched so that
   * monorepo root instructions propagate down to nested packages.
   */
  loadAgentMd(cwd: string): string[] {
    const instructions: string[] = [];

    // 1. User-level instruction file — check both .open-agent/ and .claude/ (compat)
    for (const configDir of ['.open-agent', '.claude']) {
      const userAgentMd = join(homedir(), configDir, 'AGENT.md');
      if (existsSync(userAgentMd)) {
        instructions.push(readFileSync(userAgentMd, 'utf-8'));
        break; // only load from one user-level dir
      }
    }
    // Also check ~/.claude/CLAUDE.md (Claude Code compat)
    if (instructions.length === 0) {
      const claudeMd = join(homedir(), '.claude', 'CLAUDE.md');
      if (existsSync(claudeMd)) {
        instructions.push(readFileSync(claudeMd, 'utf-8'));
      }
    }

    // 2. Walk from cwd upward, collecting project-level instruction files.
    //    We gather all candidates first then reverse so outermost comes before
    //    innermost (outer instructions set the context, inner ones refine it).
    const projectInstructions: string[] = [];
    let dir = resolve(cwd);
    const visited = new Set<string>();

    while (dir && !visited.has(dir)) {
      visited.add(dir);

      // Check AGENT.md, CLAUDE.md at project root
      for (const mdName of ['AGENT.md', 'CLAUDE.md']) {
        const projectPath = join(dir, mdName);
        if (existsSync(projectPath)) {
          projectInstructions.push(readFileSync(projectPath, 'utf-8'));
        }
      }

      // Check .open-agent/AGENT.md and .claude/CLAUDE.md in config dirs
      for (const [configDir, mdName] of [
        ['.open-agent', 'AGENT.md'],
        ['.claude', 'CLAUDE.md'],
      ] as const) {
        const dotPath = join(dir, configDir, mdName);
        if (existsSync(dotPath)) {
          projectInstructions.push(readFileSync(dotPath, 'utf-8'));
        }
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
   * Load and deep-merge settings from all three layers.
   *
   * Merge order (later sources win on conflicts):
   *   1. `~/.open-agent/settings.json`           (user-level)
   *   2. `<cwd>/.open-agent/settings.json`       (project-level)
   *   3. `<cwd>/.open-agent/settings.local.json` (local override, git-ignored)
   *
   * Unlike a shallow Object.assign, nested objects (e.g. `mcpServers`,
   * `permissions`, `hooks`) are recursively merged so that project-level
   * settings can add MCP servers without wiping out user-level ones.
   * Arrays are replaced entirely (the higher-priority layer wins).
   */
  loadSettings(cwd: string): Settings {
    let merged: Settings = {};

    const sources = [
      // User-level: .open-agent/ then .claude/ (compat)
      join(homedir(), '.open-agent', 'settings.json'),
      join(homedir(), '.claude', 'settings.json'),
      // Project-level: .open-agent/ then .claude/ (compat)
      join(cwd, '.open-agent', 'settings.json'),
      join(cwd, '.claude', 'settings.json'),
      // Local override (git-ignored)
      join(cwd, '.open-agent', 'settings.local.json'),
      join(cwd, '.claude', 'settings.local.json'),
    ];

    for (const src of sources) {
      if (existsSync(src)) {
        try {
          const parsed = JSON.parse(readFileSync(src, 'utf-8')) as Settings;
          merged = deepMerge(merged, parsed);
        } catch {
          // Malformed JSON — silently skip to avoid crashing startup.
        }
      }
    }

    return merged;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Deep-merge `source` into `target`, returning a new object.
 *
 * Rules:
 * - Plain objects are merged recursively.
 * - Arrays are replaced by the source value (not concatenated).
 * - Primitives and all other values are replaced by the source value.
 * - Neither `target` nor `source` are mutated.
 */
function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...target };

  for (const key of Object.keys(source)) {
    const srcVal = source[key];
    const tgtVal = target[key];

    if (
      srcVal !== null &&
      typeof srcVal === 'object' &&
      !Array.isArray(srcVal) &&
      tgtVal !== null &&
      typeof tgtVal === 'object' &&
      !Array.isArray(tgtVal)
    ) {
      // Both sides are plain objects — recurse
      result[key] = deepMerge(
        tgtVal as Record<string, unknown>,
        srcVal as Record<string, unknown>,
      );
    } else {
      // Primitive, array, or one side is missing — source wins
      result[key] = srcVal;
    }
  }

  return result;
}
