import { existsSync, watch, type FSWatcher } from 'fs';
import { basename, dirname } from 'path';
import type { SettingSource } from '@open-agent/core';
import { SettingsLoader } from './settings-loader.js';

export type SettingsChangeSource = SettingSource | 'watch' | 'manual' | 'policy';

export interface SettingsChangeSubscription {
  close(): void;
}

export interface SettingsChangeDetectorOptions {
  debounceMs?: number;
}

export class SettingsChangeDetector {
  private readonly loader: SettingsLoader;
  private readonly debounceMs: number;
  private readonly listeners = new Set<(source: SettingsChangeSource) => void>();

  constructor(
    loader = new SettingsLoader(),
    options: SettingsChangeDetectorOptions = {},
  ) {
    this.loader = loader;
    this.debounceMs = options.debounceMs ?? 75;
  }

  subscribe(listener: (source: SettingsChangeSource) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  notifyChange(source: SettingsChangeSource): void {
    for (const listener of this.listeners) {
      listener(source);
    }
  }

  watch(
    cwd: string,
    sources: SettingSource[],
  ): SettingsChangeSubscription {
    const candidatePaths = this.loader.getCandidatePaths(cwd, sources);
    const targetFiles = new Set(candidatePaths.map((filePath) => basename(filePath)));
    const watchDirs = [...new Set(candidatePaths.map((filePath) => dirname(filePath)))]
      .filter((dirPath) => existsSync(dirPath));
    const watchers: FSWatcher[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    const schedule = () => {
      if (closed) return;
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        timer = null;
        if (!closed) {
          this.notifyChange('watch');
        }
      }, this.debounceMs);
    };

    for (const dirPath of watchDirs) {
      try {
        const watcher = watch(dirPath, (_eventType, filename) => {
          if (!filename) {
            schedule();
            return;
          }
          const normalized = String(filename);
          if (targetFiles.has(normalized)) {
            schedule();
          }
        });
        watchers.push(watcher);
      } catch {
        // Ignore directories that cannot be watched on this platform.
      }
    }

    return {
      close() {
        if (closed) return;
        closed = true;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        for (const watcher of watchers) {
          watcher.close();
        }
      },
    };
  }
}
