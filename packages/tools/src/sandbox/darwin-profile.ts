/**
 * Options for building a macOS sandbox-exec profile.
 * See Apple's sandbox(7) man page or /System/Library/Sandbox/Profiles/ for the SBPL syntax.
 */
export interface DarwinSandboxOptions {
  /** Allow filesystem reads (almost always true — blocking reads breaks most tools). */
  allowFileRead?: boolean;
  /** Writable filesystem paths (absolute, realpath-normalized). Everything else is read-only. */
  writablePaths?: string[];
  /** Deny filesystem reads under these paths (e.g., ~/.ssh, ~/.aws). */
  deniedReadPaths?: string[];
  /** Block all outbound network. Default false. */
  blockNetwork?: boolean;
  /** Allow Unix domain sockets (needed for things like Docker socket). Default true. */
  allowUnixSockets?: boolean;
  /** Allow process spawn/fork. Default true (most tools need to fork). */
  allowProcessExec?: boolean;
  /** Allow writing to /tmp. Default true. */
  allowTmpWrite?: boolean;
}

/**
 * Build a sandbox-exec profile string (SBPL s-expressions).
 * Returns a string suitable for writing to a .sb file and passing to `sandbox-exec -f <file>`.
 */
export function buildDarwinSandboxProfile(options: DarwinSandboxOptions = {}): string {
  const {
    allowFileRead = true,
    writablePaths = [],
    deniedReadPaths = [],
    blockNetwork = false,
    allowUnixSockets = true,
    allowProcessExec = true,
    allowTmpWrite = true,
  } = options;

  const lines: string[] = ['(version 1)', '(deny default)'];

  // File reads
  if (allowFileRead) {
    lines.push('(allow file-read*)');
    for (const denied of deniedReadPaths) {
      lines.push(`(deny file-read* (subpath ${quoteSbplString(denied)}))`);
    }
  }

  // File writes
  lines.push('(deny file-write*)'); // default deny writes
  if (allowTmpWrite) {
    lines.push('(allow file-write* (subpath "/tmp"))');
    lines.push('(allow file-write* (subpath "/private/tmp"))');
    lines.push('(allow file-write* (subpath "/var/folders"))');
    lines.push('(allow file-write* (subpath "/private/var/folders"))');
  }
  for (const w of writablePaths) {
    lines.push(`(allow file-write* (subpath ${quoteSbplString(w)}))`);
  }

  // Process exec
  if (allowProcessExec) {
    lines.push('(allow process-exec*)');
    lines.push('(allow process-fork)');
    lines.push('(allow signal (target self))');
  } else {
    lines.push('(deny process-exec*)');
    lines.push('(deny process-fork)');
  }

  // Network
  if (blockNetwork) {
    lines.push('(deny network*)');
    if (allowUnixSockets) {
      lines.push('(allow network* (remote unix-socket))');
      lines.push('(allow network-inbound (local unix-socket))');
    }
  } else {
    lines.push('(allow network*)');
  }

  // Mach + sysctl — needed for most basic operations
  lines.push('(allow mach-lookup)');
  lines.push('(allow sysctl-read)');
  lines.push('(allow ipc-posix-shm*)');

  return lines.join('\n') + '\n';
}

/** Quote a string for SBPL. Wraps in double quotes and escapes backslashes + quotes. */
function quoteSbplString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Check if the current platform supports sandbox-exec. */
export function isDarwinSandboxAvailable(): boolean {
  return process.platform === 'darwin';
}
