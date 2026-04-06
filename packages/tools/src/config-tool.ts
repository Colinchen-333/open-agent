import type { ToolDefinition, ToolContext } from './types.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { withToolDefaults } from './tool-defaults.js';

export function createConfigTool(): ToolDefinition {
  return withToolDefaults({
    name: 'Config',
    description: 'Get, set, or list OpenAgent configuration settings. Supports runtime settings (model, permissionMode, verbose, briefMode) via app state as well as persistent file-backed settings.',
    inputSchema: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: ['get', 'set', 'list'],
          description: 'Operation to perform: get a value, set a value, or list all settings',
        },
        setting: { type: 'string', description: 'Setting key (e.g. "model", "permissionMode"). Required for get/set.' },
        value: { description: 'New value (required for set operation)' },
      },
      required: ['operation'],
    },
    getActivityDescription(input: unknown) {
      const op = (input as any)?.operation ?? 'config';
      const key = (input as any)?.setting;
      if (op === 'list') return 'Listing configuration settings';
      if (op === 'set' && key) return `Setting config: ${key}`;
      if (op === 'get' && key) return `Getting config: ${key}`;
      return 'Accessing configuration';
    },
    async execute(input: any, ctx: ToolContext) {
      const settingsPath = join(homedir(), '.open-agent', 'settings.json');

      let settings: Record<string, unknown> = {};
      if (existsSync(settingsPath)) {
        try {
          settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
        } catch {
          // ignore parse errors; start with empty settings
        }
      }

      if (input.operation === 'list') {
        // Merge file-backed settings with runtime app state (app state takes precedence for display)
        const appState = ctx.getAppState?.() ?? {};
        const merged: Record<string, unknown> = {
          ...settings,
          ...(appState.model !== undefined ? { model: appState.model } : {}),
          ...(appState.permissionMode !== undefined ? { permissionMode: appState.permissionMode } : {}),
          ...(appState.verbose !== undefined ? { verbose: appState.verbose } : {}),
          ...(appState.briefMode !== undefined ? { briefMode: appState.briefMode } : {}),
        };
        return {
          success: true,
          operation: 'list',
          settings: merged,
        };
      }

      if (input.operation === 'get') {
        if (!input.setting) {
          return { success: false, error: 'setting key is required for get operation' };
        }
        // Check app state first for runtime-settable keys
        const appState = ctx.getAppState?.() ?? {};
        const runtimeKeys = new Set(['model', 'permissionMode', 'verbose', 'briefMode']);
        const value = runtimeKeys.has(input.setting) && appState[input.setting] !== undefined
          ? appState[input.setting]
          : settings[input.setting];
        return {
          success: true,
          operation: 'get',
          setting: input.setting,
          value,
        };
      }

      if (input.operation === 'set') {
        if (!input.setting) {
          return { success: false, error: 'setting key is required for set operation' };
        }
        // For runtime-aware keys, also update app state if available
        const runtimeKeys = new Set(['model', 'permissionMode', 'verbose', 'briefMode']);
        if (runtimeKeys.has(input.setting) && ctx.setAppState) {
          ctx.setAppState((prev: any) => ({ ...prev, [input.setting]: input.value }));
        }
        const previousValue = settings[input.setting];
        settings[input.setting] = input.value;
        mkdirSync(join(homedir(), '.open-agent'), { recursive: true });
        writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
        return {
          success: true,
          operation: 'set',
          setting: input.setting,
          previousValue,
          newValue: input.value,
        };
      }

      return { success: false, error: 'Unknown operation. Use get, set, or list.' };
    },
  });
}
