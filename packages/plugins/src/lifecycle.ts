/**
 * Plugin lifecycle management — install, activate, deactivate, uninstall.
 * Matches Claude Code's plugin bundling/loading/validation pattern.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';

export interface PluginManifest {
  name: string;
  version: string;
  description?: string;
  author?: string;
  /** Entry point relative to plugin root */
  main?: string;
  /** Plugin capabilities */
  capabilities?: {
    tools?: boolean;
    commands?: boolean;
    hooks?: boolean;
    mcpServers?: boolean;
    agents?: boolean;
  };
  /** Required OpenAgent version range */
  engineVersion?: string;
  /** Dependencies on other plugins */
  dependencies?: Record<string, string>;
}

export type PluginState = 'installed' | 'active' | 'inactive' | 'error' | 'incompatible';

export interface PluginRecord {
  manifest: PluginManifest;
  state: PluginState;
  path: string;
  installedAt: string;
  activatedAt?: string;
  error?: string;
}

export interface PluginValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

const PLUGINS_DIR = join(homedir(), '.claude', 'plugins');
const REGISTRY_FILE = join(PLUGINS_DIR, 'registry.json');

/** Ensure the plugins directory exists. */
function ensurePluginsDir(): void {
  mkdirSync(PLUGINS_DIR, { recursive: true });
}

/** Load the plugin registry from disk. */
export function loadRegistry(): PluginRecord[] {
  try {
    const data = readFileSync(REGISTRY_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return [];
  }
}

/** Save the plugin registry to disk. */
export function saveRegistry(records: PluginRecord[]): void {
  ensurePluginsDir();
  writeFileSync(REGISTRY_FILE, JSON.stringify(records, null, 2), 'utf-8');
}

/** Validate a plugin manifest. */
export function validateManifest(manifest: unknown): PluginValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!manifest || typeof manifest !== 'object') {
    return { valid: false, errors: ['manifest must be an object'], warnings };
  }

  const m = manifest as Record<string, unknown>;

  if (!m.name || typeof m.name !== 'string') errors.push('name is required and must be a string');
  if (!m.version || typeof m.version !== 'string') errors.push('version is required and must be a string');
  if (m.name && typeof m.name === 'string' && !/^[a-z0-9-]+$/.test(m.name)) {
    errors.push('name must be lowercase alphanumeric with hyphens');
  }
  if (m.main && typeof m.main !== 'string') errors.push('main must be a string');
  if (m.description && typeof m.description !== 'string') warnings.push('description should be a string');
  if (m.author && typeof m.author !== 'string') warnings.push('author should be a string');

  return { valid: errors.length === 0, errors, warnings };
}

/** Install a plugin from a directory path. */
export function installPlugin(pluginPath: string): PluginRecord {
  const manifestPath = join(pluginPath, 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error(`No manifest.json found at ${pluginPath}`);
  }

  const raw = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  const validation = validateManifest(raw);
  if (!validation.valid) {
    throw new Error(`Invalid manifest: ${validation.errors.join(', ')}`);
  }

  const manifest = raw as PluginManifest;
  const records = loadRegistry();

  // Check for duplicate
  const existing = records.findIndex(r => r.manifest.name === manifest.name);
  const record: PluginRecord = {
    manifest,
    state: 'installed',
    path: pluginPath,
    installedAt: new Date().toISOString(),
  };

  if (existing >= 0) {
    records[existing] = record;
  } else {
    records.push(record);
  }

  saveRegistry(records);
  return record;
}

/** Activate a plugin by name. */
export function activatePlugin(name: string): boolean {
  const records = loadRegistry();
  const record = records.find(r => r.manifest.name === name);
  if (!record) return false;
  if (record.state === 'active') return true;

  record.state = 'active';
  record.activatedAt = new Date().toISOString();
  record.error = undefined;
  saveRegistry(records);
  return true;
}

/** Deactivate a plugin by name. */
export function deactivatePlugin(name: string): boolean {
  const records = loadRegistry();
  const record = records.find(r => r.manifest.name === name);
  if (!record) return false;

  record.state = 'inactive';
  saveRegistry(records);
  return true;
}

/** Uninstall a plugin by name. */
export function uninstallPlugin(name: string): boolean {
  const records = loadRegistry();
  const idx = records.findIndex(r => r.manifest.name === name);
  if (idx < 0) return false;

  records.splice(idx, 1);
  saveRegistry(records);
  return true;
}

/** Get all active plugins. */
export function getActivePlugins(): PluginRecord[] {
  return loadRegistry().filter(r => r.state === 'active');
}

/** Get plugin by name. */
export function getPlugin(name: string): PluginRecord | null {
  return loadRegistry().find(r => r.manifest.name === name) ?? null;
}

/** Discover plugins from the standard directories. */
export function discoverPlugins(): string[] {
  const dirs = [
    join(homedir(), '.claude', 'plugins'),
    join(process.cwd(), '.open-agent', 'plugins'),
  ];

  const found: string[] = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    try {
      const entries = require('fs').readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const manifestPath = join(dir, entry.name, 'manifest.json');
          if (existsSync(manifestPath)) {
            found.push(join(dir, entry.name));
          }
        }
      }
    } catch {}
  }
  return found;
}
