import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createConfigTool } from '../config-tool.js';
import type { ToolContext } from '../types.js';

// Use a unique settings path override for isolation — we monkey-patch homedir
// indirectly by writing to the real path and cleaning up after each test.
const SETTINGS_DIR = join(homedir(), '.open-agent');
const SETTINGS_PATH = join(SETTINGS_DIR, 'settings.json');

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    cwd: '/tmp',
    sessionId: 'config-tool-test',
    ...overrides,
  };
}

function writeSettings(data: Record<string, unknown>) {
  mkdirSync(SETTINGS_DIR, { recursive: true });
  writeFileSync(SETTINGS_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

beforeEach(() => {
  // Ensure a clean slate before each test
  if (existsSync(SETTINGS_PATH)) {
    rmSync(SETTINGS_PATH);
  }
});

afterEach(() => {
  // Clean up any settings written during tests
  if (existsSync(SETTINGS_PATH)) {
    rmSync(SETTINGS_PATH);
  }
});

// ---------------------------------------------------------------------------
// list action
// ---------------------------------------------------------------------------

describe('ConfigTool – list', () => {
  test('list returns empty settings when no file exists', async () => {
    const tool = createConfigTool();
    const result = await tool.execute({ operation: 'list' }, makeCtx());
    expect(result.success).toBe(true);
    expect(result.operation).toBe('list');
    expect(result.settings).toBeDefined();
    expect(typeof result.settings).toBe('object');
  });

  test('list returns file-backed settings', async () => {
    writeSettings({ model: 'claude-3-opus', verbose: false });
    const tool = createConfigTool();
    const result = await tool.execute({ operation: 'list' }, makeCtx());
    expect(result.success).toBe(true);
    expect(result.settings.model).toBe('claude-3-opus');
    expect(result.settings.verbose).toBe(false);
  });

  test('list merges app state runtime keys over file settings', async () => {
    writeSettings({ model: 'old-model', permissionMode: 'default' });
    const appState = { model: 'glm-4.7', permissionMode: 'strict', verbose: true };
    const tool = createConfigTool();
    const result = await tool.execute(
      { operation: 'list' },
      makeCtx({ getAppState: () => appState }),
    );
    expect(result.success).toBe(true);
    // App state wins for runtime keys
    expect(result.settings.model).toBe('glm-4.7');
    expect(result.settings.permissionMode).toBe('strict');
    expect(result.settings.verbose).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// get action
// ---------------------------------------------------------------------------

describe('ConfigTool – get', () => {
  test('get returns value from file settings', async () => {
    writeSettings({ theme: 'dark' });
    const tool = createConfigTool();
    const result = await tool.execute({ operation: 'get', setting: 'theme' }, makeCtx());
    expect(result.success).toBe(true);
    expect(result.setting).toBe('theme');
    expect(result.value).toBe('dark');
  });

  test('get returns undefined for missing key', async () => {
    const tool = createConfigTool();
    const result = await tool.execute({ operation: 'get', setting: 'nonexistent' }, makeCtx());
    expect(result.success).toBe(true);
    expect(result.value).toBeUndefined();
  });

  test('get prefers app state for runtime keys', async () => {
    writeSettings({ model: 'file-model' });
    const tool = createConfigTool();
    const result = await tool.execute(
      { operation: 'get', setting: 'model' },
      makeCtx({ getAppState: () => ({ model: 'runtime-model' }) }),
    );
    expect(result.success).toBe(true);
    expect(result.value).toBe('runtime-model');
  });

  test('get returns error when setting key is missing', async () => {
    const tool = createConfigTool();
    const result = await tool.execute({ operation: 'get' }, makeCtx());
    expect(result.success).toBe(false);
    expect(result.error).toContain('setting key is required');
  });
});

// ---------------------------------------------------------------------------
// set action
// ---------------------------------------------------------------------------

describe('ConfigTool – set', () => {
  test('set writes value to file and returns newValue', async () => {
    const tool = createConfigTool();
    const result = await tool.execute(
      { operation: 'set', setting: 'theme', value: 'light' },
      makeCtx(),
    );
    expect(result.success).toBe(true);
    expect(result.operation).toBe('set');
    expect(result.setting).toBe('theme');
    expect(result.newValue).toBe('light');
    expect(result.previousValue).toBeUndefined();
  });

  test('set reports previous value on overwrite', async () => {
    writeSettings({ theme: 'dark' });
    const tool = createConfigTool();
    const result = await tool.execute(
      { operation: 'set', setting: 'theme', value: 'light' },
      makeCtx(),
    );
    expect(result.success).toBe(true);
    expect(result.previousValue).toBe('dark');
    expect(result.newValue).toBe('light');
  });

  test('set also updates app state for runtime keys', async () => {
    const captured: any[] = [];
    const tool = createConfigTool();
    const result = await tool.execute(
      { operation: 'set', setting: 'model', value: 'gpt-5' },
      makeCtx({
        getAppState: () => ({}),
        setAppState: (updater) => captured.push(updater({})),
      }),
    );
    expect(result.success).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0].model).toBe('gpt-5');
  });

  test('set returns error when setting key is missing', async () => {
    const tool = createConfigTool();
    const result = await tool.execute({ operation: 'set', value: 'x' }, makeCtx());
    expect(result.success).toBe(false);
    expect(result.error).toContain('setting key is required');
  });
});

// ---------------------------------------------------------------------------
// Unknown operation
// ---------------------------------------------------------------------------

describe('ConfigTool – unknown operation', () => {
  test('returns error for unrecognized operation', async () => {
    const tool = createConfigTool();
    const result = await tool.execute({ operation: 'delete' }, makeCtx());
    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown operation');
  });
});

// ---------------------------------------------------------------------------
// getActivityDescription
// ---------------------------------------------------------------------------

describe('ConfigTool – getActivityDescription', () => {
  test('list returns listing label', () => {
    const tool = createConfigTool();
    expect(tool.getActivityDescription?.({ operation: 'list' })).toBe('Listing configuration settings');
  });

  test('get returns getting label with key', () => {
    const tool = createConfigTool();
    expect(tool.getActivityDescription?.({ operation: 'get', setting: 'model' })).toBe('Getting config: model');
  });

  test('set returns setting label with key', () => {
    const tool = createConfigTool();
    expect(tool.getActivityDescription?.({ operation: 'set', setting: 'verbose' })).toBe('Setting config: verbose');
  });

  test('unknown operation falls back gracefully', () => {
    const tool = createConfigTool();
    expect(tool.getActivityDescription?.({ operation: 'unknown' })).toBe('Accessing configuration');
  });
});
