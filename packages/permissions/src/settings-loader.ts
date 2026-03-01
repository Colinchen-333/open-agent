import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
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
  load(
    cwd: string,
    sources: SettingSource[] = ['user', 'project', 'local']
  ): SettingsFile {
    const merged: SettingsFile = {};

    for (const source of sources) {
      const filePath = this.getSettingsPath(source, cwd);
      if (!filePath || !existsSync(filePath)) {
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

    return merged;
  }

  private getSettingsPath(source: SettingSource, cwd: string): string | null {
    switch (source) {
      case 'user': {
        const openAgentPath = join(homedir(), '.open-agent', 'settings.json');
        return existsSync(openAgentPath)
          ? openAgentPath
          : join(homedir(), '.claude', 'settings.json');
      }
      case 'project': {
        const openAgentPath = join(cwd, '.open-agent', 'settings.json');
        return existsSync(openAgentPath)
          ? openAgentPath
          : join(cwd, '.claude', 'settings.json');
      }
      case 'local': {
        const openAgentPath = join(cwd, '.open-agent', 'settings.local.json');
        return existsSync(openAgentPath)
          ? openAgentPath
          : join(cwd, '.claude', 'settings.local.json');
      }
      default:
        return null;
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
