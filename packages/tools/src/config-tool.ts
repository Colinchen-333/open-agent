import type { ToolDefinition, ToolContext } from './types.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export function createConfigTool(): ToolDefinition {
  return {
    name: 'Config',
    description: 'Get or set configuration values.',
    inputSchema: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: ['get', 'set'],
          description: 'Operation to perform',
        },
        setting: { type: 'string', description: 'Setting name' },
        value: { description: 'Value to set (for set operation)' },
      },
      required: ['operation', 'setting'],
    },
    async execute(input: any, _ctx: ToolContext) {
      const settingsPath = join(homedir(), '.open-agent', 'settings.json');

      let settings: Record<string, unknown> = {};
      if (existsSync(settingsPath)) {
        try {
          settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
        } catch {
          // ignore parse errors; start with empty settings
        }
      }

      if (input.operation === 'get') {
        return {
          success: true,
          operation: 'get',
          setting: input.setting,
          value: settings[input.setting],
        };
      }

      if (input.operation === 'set') {
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

      return { success: false, error: 'Unknown operation' };
    },
  };
}
