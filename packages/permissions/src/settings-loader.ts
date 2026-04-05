import { existsSync, readFileSync } from 'fs';
import { readFile } from 'node:fs/promises';
import { join } from 'path';
import { homedir, platform } from 'os';
import type { PermissionRule, SandboxConfig } from './types';
import type { SettingSource } from '@open-agent/core';

export interface SettingsPermissions {
  allow?: PermissionRule[];
  deny?: PermissionRule[];
  ask?: PermissionRule[];
  allowedPaths?: string[];
  deniedPaths?: string[];
}

export interface SettingsFile {
  permissions?: SettingsPermissions;
  sandbox?: SandboxConfig;
  env?: Record<string, string>;
  [key: string]: unknown;
}

/**
 * Loads and merges settings files from multiple sources.
 *
 * Merge priority (lowest → highest):
 *   user  (~/.open-agent/settings.json)
 *   project (.open-agent/settings.json)
 *   local (.open-agent/settings.local.json)
 *
 * Each subsequent source overrides scalar values in earlier sources.
 * Permission rule arrays (allow/deny/ask) are concatenated so that rules
 * from all sources are preserved rather than overwritten.
 */
export class SettingsLoader {
  getCandidatePaths(
    cwd: string,
    sources: SettingSource[] = ['user', 'project', 'local'],
  ): string[] {
    const ordered: string[] = [];
    for (const source of sources) {
      ordered.push(...this.getSettingsPaths(source, cwd));
    }
    return [...new Set(ordered)];
  }

  load(
    cwd: string,
    sources: SettingSource[] = ['user', 'project', 'local']
  ): SettingsFile {
    const merged: SettingsFile = {};

    for (const source of sources) {
      const filePaths = this.getSettingsPaths(source, cwd);
      for (const filePath of filePaths) {
        if (!existsSync(filePath)) {
          continue;
        }
        try {
          const raw = readFileSync(filePath, 'utf-8');
          const parsed: SettingsFile = JSON.parse(raw);
          this.mergeSettings(merged, parsed);
        } catch {
          // Silently skip unreadable or malformed settings files
        }
      }
    }

    return merged;
  }

  private getSettingsPaths(source: SettingSource, cwd: string): string[] {
    switch (source) {
      case 'user':
        return [
          join(homedir(), '.open-agent', 'settings.json'),
          join(homedir(), '.claude', 'settings.json'),
        ];
      case 'project':
        return [
          join(cwd, '.open-agent', 'settings.json'),
          join(cwd, '.claude', 'settings.json'),
        ];
      case 'local':
        return [
          join(cwd, '.open-agent', 'settings.local.json'),
          join(cwd, '.claude', 'settings.local.json'),
        ];
      default:
        return [];
    }
  }

  /**
   * Merge source into target in place.
   *
   * - Top-level scalar/object fields: source wins (shallow assign)
   * - permissions.allow/deny/ask arrays: concatenated (union of all rules)
   * - sandbox: source wins entirely if present
   * - env: keys from source override matching keys in target
   */
  private mergeSettings(target: SettingsFile, source: SettingsFile): void {
    // Merge top-level scalar/object fields first
    for (const key of Object.keys(source) as Array<keyof SettingsFile>) {
      if (key === 'permissions' || key === 'env' || key === 'sandbox') {
        continue; // handled separately below
      }
      (target as Record<string, unknown>)[key] = source[key];
    }

    // Merge permission rule arrays (concatenate to preserve all rules)
    if (source.permissions) {
      if (!target.permissions) {
        target.permissions = {};
      }
      for (const bucket of ['allow', 'deny', 'ask'] as const) {
        const incoming = source.permissions[bucket];
        if (incoming && incoming.length > 0) {
          target.permissions[bucket] = [
            ...(target.permissions[bucket] ?? []),
            ...incoming,
          ];
        }
      }
      if (Array.isArray(source.permissions.allowedPaths)) {
        target.permissions.allowedPaths = [...source.permissions.allowedPaths];
      }
      if (Array.isArray(source.permissions.deniedPaths)) {
        target.permissions.deniedPaths = [...source.permissions.deniedPaths];
      }
    }

    // Merge env: key-by-key override
    if (source.env) {
      target.env = { ...(target.env ?? {}), ...source.env };
    }

    // Sandbox: source entirely replaces target (not deep-merged)
    if (source.sandbox !== undefined) {
      target.sandbox = source.sandbox;
    }
  }
}

// ---------------------------------------------------------------------------
// 6-Layer Settings Hierarchy
// ---------------------------------------------------------------------------

export interface LoadLayeredOptions {
  /** Working directory (project root). */
  cwd: string;
  /** Override home directory (useful in tests). Defaults to `os.homedir()`. */
  home?: string;
  /** CLI flag settings — highest precedence. */
  flagSettings?: Record<string, unknown>;
  /** Path to a policy settings file (enterprise / IT-managed). */
  policyPath?: string;
}

/**
 * Read a JSON file, returning an empty object on any error (missing,
 * malformed, permission-denied, etc.).
 */
async function readJsonSafe(path: string): Promise<Record<string, unknown>> {
  try {
    const content = await readFile(path, 'utf8');
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Recursively merge `source` into a *copy* of `target`.
 * - Plain objects are merged recursively.
 * - All other values (scalars, arrays) from `source` win outright.
 */
function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...target };
  for (const key of Object.keys(source)) {
    const s = source[key];
    const t = result[key];
    if (
      s !== null &&
      typeof s === 'object' &&
      !Array.isArray(s) &&
      t !== null &&
      typeof t === 'object' &&
      !Array.isArray(t)
    ) {
      result[key] = deepMerge(
        t as Record<string, unknown>,
        s as Record<string, unknown>,
      );
    } else {
      result[key] = s;
    }
  }
  return result;
}

/**
 * Load and deep-merge settings across the 6-layer precedence stack.
 *
 * Precedence (lowest → highest):
 *   defaults (empty object)
 *   mdm      (/Library/Managed Preferences/com.anthropic.claude.json — macOS only)
 *   user     (~/.claude/settings.json)
 *   local    (<cwd>/.claude/local/settings.json)
 *   project  (<cwd>/.claude/settings.json)
 *   policy   (opts.policyPath, if supplied)
 *   flag     (opts.flagSettings, if supplied — highest)
 *
 * Higher layers win on key conflicts. Plain-object values are deep-merged;
 * all other values (scalars, arrays) from the higher layer replace the lower.
 */
export async function loadLayeredSettings(
  opts: LoadLayeredOptions,
): Promise<Record<string, unknown>> {
  const home = opts.home ?? homedir();

  // Build layers from lowest to highest precedence
  const layers: Array<Record<string, unknown>> = [];

  // Layer 6 (lowest): defaults
  layers.push({});

  // Layer 5: MDM — macOS only
  if (platform() === 'darwin') {
    layers.push(
      await readJsonSafe('/Library/Managed Preferences/com.anthropic.claude.json'),
    );
  }

  // Layer 4: user
  layers.push(await readJsonSafe(join(home, '.claude', 'settings.json')));

  // Layer 3: local
  layers.push(
    await readJsonSafe(join(opts.cwd, '.claude', 'local', 'settings.json')),
  );

  // Layer 2: project
  layers.push(await readJsonSafe(join(opts.cwd, '.claude', 'settings.json')));

  // Layer 1: policy
  if (opts.policyPath) {
    layers.push(await readJsonSafe(opts.policyPath));
  }

  // Layer 0 (highest): flag
  if (opts.flagSettings) {
    layers.push(opts.flagSettings);
  }

  // Fold all layers left-to-right; higher layers (later in array) win
  return layers.reduce<Record<string, unknown>>(
    (acc, layer) => deepMerge(acc, layer),
    {},
  );
}
