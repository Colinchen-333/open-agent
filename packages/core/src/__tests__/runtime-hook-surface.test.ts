import { describe, expect, it } from 'bun:test';
import { buildRuntimeHookSurfaceSummary } from '../runtime-hook-surface.js';

describe('buildRuntimeHookSurfaceSummary', () => {
  it('merges plugin, settings, and session hook sources into one runtime surface', () => {
    const summary = buildRuntimeHookSurfaceSummary(
      [{
        event: 'PreToolUse',
        count: 1,
        sources: ['plugin:review-kit'],
      }],
      {
        source: 'settings_json',
        config: {
          Notification: [{ command: 'echo notify' }],
          PreToolUse: [{ command: 'echo local' }],
        },
      },
      {
        source: 'query_options',
        config: {
          Notification: [{ command: 'echo prompt' }],
        },
      },
    );

    expect(summary).toEqual([
      {
        event: 'Notification',
        count: 2,
        sources: ['query_options', 'settings_json'],
      },
      {
        event: 'PreToolUse',
        count: 2,
        sources: ['plugin:review-kit', 'settings_json'],
      },
    ]);
  });
});
