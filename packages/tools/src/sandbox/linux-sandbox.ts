/**
 * Linux sandbox using bubblewrap (bwrap) for filesystem and network isolation.
 * Matches Claude Code's sandbox-adapter.ts Linux code path.
 */

export interface LinuxSandboxConfig {
  /** Paths allowed for reading (bind-mounted read-only) */
  allowRead?: string[];
  /** Paths allowed for writing (bind-mounted read-write) */
  allowWrite?: string[];
  /** Paths denied for reading (not mounted) */
  denyRead?: string[];
  /** Working directory inside the sandbox */
  cwd: string;
  /** Allow network access (default: false → unshare network namespace) */
  allowNetwork?: boolean;
  /** Domain-level network filtering configuration */
  networkConfig?: SandboxNetworkConfig;
  /** Additional environment variables to pass through */
  env?: Record<string, string>;
  /** Timeout in seconds for the command */
  timeout?: number;
  /** Allow Unix sockets */
  allowUnixSockets?: string[];
}

/**
 * Check if bubblewrap (bwrap) is available on the system.
 */
export async function isBwrapAvailable(): Promise<boolean> {
  try {
    const proc = Bun.spawn(['which', 'bwrap'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const code = await proc.exited;
    return code === 0;
  } catch {
    return false;
  }
}

/**
 * Default read-only bind mounts for a functional sandbox.
 */
const DEFAULT_READONLY_BINDS = [
  '/usr',
  '/bin',
  '/sbin',
  '/lib',
  '/lib64',
  '/etc',
  '/opt',
];

/**
 * Default writable paths (used by future sandbox exec integration).
 */
export const DEFAULT_WRITABLE_PATHS = [
  '/tmp',
  '/dev/null',
  '/dev/zero',
  '/dev/urandom',
  '/dev/random',
];

/**
 * Build a bwrap command line that sandboxes the given command.
 *
 * @param command The shell command to execute inside the sandbox
 * @param config Sandbox configuration
 * @returns Array of arguments for Bun.spawn / child_process.spawn
 */
export function buildBwrapCommand(
  command: string,
  config: LinuxSandboxConfig,
): string[] {
  const args: string[] = ['bwrap'];

  // Unshare namespaces for isolation
  args.push('--unshare-pid');
  args.push('--unshare-uts');
  args.push('--unshare-ipc');

  if (!config.allowNetwork) {
    args.push('--unshare-net');
  }

  // New /proc for PID namespace
  args.push('--proc', '/proc');

  // Tmpfs at /tmp
  args.push('--tmpfs', '/tmp');

  // Devtmpfs for basic device nodes
  args.push('--dev', '/dev');

  // Default read-only bind mounts (skip missing paths)
  for (const path of DEFAULT_READONLY_BINDS) {
    args.push('--ro-bind-try', path, path);
  }

  // User-specified read-only paths
  if (config.allowRead) {
    for (const path of config.allowRead) {
      if (config.denyRead?.includes(path)) continue;
      args.push('--ro-bind-try', path, path);
    }
  }

  // Working directory — must be writable
  args.push('--bind', config.cwd, config.cwd);
  args.push('--chdir', config.cwd);

  // User-specified writable paths
  if (config.allowWrite) {
    for (const path of config.allowWrite) {
      if (path === config.cwd) continue; // already bound
      args.push('--bind', path, path);
    }
  }

  // Home directory (read-only by default for dotfiles)
  const home = process.env.HOME;
  if (home) {
    args.push('--ro-bind-try', home, home);
    args.push('--setenv', 'HOME', home);
  }

  // Pass through environment variables
  if (config.env) {
    for (const [key, value] of Object.entries(config.env)) {
      args.push('--setenv', key, value);
    }
  }

  // Essential env vars
  args.push(
    '--setenv',
    'PATH',
    process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin',
  );
  if (process.env.TERM) {
    args.push('--setenv', 'TERM', process.env.TERM);
  }

  // Domain-level network filter env vars (consumed by in-sandbox proxy/DNS)
  if (config.networkConfig) {
    const filterEnv = buildNetworkFilterEnv(config.networkConfig);
    for (const [key, value] of Object.entries(filterEnv)) {
      args.push('--setenv', key, value);
    }
  }

  // Die with parent — clean up if the parent process exits
  args.push('--die-with-parent');

  // The actual command, executed via /bin/sh -c
  args.push('--', '/bin/sh', '-c', command);

  return args;
}

/**
 * Sandbox config schema types matching Claude Code's sandboxTypes.ts
 */
export interface SandboxNetworkConfig {
  allowedDomains?: string[];
  deniedDomains?: string[];
  allowUnixSockets?: string[];
  allowAllUnixSockets?: boolean;
  allowLocalBinding?: boolean;
}

export interface SandboxFilesystemConfig {
  allowWrite?: string[];
  denyWrite?: string[];
  denyRead?: string[];
  allowRead?: string[];
}

export interface SandboxConfig {
  enabled?: boolean;
  network?: SandboxNetworkConfig;
  filesystem?: SandboxFilesystemConfig;
}

/**
 * Generate environment variables for domain-based network filtering.
 * Since bwrap operates at namespace level (not domain level), we set
 * env vars that a proxy or DNS filter inside the sandbox can consume.
 *
 * Returns key-value pairs to add via --setenv in the bwrap command.
 */
export function buildNetworkFilterEnv(config: SandboxNetworkConfig): Record<string, string> {
  const env: Record<string, string> = {};
  if (config.allowedDomains?.length) {
    env['SANDBOX_ALLOWED_DOMAINS'] = config.allowedDomains.join(',');
  }
  if (config.deniedDomains?.length) {
    env['SANDBOX_DENIED_DOMAINS'] = config.deniedDomains.join(',');
  }
  if (config.allowLocalBinding) {
    env['SANDBOX_ALLOW_LOCAL_BINDING'] = '1';
  }
  if (config.allowAllUnixSockets) {
    env['SANDBOX_ALLOW_ALL_UNIX_SOCKETS'] = '1';
  } else if (config.allowUnixSockets?.length) {
    env['SANDBOX_ALLOWED_UNIX_SOCKETS'] = config.allowUnixSockets.join(',');
  }
  return env;
}

/**
 * Convert a high-level SandboxConfig to a LinuxSandboxConfig for bwrap.
 */
export function sandboxConfigToLinux(
  config: SandboxConfig,
  cwd: string,
): LinuxSandboxConfig {
  const hasNetwork = config.network != null
    ? !!(
        config.network.allowedDomains?.length ||
        config.network.allowAllUnixSockets ||
        config.network.allowLocalBinding
      )
    : false;

  return {
    cwd,
    allowRead: config.filesystem?.allowRead,
    allowWrite: config.filesystem?.allowWrite,
    denyRead: config.filesystem?.denyRead,
    allowNetwork: hasNetwork,
    networkConfig: config.network,
    allowUnixSockets: config.network?.allowUnixSockets,
    env: {},
  };
}
