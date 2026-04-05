import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const HOME_LOCK_DIR = join(tmpdir(), 'open-agent-sdk-test-home.lock');
const HOME_LOCK_OWNER_PATH = join(HOME_LOCK_DIR, 'owner.json');
const HOME_LOCK_WAIT = new Int32Array(new SharedArrayBuffer(4));
const HOME_LOCK_STALE_MS = 30_000;

function sleepSync(ms: number): void {
  Atomics.wait(HOME_LOCK_WAIT, 0, 0, ms);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function shouldReapHomeLock(): boolean {
  try {
    const raw = readFileSync(HOME_LOCK_OWNER_PATH, 'utf8');
    const owner = JSON.parse(raw) as { pid?: number; createdAt?: number };
    const createdAt = typeof owner.createdAt === 'number' ? owner.createdAt : 0;
    const pid = typeof owner.pid === 'number' ? owner.pid : null;
    if (!pid) {
      return true;
    }
    if (!isProcessAlive(pid)) {
      return true;
    }
    return Date.now() - createdAt > HOME_LOCK_STALE_MS;
  } catch {
    return true;
  }
}

function acquireHomeLock(): { release: () => void; reentrant: boolean } {
  while (true) {
    try {
      mkdirSync(HOME_LOCK_DIR);
      writeFileSync(
        HOME_LOCK_OWNER_PATH,
        JSON.stringify({ pid: process.pid, createdAt: Date.now() }),
      );
      return {
        reentrant: false,
        release: () => {
          rmSync(HOME_LOCK_DIR, { recursive: true, force: true });
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
      try {
        const raw = readFileSync(HOME_LOCK_OWNER_PATH, 'utf8');
        const owner = JSON.parse(raw) as { pid?: number };
        if (owner.pid === process.pid) {
          return {
            reentrant: true,
            release: () => {},
          };
        }
      } catch {
        // Fall through to stale lock recovery / wait.
      }
      if (shouldReapHomeLock()) {
        rmSync(HOME_LOCK_DIR, { recursive: true, force: true });
        continue;
      }
      sleepSync(10);
    }
  }
}

export function makeLockedTempHome(prefix: string): { cwd: string; cleanup(): void } {
  const { release, reentrant } = acquireHomeLock();
  const cwd = mkdtempSync(join(tmpdir(), prefix));
  const home = join(cwd, 'home');
  mkdirSync(home, { recursive: true });
  const originalHome = process.env.HOME;
  if (!reentrant) {
    process.env.HOME = home;
  }

  return {
    cwd,
    cleanup() {
      if (!reentrant) {
        if (originalHome === undefined) {
          delete process.env.HOME;
        } else {
          process.env.HOME = originalHome;
        }
      }
      rmSync(cwd, { recursive: true, force: true });
      release();
    },
  };
}
