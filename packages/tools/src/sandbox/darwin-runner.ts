export * from './darwin-profile';

import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDarwinSandboxProfile, isDarwinSandboxAvailable, type DarwinSandboxOptions } from './darwin-profile';

/**
 * Detect macOS sandbox-exec violation messages in a process's stderr output.
 *
 * sandbox-exec prints violations in two forms:
 *   "deny file-write-data /path/to/file"
 *   "Sandbox: bash(1234) deny(1) file-write-data /path"
 * It may also surface as a generic "Operation not permitted" when the kernel
 * intercepts the syscall before the user-space message is emitted.
 *
 * Returns the first matching substring, or null if stderr looks clean.
 */
export function detectDarwinSandboxViolation(stderr: string): string | null {
  const patterns = [
    /deny\s+(file-write|file-read|network|process)/i,
    /Sandbox:.*deny/i,
    /Operation not permitted/i,
  ];
  for (const p of patterns) {
    const match = stderr.match(p);
    if (match) return match[0];
  }
  return null;
}

export interface DarwinSandboxRunResult {
  /** The resolved argv that would be passed to the child process (sandbox-exec -f <file> <cmd...>). */
  argv: string[];
  /** Path to the temp .sb file holding the profile. Caller must clean it up when done. */
  profilePath: string;
  /** The profile text (for debugging / logging). */
  profile: string;
  /** Cleanup: delete the temp profile directory. */
  cleanup(): Promise<void>;
}

/**
 * Build a sandbox-exec command wrapper. Returns the argv to execute, plus
 * a cleanup function to remove the temp profile file afterwards.
 *
 * Throws on non-darwin platforms. Callers should check `isDarwinSandboxAvailable()`
 * and fall back to the unsandboxed path when not supported.
 */
export async function wrapWithDarwinSandbox(
  command: string[],
  options: DarwinSandboxOptions = {},
): Promise<DarwinSandboxRunResult> {
  if (!isDarwinSandboxAvailable()) {
    throw new Error('Darwin sandbox is only available on macOS');
  }
  if (command.length === 0) {
    throw new Error('wrapWithDarwinSandbox requires a non-empty command');
  }
  const profile = buildDarwinSandboxProfile(options);
  const dir = await mkdtemp(join(tmpdir(), 'oa-darwin-sandbox-'));
  const profilePath = join(dir, 'profile.sb');
  await writeFile(profilePath, profile, 'utf8');

  return {
    argv: ['sandbox-exec', '-f', profilePath, ...command],
    profilePath,
    profile,
    cleanup: async () => {
      try {
        await rm(dir, { recursive: true, force: true });
      } catch { /* best-effort */ }
    },
  };
}
