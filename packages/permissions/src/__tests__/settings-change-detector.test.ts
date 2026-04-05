import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SettingsChangeDetector } from '../settings-change-detector.js';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('SettingsChangeDetector', () => {
  it('broadcasts manual notifications through the shared settings bus', () => {
    const detector = new SettingsChangeDetector();
    const seen: string[] = [];
    const unsubscribe = detector.subscribe((source) => {
      seen.push(source);
    });

    detector.notifyChange('manual');
    detector.notifyChange('policy');
    unsubscribe();
    detector.notifyChange('watch');

    expect(seen).toEqual(['manual', 'policy']);
  });

  it('emits watch notifications when a tracked settings file changes', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'open-agent-settings-detector-'));
    tempDirs.push(cwd);
    const settingsDir = join(cwd, '.open-agent');
    mkdirSync(settingsDir, { recursive: true });
    const settingsPath = join(settingsDir, 'settings.json');
    writeFileSync(settingsPath, JSON.stringify({ permissions: { allow: [{ toolName: 'Read' }] } }), 'utf-8');

    const detector = new SettingsChangeDetector(undefined, { debounceMs: 10 });
    let resolveSeen: (() => void) | null = null;
    const seen = new Promise<void>((resolve) => {
      resolveSeen = resolve;
    });
    const unsubscribe = detector.subscribe((source) => {
      if (source === 'watch') {
        resolveSeen?.();
        resolveSeen = null;
      }
    });
    const subscription = detector.watch(cwd, ['project']);

    writeFileSync(settingsPath, JSON.stringify({ permissions: { allow: [{ toolName: 'Write' }] } }), 'utf-8');

    await Promise.race([
      seen,
      new Promise((_, reject) => setTimeout(() => reject(new Error('timed out waiting for settings watch event')), 2_000)),
    ]);

    subscription.close();
    unsubscribe();
  });
});
